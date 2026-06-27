/**
 * Reading loop (Phase D, Tasks 18 + 19) — replaces the citation-graph BFS
 * (`citation-explorer.ts`) with a survey-priority reading loop that drives the
 * 3-pass reader (`reader/index.ts`) once per paper.
 *
 * Faithful to DESIGN-REFERENCE.md §3.3 (the loop) and §7.1 (surveys-as-first-
 * class). The loop:
 *   - seeds a priority queue from PriorArtCorpus.surveys (priority ∞), then
 *     user seeds (priority just below ∞), then expository MO answers (only when
 *     an arxiv id is resolvable);
 *   - repeatedly reads the highest-priority paper via `readPaper`, hard-deletes
 *     rejected (crank) papers without harvesting their bibliography, runs an
 *     extra "survey distillation" pass on high-confidence surveys, and harvests
 *     each read's outgoing citations into new queue candidates;
 *   - converges when K consecutive reads add no novelty (natural), when the
 *     queue empties (queue_exhausted), or when a sanity cap is hit
 *     (circuit_breaker).
 *
 * Never throws on the happy path — per-paper failures degrade to a skipped /
 * abstract-only read inside `readPaper`, and discovery failures are isolated.
 */

import type { PaperNode, PaperRead, PaperReadSurveyDistillation } from "../../paper-graph/types.js";
import type { SpineLLM } from "./spine/llm.js";
import { extractSpineJSON, errMsg } from "./spine/llm.js";
import type { SpinePipelineEvent } from "./spine/types.js";
import {
  getPaper,
  ingestPaper,
  paperGraphDir,
  type PaperNodeInput,
} from "../../paper-graph/index.js";
import { deletePaperRead, writePaperRead } from "../../paper-graph/reads.js";
import { readPaper as realReadPaper, type ReadPaperCtx } from "./reader/index.js";
import { buildSurveyDistillationPrompt } from "./reading-loop-prompts.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── PriorArtCorpus (DESIGN-REFERENCE §3.3) ───────────────────────────────────
// Defined here so the reading loop is self-contained and unit-testable without
// a hard dependency on the (concurrently-developed) `prior-art/` module. The
// shape mirrors §3.3 exactly; `prior-art/index.ts` produces this same shape.
export interface PriorArtCorpus {
  surveys: Array<{
    paperId: string;
    title: string;
    authors: string[];
    year?: number;
    source: "arxiv" | "bourbaki" | "annual-review" | "lecture-notes-pdf";
    confidence: number;
    why: string;
  }>;
  expositoryAnswers: Array<{
    url: string;
    title: string;
    author: string;
    score: number;
    excerpt: string;
    confidence: number;
  }>;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ReadingLoopConfig {
  workspace: string;
  projectDir: string;
  problem: { title: string; formalStatement: string; tags: string[]; slug: string };
  seedPaperIds: string[];
  priorArt: PriorArtCorpus | null;
  llm: SpineLLM;
  modelName: string;
  promptVersion?: string;
}

export interface ReadingLoopUnresolvedCitation {
  citedTitle?: string;
  citedAuthors?: string[];
  citedYear?: number;
  whyImportant: string;
  attemptedResolutions: string[];
  status: "unresolved";
}

export interface ReadingLoopResult {
  reads: PaperRead[];
  rejectedPaperIds: string[];
  unresolvedCitations: ReadingLoopUnresolvedCitation[];
  convergence: {
    reason: "natural" | "circuit_breaker" | "queue_exhausted";
    consecutiveEmptyRounds: number;
    totalRoundsRun: number;
    circuitBreakerTripped: boolean;
  };
}

export interface ReadingLoopDeps {
  fetchArxivById?: typeof import("./crawlers.js").fetchArxivById;
  searchArxivByTitle?: (
    query: string,
    max: number,
  ) => Promise<Array<{ arxivId: string; title: string; authors: string[]; year?: number; abstract?: string }>>;
  fetchArxivSource?: typeof import("../../paper-graph/arxiv-source.js").fetchArxivSource;
  runPdfToText?: (pdfPath: string) => Promise<string | null>;
  rateDelayMs?: number;
  emit?: (event: SpinePipelineEvent | { type: "log"; message: string }) => void;
  /**
   * Reader seam. Defaults to the real 3-pass `readPaper`. Tests inject a stub so
   * the loop's queueing/convergence logic can be exercised without driving the
   * full skim→read→audit pipeline.
   */
  readPaper?: (paper: PaperNode, ctx: ReadPaperCtx) => Promise<PaperRead>;
}

export const CONVERGENCE_K_DEFAULT = 3;
export const SOFT_CIRCUIT_BREAKER_PAPERS = 1000;

// Priority bands. Surveys outrank seeds (§7.1: "above seeds"); a survey's own
// curated references outrank generic harvest; harvest priority is set by the
// citation's importance to the citing paper.
const PRIORITY_SURVEY = 1e12;
const PRIORITY_SEED = 1e9;
const PRIORITY_SURVEY_KEYREF = 1e6;
const IMPORTANCE_PRIORITY: Record<"essential" | "supporting" | "passing", number> = {
  essential: 100,
  supporting: 50,
  passing: 10,
};

interface QueueEntry {
  paperId: string;
  why: string;
  priority: number;
}

// ── Implementation ───────────────────────────────────────────────────────────

export async function runReadingLoop(
  config: ReadingLoopConfig,
  deps: ReadingLoopDeps,
): Promise<ReadingLoopResult> {
  const { workspace, problem } = config;
  const emit = deps.emit ?? (() => {});
  const log = (message: string) => emit({ type: "log", message });
  const readPaper = deps.readPaper ?? realReadPaper;
  const fetchArxivById = deps.fetchArxivById;
  const searchArxivByTitle = deps.searchArxivByTitle;
  const K = CONVERGENCE_K_DEFAULT;

  const queue: QueueEntry[] = [];
  const queued = new Set<string>();
  const reads = new Map<string, PaperRead>();
  const rejected = new Set<string>();
  const unresolved: ReadingLoopUnresolvedCitation[] = [];

  // Survey confidence by paperId (drives the distillation pass).
  const surveyConfidence = new Map<string, number>();

  let consecutiveEmptyRounds = 0;
  let totalRounds = 0;
  let circuitBreakerTripped = false;

  const push = (entry: QueueEntry): void => {
    if (!entry.paperId) return;
    if (reads.has(entry.paperId) || rejected.has(entry.paperId) || queued.has(entry.paperId)) return;
    queue.push(entry);
    queued.add(entry.paperId);
  };

  // ── Initialize the queue ───────────────────────────────────────────────────
  for (const s of config.priorArt?.surveys ?? []) {
    surveyConfidence.set(s.paperId, s.confidence);
    push({ paperId: s.paperId, why: `survey: ${s.why}`, priority: PRIORITY_SURVEY });
  }
  for (const seedId of config.seedPaperIds) {
    push({ paperId: seedId, why: "user-confirmed seed", priority: PRIORITY_SEED });
  }
  // Expository MO/SE answers are URLs, not papers (§7.1) — only enqueue if an
  // arxiv id is resolvable. We have no URL→arxiv resolver here, so they are
  // recorded as context only and skipped from the paper queue.
  for (const ans of config.priorArt?.expositoryAnswers ?? []) {
    log(`[reading-loop] expository answer noted (not enqueued, no arxiv id): ${ans.url}`);
  }

  log(
    `[reading-loop] start: ${queue.length} initial candidates ` +
      `(${config.priorArt?.surveys.length ?? 0} surveys, ${config.seedPaperIds.length} seeds), K=${K}`,
  );

  // ── Main loop ──────────────────────────────────────────────────────────────
  let reason: ReadingLoopResult["convergence"]["reason"] = "queue_exhausted";

  for (;;) {
    if (queue.length === 0) {
      reason = "queue_exhausted";
      break;
    }
    if (reads.size >= SOFT_CIRCUIT_BREAKER_PAPERS) {
      circuitBreakerTripped = true;
      reason = "circuit_breaker";
      emit({ type: "log", message: `[reading-loop] field_too_large: reached ${reads.size} reads — circuit breaker` });
      break;
    }
    if (consecutiveEmptyRounds >= K) {
      reason = "natural";
      break;
    }

    totalRounds++;

    // Pick the highest-priority candidate.
    let bestIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].priority > queue[bestIdx].priority) bestIdx = i;
    }
    const candidate = queue.splice(bestIdx, 1)[0];
    queued.delete(candidate.paperId);

    // Load (or ingest) the paper node.
    const node = await loadOrIngestNode(workspace, candidate.paperId, fetchArxivById, log);
    if (!node) {
      log(`[reading-loop] could not load/ingest "${candidate.paperId}" — skipping`);
      continue;
    }

    // Defensively flag surveys (should already be set during prior-art ingest).
    const isSurvey = node.isSurvey || surveyConfidence.has(candidate.paperId);

    const ctx: ReadPaperCtx = {
      workspace,
      problemTitle: problem.title,
      llm: config.llm,
      modelName: config.modelName,
      promptVersion: config.promptVersion,
      emitLog: (m) => log(m),
      fetchArxivSource: deps.fetchArxivSource,
      runPdfToText: deps.runPdfToText,
      rateDelayMs: deps.rateDelayMs,
    };

    let read: PaperRead;
    try {
      read = await readPaper(node, ctx);
    } catch (err) {
      log(`[reading-loop] readPaper threw for "${node.title}" (continuing): ${errMsg(err)}`);
      continue;
    }
    if (isSurvey && !read.isSurvey) read.isSurvey = true;
    reads.set(candidate.paperId, read);
    emit({ type: "log", message: `[reading-loop] paper_read_complete: "${node.title}" (round ${totalRounds})` });

    // ── Rejected (crank) papers are hard-deleted; no biblio harvest. ──────────
    if (read.audit?.verdict === "rejected") {
      rejected.add(candidate.paperId);
      reads.delete(candidate.paperId);
      await hardDeletePaper(workspace, candidate.paperId, log);
      emit({ type: "log", message: `[reading-loop] paper_rejected: "${node.title}" — hard-deleted` });
      continue;
    }

    // ── Discarded skims: kept as a read, but no biblio harvest. ───────────────
    if (read.skim.decision === "discard") {
      log(`[reading-loop] skim → discard for "${node.title}"; no harvest`);
      continue;
    }

    // ── Survey distillation (high-confidence surveys only). ───────────────────
    const confidence = surveyConfidence.get(candidate.paperId);
    if (read.isSurvey && read.read && confidence != null && confidence >= 0.8) {
      const distilled = await distillSurvey(node, read, problem.title, config.llm, log);
      if (distilled) {
        read.surveyDistillation = distilled;
        read.updatedAt = new Date().toISOString();
        try {
          await writePaperRead(workspace, read);
        } catch (err) {
          log(`[reading-loop] persist survey distillation failed: ${errMsg(err)}`);
        }
        // The survey author's curated references are gold — promote to queue.
        for (const ref of distilled.keyReferences) {
          if (!ref.arxivId) continue;
          const refId = await ingestArxiv(workspace, ref.arxivId, ref.title, ref.author ? [ref.author] : [], ref.year, fetchArxivById, log);
          if (refId) push({ paperId: refId, why: `survey key reference: ${ref.whyTheSurveyHighlighted}`, priority: PRIORITY_SURVEY_KEYREF });
        }
      }
    }

    // ── Novelty check. ────────────────────────────────────────────────────────
    if (isNovelty(read)) {
      consecutiveEmptyRounds = 0;
    } else {
      consecutiveEmptyRounds++;
    }
    emit({
      type: "log",
      message: `[reading-loop] convergence_check: consecutiveEmptyRounds=${consecutiveEmptyRounds}/${K}, reads=${reads.size}`,
    });

    // ── Bibliography harvest → new candidates. ────────────────────────────────
    for (const citation of read.outgoingCitations) {
      const priority = IMPORTANCE_PRIORITY[citation.importanceToThisPaper] ?? IMPORTANCE_PRIORITY.passing;
      if (citation.citedArxivId) {
        const citedId = await ingestArxiv(
          workspace,
          citation.citedArxivId,
          citation.citedTitle ?? citation.citedArxivId,
          citation.citedAuthors ?? [],
          citation.citedYear,
          fetchArxivById,
          log,
        );
        if (citedId && !reads.has(citedId) && !rejected.has(citedId)) {
          push({ paperId: citedId, why: citation.contextInThisPaper, priority });
        }
        continue;
      }
      if (citation.citedTitle && searchArxivByTitle) {
        let hits: Awaited<ReturnType<NonNullable<ReadingLoopDeps["searchArxivByTitle"]>>> = [];
        try {
          hits = await searchArxivByTitle(citation.citedTitle, 3);
        } catch (err) {
          log(`[reading-loop] title search failed for "${citation.citedTitle}": ${errMsg(err)}`);
        }
        if (hits.length > 0) {
          const top = hits[0];
          const citedId = await ingestArxiv(workspace, top.arxivId, top.title, top.authors, top.year, fetchArxivById, log, top.abstract);
          if (citedId && !reads.has(citedId) && !rejected.has(citedId)) {
            push({ paperId: citedId, why: citation.contextInThisPaper, priority });
          }
          continue;
        }
        unresolved.push({
          citedTitle: citation.citedTitle,
          citedAuthors: citation.citedAuthors,
          citedYear: citation.citedYear,
          whyImportant: citation.contextInThisPaper,
          attemptedResolutions: ["arxiv: 0 hits"],
          status: "unresolved",
        });
        continue;
      }
      if (citation.citedTitle) {
        // No title-search seam available — record as unresolved.
        unresolved.push({
          citedTitle: citation.citedTitle,
          citedAuthors: citation.citedAuthors,
          citedYear: citation.citedYear,
          whyImportant: citation.contextInThisPaper,
          attemptedResolutions: ["arxiv: no search seam"],
          status: "unresolved",
        });
      }
    }
  }

  log(
    `[reading-loop] done: reason=${reason}, reads=${reads.size}, rejected=${rejected.size}, ` +
      `unresolved=${unresolved.length}, rounds=${totalRounds}`,
  );

  return {
    reads: Array.from(reads.values()),
    rejectedPaperIds: Array.from(rejected),
    unresolvedCitations: unresolved,
    convergence: {
      reason,
      consecutiveEmptyRounds,
      totalRoundsRun: totalRounds,
      circuitBreakerTripped,
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A read counts as "novel" if it produced non-trivial novelContributions. */
function isNovelty(read: PaperRead): boolean {
  const nc = read.read?.novelContributions;
  if (typeof nc !== "string") return false;
  return nc.trim().length > 0;
}

async function loadOrIngestNode(
  workspace: string,
  paperId: string,
  fetchArxivById: ReadingLoopDeps["fetchArxivById"],
  log: (m: string) => void,
): Promise<PaperNode | null> {
  const existing = await getPaper(workspace, paperId);
  if (existing) return existing;

  // The id may be an arxiv node id (`arxiv-<id>`) or a bare arxiv id.
  const arxivId = paperId.startsWith("arxiv-") ? paperId.slice("arxiv-".length) : paperId;
  if (fetchArxivById) {
    const id = await ingestArxiv(workspace, arxivId, paperId, [], undefined, fetchArxivById, log);
    if (id) return getPaper(workspace, id);
  }
  return null;
}

/**
 * Ingest a paper by arxiv id, enriching from arxiv metadata when a fetcher is
 * available. Returns the node id, or null on failure.
 */
async function ingestArxiv(
  workspace: string,
  arxivId: string,
  fallbackTitle: string,
  fallbackAuthors: string[],
  fallbackYear: number | undefined,
  fetchArxivById: ReadingLoopDeps["fetchArxivById"],
  log: (m: string) => void,
  fallbackAbstract?: string,
): Promise<string | null> {
  let input: PaperNodeInput = {
    title: fallbackTitle,
    authors: fallbackAuthors,
    year: fallbackYear,
    abstract: fallbackAbstract,
    arxivId,
  };
  if (fetchArxivById) {
    try {
      const meta = await fetchArxivById(arxivId);
      if (meta) {
        input = {
          title: meta.title || fallbackTitle,
          authors: meta.authors ?? fallbackAuthors,
          year: meta.year ?? fallbackYear,
          abstract: meta.abstract ?? fallbackAbstract,
          url: meta.url,
          arxivId: meta.arxivId ?? arxivId,
          doi: meta.doi,
        };
      }
    } catch (err) {
      log(`[reading-loop] arxiv enrich failed for "${arxivId}": ${errMsg(err)}`);
    }
  }
  return ingestPaper(workspace, input);
}

/** Hard-delete a rejected (crank) paper: remove its read and node file. */
async function hardDeletePaper(workspace: string, paperId: string, log: (m: string) => void): Promise<void> {
  try {
    await deletePaperRead(workspace, paperId);
  } catch (err) {
    log(`[reading-loop] deletePaperRead failed for "${paperId}": ${errMsg(err)}`);
  }
  try {
    const sanitized = paperId.replace(/[^a-zA-Z0-9._-]/g, "_");
    await fs.rm(path.join(paperGraphDir(workspace), "nodes", `${sanitized}.json`), { force: true });
  } catch (err) {
    log(`[reading-loop] delete node file failed for "${paperId}": ${errMsg(err)}`);
  }
}

/** Run the survey-distillation pass; returns the parsed distillation or null. */
async function distillSurvey(
  node: PaperNode,
  read: PaperRead,
  problemTitle: string,
  llm: SpineLLM,
  log: (m: string) => void,
): Promise<PaperReadSurveyDistillation | null> {
  if (!read.read) return null;
  try {
    const prompt = buildSurveyDistillationPrompt(node, read.read, problemTitle);
    const raw = await llm(prompt, { temperature: 0, maxTokens: 2500 });
    const parsed = extractSpineJSON<{
      coveredSubAreas?: unknown;
      keyReferences?: unknown;
      surveyAuthorOpinion?: unknown;
      surveyOutline?: unknown;
    }>(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const coveredSubAreas = Array.isArray(parsed.coveredSubAreas)
      ? parsed.coveredSubAreas.filter((x): x is string => typeof x === "string")
      : [];
    const keyReferences = Array.isArray(parsed.keyReferences)
      ? parsed.keyReferences
          .map((r) => normalizeKeyReference(r))
          .filter((r): r is PaperReadSurveyDistillation["keyReferences"][number] => r != null)
      : [];
    const surveyOutline = Array.isArray(parsed.surveyOutline)
      ? parsed.surveyOutline
          .map((s) => normalizeOutline(s))
          .filter((s): s is { heading: string; summary: string } => s != null)
      : undefined;

    log(`[reading-loop] survey distilled: ${coveredSubAreas.length} sub-areas, ${keyReferences.length} key refs`);
    return {
      coveredSubAreas,
      keyReferences,
      surveyAuthorOpinion:
        typeof parsed.surveyAuthorOpinion === "string" ? parsed.surveyAuthorOpinion : undefined,
      surveyOutline,
    };
  } catch (err) {
    log(`[reading-loop] survey distillation failed for "${node.title}": ${errMsg(err)}`);
    return null;
  }
}

function normalizeKeyReference(r: unknown): PaperReadSurveyDistillation["keyReferences"][number] | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.title !== "string") return null;
  return {
    author: typeof o.author === "string" ? o.author : "",
    year: typeof o.year === "number" ? o.year : 0,
    title: o.title,
    arxivId: typeof o.arxivId === "string" ? o.arxivId : undefined,
    whyTheSurveyHighlighted:
      typeof o.whyTheSurveyHighlighted === "string" ? o.whyTheSurveyHighlighted : "",
  };
}

function normalizeOutline(s: unknown): { heading: string; summary: string } | null {
  if (!s || typeof s !== "object") return null;
  const o = s as Record<string, unknown>;
  if (typeof o.heading !== "string") return null;
  return { heading: o.heading, summary: typeof o.summary === "string" ? o.summary : "" };
}
