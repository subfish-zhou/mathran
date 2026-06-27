/**
 * Spine-First Architecture — Effort Generation from Spine (fs port of mathub's
 * `effort-from-spine.ts`).
 *
 * Generates workspace efforts from the Narrative Spine and writes each one to
 * `<project>/efforts/<id>/` (document.md + effort.json):
 *   - Each SpineThread → a REFERENCE effort (literature survey)
 *   - Each major SpineNode → a METHOD/CONSTRUCTION/etc effort
 *   - SpineEdges → effort relations (direct mapping, no LLM guessing)
 *
 * The DB layer (mathub) is replaced by the fs paper-graph; full-text fetch is
 * dropped (abstracts only). Pure helpers (tags, type/role mapping, difficulty)
 * are kept verbatim so the original unit tests port unchanged.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../../../chat/atomic-write.js";

import { slugify } from "../../../../lib/slug.js";
import { getPaper } from "../../../paper-graph/index.js";
import { fetchArxivSource } from "../../../paper-graph/arxiv-source.js";
import { EFFORT_LAYOUT, attachReference } from "../../../effort/store.js";
// [sync-upgrade 2026-06-26 P2-B] buildEffortDocumentPrompt /
// buildThreadDocumentPrompt are no longer used — apply-init-result.ts
// (or this module's writeEffort) builds the scaffold from spine
// context + references list, without an LLM call. The prompt
// functions remain exported from ./prompts.js for callers outside the
// init pipeline that may still want a one-shot doc-style summary
// (none in mathran today; kept for API stability).
import { errMsg, noopEmit, type SpineLLM, type EmitFn } from "./llm.js";
import { getPaperRead } from "../../../paper-graph/reads.js";
import { synthesizeEffort } from "../effort-synthesis/index.js";
import { synthesizeThreadSurvey } from "../effort-synthesis/thread-survey.js";
import type { PaperRead } from "../../../paper-graph/types.js";
import type {
  NarrativeSpine,
  SpineNode,
  SpineEdge,
  SpineThread,
  SpineDiff,
  WorkspaceEffortOutput,
  DependencyEdgeOutput,
  SpineCrawledResource,
} from "./types.js";

interface PaperMeta {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
  /** sync-upgrade P1-C: arxiv LaTeX source main .tex content (loaded on demand). */
  fullText?: string;
}

export interface EffortFromSpineConfig {
  spine: NarrativeSpine;
  projectDir: string;
  workspace: string;
  problemTitle: string;
  /** Only generate efforts for a specific spine diff (patrol incremental) */
  diff?: SpineDiff;
  /**
   * v3 (Task 27): node efforts are synthesized as a 4-piece set
   * (document.md / README.md / notes / scratch) via
   * `synthesizeEffort`. Set to `false` (the `--no-effort-synthesis`
   * debug flag) to fall back to the legacy stub-writer that only
   * scaffolds an empty work-log document.md. Defaults to `true`.
   */
  useEffortSynthesis?: boolean;
}

/**
 * Optional review-loop wiring for effort synthesis (Task 31-34). When `reviewerLlm`
 * is supplied, `synthesizeEffort` runs the writer-reviewer loop on document.md
 * and README.md. When omitted, no review happens (the v3 dogfood-run-2 bug was
 * exactly this: agent.ts called us without passing a reviewer LLM, so the
 * review-loop's `if (!deps.reviewerLlm) return` short-circuited every artifact).
 */
export interface EffortFromSpineReviewerDeps {
  reviewerLlm?: SpineLLM;
  writerModel?: string;
  reviewerModel?: string;
  estimateCost?: (model: string, tokens: { in: number; out: number }) => number;
}

export interface EffortFromSpineResult {
  efforts: WorkspaceEffortOutput[];
  edges: DependencyEdgeOutput[];
}

// ============================================================
//  fs persistence
// ============================================================

export function effortsDir(projectDir: string): string {
  return path.join(projectDir, "efforts");
}

