/**
 * readPaper — top-level reader orchestrator: skim → read → audit → harvest.
 *
 * Cache-aware: a `PaperRead` persisted at
 * `<workspace>/.mathran/paper-graph/reads/<id>.json` with a matching
 * `modelUsed` + `promptVersion` is returned unchanged (unless `forceReread`).
 * When the model or the prompt version changes, the read is recomputed
 * automatically (cache invalidation handled by `hasFreshPaperRead`).
 *
 * Never throws — partial failures are reflected in `passesCompleted` and the
 * absence of `read` / `audit`.
 *
 * NOTE FOR MERGE: this module statically imports W2-α's source loader and
 * W2-β's skim / read-regime functions plus the SKIM/READ prompt-version
 * constants. Until those workers are merged the imports are unresolved; the
 * orchestrator tests dynamically detect this and skip (deferred to post-merge).
 */

import type { PaperNode, PaperRead, PaperReadBody, PaperReadSkim } from "../../../paper-graph/types.js";
import type { SpineLLM } from "../spine/llm.js";
import { hasFreshPaperRead, getPaperRead, writePaperRead } from "../../../paper-graph/reads.js";

import { loadPaperSource, pickReadingRegime, type LoadedSource } from "./source-loader.js";
import { skimPaper } from "./skim.js";
import { readPaperRegimeA } from "./read-regime-a.js";
import { readPaperRegimeB } from "./read-regime-b.js";
import { readPaperRegimeC } from "./read-regime-c.js";
import { auditPaper } from "./audit.js";
import { harvestCitations } from "./citation-harvest.js";
import { SKIM_PROMPT_VERSION, READ_PROMPT_VERSION, AUDIT_PROMPT_VERSION } from "./prompts.js";

export const DEFAULT_READER_PROMPT_VERSION = `${SKIM_PROMPT_VERSION}+${READ_PROMPT_VERSION}+${AUDIT_PROMPT_VERSION}`;

export interface ReadPaperCtx {
  workspace: string;
  problemTitle: string;
  llm: SpineLLM;
  /** e.g. "anthropic/claude-sonnet-4". */
  modelName: string;
  /** Overall reader-pipeline version; defaults to the per-pass versions joined. */
  promptVersion?: string;
  /** Bypass the cache and re-read even on a fresh hit. */
  forceReread?: boolean;
  emitLog?: (message: string) => void;
  fetchArxivSource?: typeof import("../../../paper-graph/arxiv-source.js").fetchArxivSource;
  runPdfToText?: (pdfPath: string) => Promise<string | null>;
  rateDelayMs?: number;
}

function isStudyRegime(source: LoadedSource): "A" | "B" | "C" {
  try {
    return pickReadingRegime(source);
  } catch {
    return "A";
  }
}

async function runRead(
  regime: "A" | "B" | "C",
  args: { paper: PaperNode; source: LoadedSource; skim: PaperReadSkim; problemTitle: string },
  deps: { llm: SpineLLM; emitLog?: (m: string) => void },
): Promise<{ body: PaperReadBody; llmCalls: number }> {
  // Regime B may issue N+1 calls (section-by-section); A and C issue 1.
  if (regime === "B") {
    const body = await readPaperRegimeB(args.paper, args.source, deps);
    const sectionCount = args.skim.sectionOutline?.length ?? 0;
    return { body, llmCalls: Math.max(1, sectionCount) + 1 };
  }
  if (regime === "C") {
    return { body: await readPaperRegimeC(args.paper, args.source, deps), llmCalls: 1 };
  }
  return { body: await readPaperRegimeA(args.paper, args.source, deps), llmCalls: 1 };
}