function effortFrontmatter(e: WorkspaceEffortOutput): string {
  return [
    "---",
    `id: ${e.id}`,
    `title: ${JSON.stringify(e.title)}`,
    `type: ${e.type}`,
    `status: ${e.status}`,
    `difficulty: ${e.difficultyEstimate}`,
    e.year != null ? `year: ${e.year}` : null,
    e.era ? `era: ${JSON.stringify(e.era)}` : null,
    e.spineNodeId ? `spineNodeId: ${e.spineNodeId}` : null,
    e.spineThreadId ? `spineThreadId: ${e.spineThreadId}` : null,
    e.narrativeRole ? `narrativeRole: ${e.narrativeRole}` : null,
    `tags: [${e.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    "---",
    "",
  ].filter((l): l is string => l != null).join("\n");
}

async function writeEffort(
  projectDir: string,
  workspace: string,
  e: WorkspaceEffortOutput,
): Promise<void> {
  try {
    const dir = path.join(effortsDir(projectDir), e.id);
    await fs.mkdir(dir, { recursive: true });
    // 2026-06-26 (sync-upgrade P2-A/P2-B): scaffold the same work-detail
    // subdirs that initEffort() creates so that workspace efforts coming
    // out of the spine pipeline have the full layout (references/,
    // notes/, scratch/, artifacts.jsonl). Match initEffort exactly.
    for (const sub of [EFFORT_LAYOUT.references, EFFORT_LAYOUT.notes, EFFORT_LAYOUT.scratch, EFFORT_LAYOUT.files]) {
      const subDir = path.join(dir, sub);
      await fs.mkdir(subDir, { recursive: true });
      try {
        await fs.access(path.join(subDir, ".gitkeep"));
      } catch {
        await fs.writeFile(path.join(subDir, ".gitkeep"), "", "utf-8");
      }
    }
    const artifactsPath = path.join(dir, EFFORT_LAYOUT.artifactsIndex);
    try {
      await fs.access(artifactsPath);
    } catch {
      await fs.writeFile(artifactsPath, "", "utf-8");
    }

    // [Fix D5 2026-06-26] Escape markdown special chars in titles
    // and paths so a paper title like "**bold** trick" or a filename
    // with backticks doesn't break the scaffold's layout. Replace
    // newlines too (titles shouldn't have them but defensively).
    const escMd = (s: string): string =>
      s
        .replace(/\r?\n/g, " ")
        .replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
    const escCode = (s: string): string =>
      // Filename in a backtick code-span — strip backticks (rare).
      s.replace(/`/g, "");

    // 2026-06-26 (sync-upgrade P2-B): auto-attach arxiv references.
    // Symlinks <workspace>/.mathran/paper-sources/<id>/ into
    // <effort>/references/<id> for every paper in e.sources that has
    // an arxivId. The fetch was done in the spine builder pass; here
    // we only link to the cache (no re-fetch).
    const refSummaries: string[] = [];
    for (const src of e.sources) {
      const titleMd = escMd(src.title ?? "(untitled)");
      if (src.arxivId) {
        try {
          const arxivCache = await fetchArxivSource(src.arxivId, { workspace });
          if (arxivCache.status === "ok") {
            await attachReference(workspace, slugFromProjectDir(projectDir), e.id, src.arxivId, arxivCache.rootDir);
            const mainRel = arxivCache.mainTexFile ? path.relative(arxivCache.rootDir, arxivCache.mainTexFile) : "(no main .tex auto-resolved)";
            const safeArxivPath = escCode(src.arxivId.replace(/\//g, "_"));
            const safeMainRel = escCode(mainRel);
            refSummaries.push(`- [arXiv:${src.arxivId}] **${titleMd}** — see \`references/${safeArxivPath}/${safeMainRel}\``);
          } else {
            refSummaries.push(`- [arXiv:${src.arxivId}] **${titleMd}** — source unavailable (${arxivCache.status})`);
          }
        } catch (err) {
          refSummaries.push(`- [arXiv:${src.arxivId}] **${titleMd}** — attach failed: ${errMsg(err)}`);
        }
      } else if (src.url) {
        refSummaries.push(`- **${titleMd}** — ${src.url}`);
      } else {
        refSummaries.push(`- **${titleMd}**`);
      }
    }

    // 2026-06-26 (sync-upgrade P2-B): document.md no longer contains
    // an LLM-generated "what should be done" summary. It's the user's
    // work log. We seed it with a banner + reference index + spine
    // context, but the body is meant for the user.
    const banner = `> [Auto-generated scaffold by mathran init agent — ${new Date().toISOString()}]\n>\n> This effort was scaffolded from spine node \`${e.spineNodeId ?? e.spineThreadId ?? "(unknown)"}\`. The source papers below are auto-fetched (LaTeX source where available). Start your work by reading them and writing your own notes in this file or under \`scratch/\`.`;
    const referencesSection = refSummaries.length > 0
      ? `\n\n## References\n${refSummaries.join("\n")}`
      : "";
    const spineContext = e.description
      ? `\n\n## Spine context\n${e.description}`
      : "";
    const userArea = `\n\n## Work log\n_(your notes go here)_\n`;
    const body = banner + referencesSection + spineContext + userArea;

    await atomicWriteFile(
      path.join(dir, "document.md"),
      effortFrontmatter(e) + body + "\n",
    );
    await atomicWriteFile(path.join(dir, "effort.json"), JSON.stringify(e, null, 2) + "\n");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[spine-efforts] writeEffort(${e.id}) failed: ${errMsg(err)}`);
  }
}

/**
 * `projectDir` is `<workspace>/projects/<slug>`. Extract the slug for
 * attachReference (which needs the project slug, not the dir).
 */
function slugFromProjectDir(projectDir: string): string {
  return path.basename(projectDir);
}

// ============================================================
//  Main Entry Point
// ============================================================

export async function generateEffortsFromSpine(
  config: EffortFromSpineConfig,
  llm: SpineLLM,
  emit: EmitFn = noopEmit,
  reviewer: EffortFromSpineReviewerDeps = {},
): Promise<EffortFromSpineResult> {
  const { spine, problemTitle, diff, workspace, projectDir } = config;
  const useSynthesis = config.useEffortSynthesis !== false;
  const efforts: WorkspaceEffortOutput[] = [];
  const edges: DependencyEdgeOutput[] = [];

  const nodesToProcess = diff
    ? [
        ...diff.newNodes,
        ...diff.updatedNodes
          .map((u) => spine.nodes.find((n) => n.id === u.id))
          .filter((n): n is SpineNode => n != null),
      ]
    : spine.nodes.filter(shouldProcessNodeInFullInit);

  const threadsToProcess = diff ? [...diff.newThreads, ...diff.updatedThreads] : spine.threads;

  emit({ type: "log", message: `Generating efforts: ${threadsToProcess.length} threads, ${nodesToProcess.length} nodes` });

  const usedEffortIds = new Set<string>();
  const reserveEffortId = (base: string): string => {
    const safe = base || "effort";
    if (!usedEffortIds.has(safe)) {
      usedEffortIds.add(safe);
      return safe;
    }
    for (let n = 2; n < 1000; n++) {
      const candidate = `${safe}-${n}`;
      if (!usedEffortIds.has(candidate)) {
        usedEffortIds.add(candidate);
        emit({ type: "log", message: `Effort ID "${safe}" collision; using "${candidate}"` });
        return candidate;
      }
    }
    const candidate = `${safe}-${Math.random().toString(36).slice(2, 8)}`;
    usedEffortIds.add(candidate);
    return candidate;
  };
  const spineToEffort = new Map<string, string>();

  // ── 1. Thread → REFERENCE efforts ──
  for (const thread of threadsToProcess) {
    emit({ type: "log", message: `Generating thread survey: ${thread.name}` });

    const threadNodes = thread.nodeIds
      .map((id) => spine.nodes.find((n) => n.id === id))
      .filter(Boolean) as SpineNode[];

    const paperIds = [...new Set(threadNodes.flatMap((n) => n.paperIds))];
    const papers = await loadPaperMetadata(workspace, paperIds);
    const era = spine.eras.find((e) => e.nodeIds.some((id) => thread.nodeIds.includes(id)));
    const years = threadNodes.map((n) => n.year).filter((y): y is number => typeof y === "number");
    const year = years.length > 0 ? Math.min(...years) : undefined;

    // 2026-06-27 (档 3.11): when effort synthesis is enabled and a reviewerLlm
    // is available, fold the thread into a real narrative survey via the
    // writer-reviewer loop instead of leaving it as a 2-sentence scaffold.
    // The body weaves together the thread description + every node's
    // statement / significance / role so the user has a coherent reading
    // entry-point per thread rather than just "see node A, node B, …".
    // Failure-isolated: any LLM error degrades to the legacy scaffold body.
    let document = `Survey of ${thread.name}. ${thread.description}`;
    if (useSynthesis && reviewer.reviewerLlm) {
      try {
        document = await synthesizeThreadSurvey({
          thread,
          threadNodes,
          era,
          problemTitle,
          projectDir,
        }, {
          llm,
          reviewerLlm: reviewer.reviewerLlm,
          writerModel: reviewer.writerModel ?? "",
          reviewerModel: reviewer.reviewerModel ?? "",
          estimateCost: reviewer.estimateCost,
          emitLog: (m) => emit({ type: "log", message: m }),
        });
      } catch (err) {
        emit({ type: "log", message: `[spine-efforts] synthesizeThreadSurvey(${thread.id}) failed: ${errMsg(err)}; falling back to scaffold` });
      }
    }

    const effortId = reserveEffortId(slugify(thread.name, "thread"));
    spineToEffort.set(thread.id, effortId);

    const effort: WorkspaceEffortOutput = {
      id: effortId,
      type: "REFERENCE",
      title: thread.name,
      description: thread.description,
      status: "REFERENCE",
      subject: thread.currentFrontier ?? thread.barrier ?? thread.description,
      sources: papers.map(paperToResource),
      document,
      tags: buildThreadTags(thread),
      difficultyEstimate: estimateThreadDifficulty(thread.status),
      year,
      era: era?.name,
      spineThreadId: thread.id,
      abstract: thread.description,
      narrativeRole: thread.status === "dead_end" ? "dead_end" : "core_technique",
      referenceKind: "thread_survey",
      includedPaperIds: paperIds,
      includedSpineNodeIds: thread.nodeIds,
    };
    efforts.push(effort);
    await writeEffort(projectDir, workspace, effort);
    emit({ type: "effort_created", effortId, title: thread.name, fromSpineNode: thread.id });
  }

  // ── 2. Major Spine Nodes → METHOD efforts ──
  const majorNodes = nodesToProcess.filter(shouldGenerateNodeEffort);

  for (const node of majorNodes) {
    emit({ type: "log", message: `Generating effort for: ${node.title}` });

    const papers = await loadPaperMetadata(workspace, node.paperIds);
    const papersForPrompt = papers.map((p) => ({
      title: p.title,
      authors: p.authors,
      year: p.year,
      abstract: p.abstract,
    }));

    const predecessors = spine.edges
      .filter((e) => e.to === node.id)
      .map((e) => {
        const predNode = spine.nodes.find((n) => n.id === e.from);
        return predNode ? { title: predNode.title, context: e.context } : null;
      })
      .filter(Boolean) as Array<{ title: string; context: string }>;

    const successors = spine.edges
      .filter((e) => e.from === node.id)
      .map((e) => {
        const succNode = spine.nodes.find((n) => n.id === e.to);
        return succNode ? { title: succNode.title, context: e.context } : null;
      })
      .filter(Boolean) as Array<{ title: string; context: string }>;

    const era = spine.eras.find((e) => e.nodeIds.includes(node.id));
    const thread = spine.threads.find((t) => t.nodeIds.includes(node.id));

    // 2026-06-26 (sync-upgrade P2-B): skip the LLM "what should be
    // done" doc. writeEffort() builds document.md from the spine
    // node statement + references list. effort.description carries
    // the node statement / significance for that downstream use.
    const document = `${node.title}\n\n${node.statement}\n\n${node.significance}`;

    // v3 (Task 27): when effort synthesis is enabled (default), the
    // node effort is generated as a real 4-piece set via
    // synthesizeEffort, which owns the directory layout, document.md,
    // README.md, notes/agent-reading-notes.md and scratch/. We then
    // register its returned id so the edge-mapping below stays
    // consistent and skip the legacy stub writeEffort().
    if (useSynthesis) {
      const predecessorNodes = spine.edges
        .filter((e) => e.to === node.id)
        .map((e) => spine.nodes.find((n) => n.id === e.from))
        .filter((n): n is SpineNode => n != null);
      const successorNodes = spine.edges
        .filter((e) => e.from === node.id)
        .map((e) => spine.nodes.find((n) => n.id === e.to))
        .filter((n): n is SpineNode => n != null);
      const paperReads = await loadPaperReads(workspace, node.paperIds);

      let synthId: string;
      try {
        const synth = await synthesizeEffort(
          { node, spine, paperReads, predecessorNodes, successorNodes, problemTitle, projectDir },
          {
            llm,
            emitLog: (m) => emit({ type: "log", message: m }),
            reviewerLlm: reviewer.reviewerLlm,
            writerModel: reviewer.writerModel,
            reviewerModel: reviewer.reviewerModel,
            estimateCost: reviewer.estimateCost,
          },
        );
        synthId = synth.effortId;
      } catch (err) {
        emit({ type: "log", message: `[spine-efforts] synthesizeEffort(${node.id}) failed: ${errMsg(err)}; falling back to stub` });
        synthId = reserveEffortId(slugify(node.title, "node-effort"));
        const fallbackEffort: WorkspaceEffortOutput = {
          id: synthId, type: mapNodeTypeToEffortType(node.type), title: node.title,
          description: node.significance, status: mapNodeTypeToStatus(node.type),
          subject: node.statement.slice(0, 200), sources: papers.map(paperToResource),
          document, tags: buildNodeTags(node, thread), difficultyEstimate: estimateNodeDifficulty(node),
          year: node.year, era: era?.name, spineNodeId: node.id, spineThreadId: thread?.id,
          abstract: node.significance, formalStatement: node.statement,
          narrativeRole: mapNodeTypeToNarrativeRole(node.type),
          deadEndReason: node.type === "dead_end" ? node.significance : undefined,
        };
        await writeEffort(projectDir, workspace, fallbackEffort);
      }
      usedEffortIds.add(synthId);
      spineToEffort.set(node.id, synthId);
      efforts.push({
        id: synthId,
        type: mapNodeTypeToEffortType(node.type),
        title: node.title,
        description: node.significance,
        status: mapNodeTypeToStatus(node.type),
        subject: node.statement.slice(0, 200),
        sources: papers.map(paperToResource),
        document,
        tags: buildNodeTags(node, thread),
        difficultyEstimate: estimateNodeDifficulty(node),
        year: node.year,
        era: era?.name,
        spineNodeId: node.id,
        spineThreadId: thread?.id,
        abstract: node.significance,
        formalStatement: node.statement,
        narrativeRole: mapNodeTypeToNarrativeRole(node.type),
        deadEndReason: node.type === "dead_end" ? node.significance : undefined,
      });
      emit({ type: "effort_created", effortId: synthId, title: node.title, fromSpineNode: node.id });
      continue;
    }

    const effortId = reserveEffortId(slugify(node.title, "node-effort"));
    spineToEffort.set(node.id, effortId);

    const effort: WorkspaceEffortOutput = {
      id: effortId,
      type: mapNodeTypeToEffortType(node.type),
      title: node.title,
      description: node.significance,
      status: mapNodeTypeToStatus(node.type),
      subject: node.statement.slice(0, 200),
      sources: papers.map(paperToResource),
      document,
      tags: buildNodeTags(node, thread),
      difficultyEstimate: estimateNodeDifficulty(node),
      year: node.year,
      era: era?.name,
      spineNodeId: node.id,
      spineThreadId: thread?.id,
      abstract: node.significance,
      formalStatement: node.statement,
      narrativeRole: mapNodeTypeToNarrativeRole(node.type),
      deadEndReason: node.type === "dead_end" ? node.significance : undefined,
    };
    efforts.push(effort);
    await writeEffort(projectDir, workspace, effort);
    emit({ type: "effort_created", effortId, title: node.title, fromSpineNode: node.id });
  }

  // ── 3. Spine Edges → Effort Relations (direct mapping) ──
  for (const edge of spine.edges) {
    const fromEffort = spineToEffort.get(edge.from);
    const toEffort = spineToEffort.get(edge.to);
    if (fromEffort && toEffort && fromEffort !== toEffort) {
      edges.push({
        fromId: fromEffort,
        toId: toEffort,
        relation: mapSpineEdgeToRelation(edge.type),
        description: edge.context,
        confidence: 0.95,
        source: "spine",
      });
    }
  }

  emit({ type: "log", message: `Generated ${efforts.length} efforts, ${edges.length} edges` });
  return { efforts, edges };
}

// ============================================================
//  Helpers
// ============================================================

async function loadPaperMetadata(workspace: string, paperIds: string[]): Promise<PaperMeta[]> {
  // 2026-06-26 (sync-upgrade P1-C): when a paper has an arxivId and
  // we've already fetched the source (cache hit), splice its main
  // .tex content into PaperMeta.fullText so downstream prompts see
  // the real LaTeX rather than a 400-char abstract. We DO NOT fetch
  // on a cache miss here — the spine builder pass earlier in the
  // pipeline already pulled what's needed and we'd rather not
  // double-fetch for the same arxiv id within one run.
  const out: PaperMeta[] = [];
  const PER_PAPER_CAP = 60_000;
  const BATCH_CAP = 200_000;
  let running = 0;
  for (const id of paperIds) {
    const p = await getPaper(workspace, id);
    if (!p) continue;
    let fullText: string | undefined;
    if (p.arxivId && running < BATCH_CAP) {
      try {
        // We pass `force:false` (default) AND skip if cache miss.
        // Loading the marker is cheap; reading 60 KB of .tex is cheap.
        // If the spine builder didn't fetch this id, we still try
        // once here — that's fine because the cache is shared and
        // any subsequent loader pass also benefits.
        const src = await fetchArxivSource(p.arxivId, { workspace });
        if (src.status === "ok" && src.mainTexFile) {
          const raw = await fs.readFile(src.mainTexFile, "utf-8");
          const remaining = Math.max(0, BATCH_CAP - running);
          const limit = Math.min(PER_PAPER_CAP, remaining);
          if (limit > 0) {
            fullText = raw.length > limit ? raw.slice(0, limit) + `\n\n[TRUNCATED at ${limit} bytes; full source at ${src.rootDir}]` : raw;
            running += fullText.length;
          }
        }
      } catch {
        // ignore — abstract is still available
      }
    }
    out.push({
      id: p.id,
      title: p.title,
      authors: p.authors ?? [],
      year: p.year ?? undefined,
      abstract: p.abstract ?? undefined,
      arxivId: p.arxivId ?? undefined,
      doi: p.doi ?? undefined,
      url: p.url ?? undefined,
      fullText,
    });
  }
  return out;
}

/** Load persisted PaperReads for the given paper ids (skips missing). */
async function loadPaperReads(workspace: string, paperIds: string[]): Promise<PaperRead[]> {
  const out: PaperRead[] = [];
  for (const id of paperIds) {
    try {
      const read = await getPaperRead(workspace, id);
      if (read) out.push(read);
    } catch {
      // ignore — a missing/corrupt read just means no notes for that paper
    }
  }
  return out;
}

function paperToResource(paper: PaperMeta): SpineCrawledResource {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    sourceType: paper.arxivId ? "arxiv" : paper.doi ? "journal" : "webpage",
    arxivId: paper.arxivId,
    doi: paper.doi,
    url: paper.url ?? (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : ""),
    abstract: paper.abstract,
  };
}

function mapNodeTypeToEffortType(nodeType: SpineNode["type"]): WorkspaceEffortOutput["type"] {
  switch (nodeType) {
    case "milestone": return "PROOF_ATTEMPT";
    case "technique_origin": return "CONSTRUCTION";
    case "refinement": return "ESTIMATE";
    case "barrier": return "REDUCTION";
    case "bridge": return "CONSTRUCTION";
    case "dead_end": return "PROOF_ATTEMPT";
    case "open_direction": return "AUXILIARY";
    case "foundation": return "AUXILIARY";
    default: return "AUXILIARY";
  }
}

function mapNodeTypeToStatus(nodeType: SpineNode["type"]): WorkspaceEffortOutput["status"] {
  switch (nodeType) {
    case "dead_end": return "DEAD_END";
    case "open_direction": return "DRAFT";
    default: return "VERIFIED";
  }
}

function estimateThreadDifficulty(status: string): WorkspaceEffortOutput["difficultyEstimate"] {
  switch (status) {
    case "dead_end":
    case "stalled":
    case "converged":
      return "HARD";
    default:
      return "MODERATE";
  }
}

function estimateNodeDifficulty(node: SpineNode): WorkspaceEffortOutput["difficultyEstimate"] {
  if (node.type === "dead_end" || node.type === "open_direction" || node.type === "barrier") {
    return "VERY_HARD";
  }
  if (
    node.type === "milestone" ||
    node.type === "technique_origin" ||
    node.type === "bridge" ||
    node.type === "refinement"
  ) {
    return node.depth === "incremental" ? "MODERATE" : "HARD";
  }
  return node.depth === "foundational" ? "MODERATE" : "HARD";
}

export function shouldProcessNodeInFullInit(node: SpineNode): boolean {
  // Shallow-fallback nodes (synthesized when LLM extraction returned 0 LLM
  // candidates) are intentionally marked `depth: "incremental"` to flag their
  // thin provenance, but they are the ONLY material the downstream synthesizers
  // have — without an override they'd be filtered out and every shallow-fallback
  // run would produce 0 efforts and 0 spine citations in the wiki. Caught in
  // dogfood-run-5 (11 nodes survived the fallback; 0 efforts ran).
  if (node.shallowFallback) return true;
  if (node.depth !== "incremental") return true;
  return node.type === "dead_end" || node.type === "open_direction";
}

export function shouldGenerateNodeEffort(node: SpineNode): boolean {
  return (
    node.type === "milestone" ||
    node.type === "technique_origin" ||
    node.type === "barrier" ||
    node.type === "bridge" ||
    node.type === "refinement" ||
    node.type === "dead_end" ||
    node.type === "open_direction"
  );
}

export function buildThreadTags(thread: Pick<SpineThread, "name" | "description" | "currentFrontier" | "barrier">): string[] {
  return uniqueTags([
    ...extractTopicTags(`${thread.name} ${thread.description} ${thread.currentFrontier ?? ""} ${thread.barrier ?? ""}`, 5),
    "reference-survey",
  ]);
}

export function buildNodeTags(node: SpineNode, thread: { name: string } | undefined): string[] {
  return uniqueTags([
    ...extractTopicTags(`${node.title} ${node.statement} ${node.significance} ${thread?.name ?? ""}`, 5),
    node.type.replace(/_/g, "-"),
  ]);
}

function uniqueTags(tags: Array<string | undefined>): string[] {
  return [...new Set(tags.map((tag) => tag?.trim()).filter((tag): tag is string => !!tag))];
}

function extractTopicTags(text: string, limit: number): string[] {
  const withoutCitationLead = text.replace(/^[^:]{1,120}:\s*/, "");
  const lower = withoutCitationLead.toLowerCase();
  const tags: string[] = [];
  const phraseRules: Array<[RegExp, string]> = [
    [/lonely\s+runner|lrc\b/, "lonely-runner"],
    [/diophantine/, "diophantine-approximation"],
    [/covering[-\s]+radi/, "covering-radius"],
    [/view[-\s]+obstruction/, "view-obstruction"],
    [/zonotop/, "zonotopal-geometry"],
    [/polyhed/, "polyhedral-geometry"],
    [/lattice/, "lattice-geometry"],
    [/finite[-\s]+check|bounded[-\s]+speed|bounded\s+search/, "finite-checking"],
    [/comput/, "computational-verification"],
    [/false[-\s]+start|claimed\s+proof|proof[-\s]+barrier/, "proof-barriers"],
    [/counterexample/, "counterexamples"],
    [/shifted/, "shifted-variant"],
    [/free[-\s]+start/, "free-starting"],
    [/time[-\s]+to[-\s]+loneliness|one[-\s]+round/, "time-to-loneliness"],
    [/additive[-\s]+combin/, "additive-combinatorics"],
    [/chromatic/, "chromatic-number"],
    [/spectrum|spectra/, "loneliness-spectrum"],
    [/lower[-\s]+bound|universal\s+lower/, "lower-bounds"],
    [/extremal/, "extremal-examples"],
    [/five\s+runners|six\s+runners|eight\s+runners|nine\s+runners|runner\s+counts/, "finite-runner-counts"],
  ];

  for (const [pattern, tag] of phraseRules) {
    if (pattern.test(lower)) tags.push(tag);
  }

  const stopwords = new Set([
    "about", "after", "again", "against", "barrier", "barriers", "bound", "bridges", "case", "claim",
    "claimed", "claims", "conjecture", "covering", "equivalent", "every", "first", "from",
    "gives", "known", "lonely", "method", "model", "paper", "problem", "proof", "proves", "runner",
    "runners", "setting", "shows", "speed", "speeds", "starts", "statement", "studies", "theorem",
    "thread", "using", "verifies",
  ]);
  const normalized = lower.replace(/\\[a-z]+/g, " ").replace(/[^a-z0-9]+/g, " ");
  for (const token of normalized.split(/\s+/)) {
    if (tags.length >= limit) break;
    if (token.length < 5 || stopwords.has(token)) continue;
    tags.push(slugify(token, token));
  }

  return uniqueTags(tags).slice(0, limit);
}

function mapNodeTypeToNarrativeRole(nodeType: SpineNode["type"]): WorkspaceEffortOutput["narrativeRole"] {
  switch (nodeType) {
    case "foundation": return "background";
    case "milestone": return "core_technique";
    case "technique_origin": return "core_technique";
    case "refinement": return "application";
    case "barrier": return "open_direction";
    case "bridge": return "generalization";
    case "dead_end": return "dead_end";
    case "open_direction": return "open_direction";
    default: return "background";
  }
}

function mapSpineEdgeToRelation(edgeType: SpineEdge["type"]): DependencyEdgeOutput["relation"] {
  switch (edgeType) {
    case "enables": return "depends_on";
    case "improves": return "extends";
    case "generalizes": return "extends";
    case "applies_technique": return "uses";
    case "contradicts": return "contradicts";
    case "reveals_barrier": return "related";
    default: return "related";
  }
}