export async function readPaper(paper: PaperNode, ctx: ReadPaperCtx): Promise<PaperRead> {
  const {
    workspace,
    problemTitle,
    llm,
    modelName,
    forceReread = false,
    emitLog,
  } = ctx;
  const promptVersion = ctx.promptVersion ?? DEFAULT_READER_PROMPT_VERSION;
  const log = (m: string) => emitLog?.(m);

  // ── Cache check ────────────────────────────────────────────────────────────
  if (!forceReread) {
    try {
      if (await hasFreshPaperRead(workspace, paper.id, modelName, promptVersion)) {
        const cached = await getPaperRead(workspace, paper.id);
        if (cached) {
          log(`[read] cache hit for "${paper.title}" (${modelName} / ${promptVersion})`);
          return cached;
        }
      }
    } catch (err) {
      log(`[read] cache lookup failed (continuing): ${errText(err)}`);
    }
  }

  const now = new Date().toISOString();
  const passesCompleted: ("skim" | "read" | "audit")[] = [];
  let totalLlmCalls = 0;

  // ── 1. Load source ─────────────────────────────────────────────────────────
  let source: LoadedSource;
  try {
    source = await loadPaperSource(paper, {
      workspace,
      fetchArxivSource: ctx.fetchArxivSource,
      runPdfToText: ctx.runPdfToText,
    });
  } catch (err) {
    log(`[read] source load failed for "${paper.title}": ${errText(err)}`);
    return abstractOnlyFallback(paper, now, modelName, promptVersion);
  }

  // ── 2. Skim ────────────────────────────────────────────────────────────────
  let skim: PaperReadSkim;
  try {
    skim = await skimPaper(paper, source, { llm, emitLog });
    totalLlmCalls += 1;
    passesCompleted.push("skim");
  } catch (err) {
    log(`[read] skim failed for "${paper.title}": ${errText(err)}`);
    return assemble(paper, source, fallbackSkim(), undefined, undefined, [], {
      now,
      modelName,
      promptVersion,
      passesCompleted,
      totalLlmCalls,
    });
  }

  // ── 3. Discard short-circuit ───────────────────────────────────────────────
  if (skim.decision === "discard") {
    log(`[read] skim → discard for "${paper.title}": ${skim.decisionReason}`);
    const read = assemble(paper, source, skim, undefined, undefined, [], {
      now,
      modelName,
      promptVersion,
      passesCompleted,
      totalLlmCalls,
    });
    await persist(workspace, read, log);
    return read;
  }

  // ── 4. Read ────────────────────────────────────────────────────────────────
  let body: PaperReadBody | undefined;
  try {
    const regime = isStudyRegime(source);
    log(`[read] regime ${regime} for "${paper.title}"`);
    const res = await runRead(regime, { paper, source, skim, problemTitle }, { llm, emitLog });
    body = res.body;
    totalLlmCalls += res.llmCalls;
    passesCompleted.push("read");
  } catch (err) {
    log(`[read] read pass failed for "${paper.title}": ${errText(err)}`);
  }

  // ── 5. Audit (only if the read produced a body) ────────────────────────────
  let audit;
  if (body) {
    try {
      audit = await auditPaper(
        { paper, read: body, sourceKind: source.kind, problemTitle },
        { llm, emitLog },
      );
      totalLlmCalls += 1;
      passesCompleted.push("audit");
    } catch (err) {
      log(`[read] audit failed for "${paper.title}": ${errText(err)}`);
    }
  }

  // ── 6. Harvest citations (pure, no LLM) ────────────────────────────────────
  let outgoing = [] as PaperRead["outgoingCitations"];
  if (body) {
    try {
      outgoing = harvestCitations(paper, source, body, { emitLog });
    } catch (err) {
      log(`[read] citation harvest failed for "${paper.title}": ${errText(err)}`);
    }
  }

  // ── 7. Assemble + persist ──────────────────────────────────────────────────
  const read = assemble(paper, source, skim, body, audit, outgoing, {
    now,
    modelName,
    promptVersion,
    passesCompleted,
    totalLlmCalls,
  });
  await persist(workspace, read, log);
  return read;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AssembleMeta {
  now: string;
  modelName: string;
  promptVersion: string;
  passesCompleted: ("skim" | "read" | "audit")[];
  totalLlmCalls: number;
}

function assemble(
  paper: PaperNode,
  source: LoadedSource,
  skim: PaperReadSkim,
  body: PaperReadBody | undefined,
  audit: PaperRead["audit"],
  outgoing: PaperRead["outgoingCitations"],
  meta: AssembleMeta,
): PaperRead {
  const s = source as unknown as Record<string, unknown>;
  const sourceBytes = typeof s.bytes === "number" ? s.bytes : 0;
  const truncated = typeof s.truncated === "boolean" ? s.truncated : false;
  const sourcePath = typeof s.sourcePath === "string" ? s.sourcePath : undefined;

  return {
    paperId: paper.id,
    arxivId: paper.arxivId,
    doi: paper.doi,
    sourceKind: source.kind,
    sourceBytes,
    sourcePath,
    truncated,
    skim,
    read: body,
    audit,
    outgoingCitations: outgoing,
    isSurvey: paper.isSurvey,
    modelUsed: meta.modelName,
    promptVersion: meta.promptVersion,
    passesCompleted: meta.passesCompleted,
    totalLlmCalls: meta.totalLlmCalls,
    totalTokensIn: 0,
    totalTokensOut: 0,
    createdAt: meta.now,
    updatedAt: meta.now,
  };
}

function fallbackSkim(): PaperReadSkim {
  return {
    oneLineSummary: "(skim unavailable)",
    mainContribution: "",
    sectionOutline: [],
    decision: "skim_sufficient",
    decisionReason: "skim pass failed; held with neutral decision",
  };
}

function abstractOnlyFallback(
  paper: PaperNode,
  now: string,
  modelName: string,
  promptVersion: string,
): PaperRead {
  return {
    paperId: paper.id,
    arxivId: paper.arxivId,
    doi: paper.doi,
    sourceKind: "abstract-only",
    sourceBytes: paper.abstract?.length ?? 0,
    truncated: false,
    skim: fallbackSkim(),
    outgoingCitations: [],
    isSurvey: paper.isSurvey,
    modelUsed: modelName,
    promptVersion,
    passesCompleted: [],
    totalLlmCalls: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function persist(
  workspace: string,
  read: PaperRead,
  log: (m: string) => void,
): Promise<void> {
  try {
    await writePaperRead(workspace, read);
  } catch (err) {
    log(`[read] persist failed for "${read.paperId}": ${errText(err)}`);
  }
}
