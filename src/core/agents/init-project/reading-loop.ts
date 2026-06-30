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
  EMPTY_PLAN as RP_EMPTY_PLAN,
  REPLAN_CADENCE_DEFAULT as RP_REPLAN_CADENCE_DEFAULT,
  nextPlannedPaperId as rpNextPlannedPaperId,
} from "./reading-plan/index.js";
import {
  getPaper,
  ingestPaper,
  paperGraphDir,
  associatePaperToProject,
  type PaperNodeInput,
} from "../../paper-graph/index.js";
import { deletePaperRead, writePaperRead } from "../../paper-graph/reads.js";
import { readPaper as realReadPaper, type ReadPaperCtx, type PriorReadSummary } from "./reader/index.js";
import { PRIORITY_FRONTIER, FRONTIER_K_EMPTY_TO_EXHAUST } from "./frontier-expansion/types.js";
import type {
  FrontierCandidate,
  FrontierVerdict,
} from "./frontier-expansion/types.js";
import { buildSurveyDistillationPrompt } from "./reading-loop-prompts.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ── PriorArtCorpus (DESIGN-REFERENCE §3.3) ───────────────────────────────────
// Re-exported from prior-art/index.ts so there is ONE source of truth. This
// used to be a separate local copy (with subtly different `source` enums and
// no `rawHit` field) bridged via `as PriorArtCorpus` casts in agent.ts — a
// silent source of drift bugs every time someone added a field to one side
// but not the other. Unified 2026-06-27 per 子鱼's structural cleanup request.
export type { PriorArtCorpus } from "./prior-art/index.js";
import type { PriorArtCorpus } from "./prior-art/index.js";

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
  /**
   * Layer 2 (2026-06-28) — optional planner-driven reading order. When
   * supplied, the loop pops the next planned paperId ahead of the bare
   * priority queue. A null `plan` or an exhausted plan falls back to the
   * priority queue. See reading-plan/ for the planner.
   */
  plan?: import("./reading-plan/index.js").ReadingPlan;
  /**
   * Layer 2 — when supplied, the loop calls back into the planner every
   * `replanCadence` reads (default REPLAN_CADENCE_DEFAULT) so it can refine
   * the plan based on what was just read + what was just harvested.
   *
   * The callback receives the current set of read paperIds and the current
   * queue; it returns a new plan (or the same plan unchanged when nothing
   * needs to change). Throwing here is non-fatal: the loop logs + carries on
   * with the prior plan.
   */
  replan?: (args: {
    readPaperIds: string[];
    queuedPaperIds: string[];
    previousPlan: import("./reading-plan/index.js").ReadingPlan;
  }) => Promise<import("./reading-plan/index.js").ReadingPlan>;
  /** Re-plan after every N reads. Defaults to REPLAN_CADENCE_DEFAULT. */
  replanCadence?: number;

  /**
   * 2026-06-30 — Layer 3: Frontier expansion. When supplied, the loop
   * calls `expandFrontier` every `frontierCadence` reads (default same as
   * replanCadence) to discover recent arXiv preprints that the seed +
   * citation crawl might miss. The expander pushes new papers into the
   * reading queue at PRIORITY_FRONTIER via the loop's internal `push()`.
   *
   * Convergence: the loop stops calling `expandFrontier` once either:
   *   - the expander returns `exhausted: true` (fetch budget hit /
   *     no concepts available), or
   *   - the expander returns `addedCount: 0` for FRONTIER_K_EMPTY_TO_EXHAUST
   *     consecutive ticks (sustained "nothing new found" signal).
   *
   * Failure-isolated: any throw → log + carry on with the current queue
   * (the loop's other discovery channels still work).
   */
  expandFrontier?: import("./frontier-expansion/index.js").ExpandFrontierFn;
  /** Snapshot of the spine at the moment of each frontier tick. */
  getCurrentSpine?: () => import("./spine/types.js").NarrativeSpine | null;
  /** Frontier expansion cadence (reads). Defaults to replanCadence. */
  frontierCadence?: number;
}

export interface ReadingLoopUnresolvedCitation {
  citedTitle?: string;
  citedAuthors?: string[];
  citedYear?: number;
  whyImportant: string;
  attemptedResolutions: string[];
  status: "unresolved";
  /**
   * When Crossref returned a hit (DOI / venue), populate these so the run
   * report can split "fully unresolved" from "DOI-only, fetchable from
   * publisher". Mirrors the unresolvedCanonicalLandmarks doiOnly/unresolved
   * split in the report.
   */
  doi?: string;
  venue?: string;
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
  /**
   * 2026-06-30 — Frontier expansion summary, when an expander was wired.
   * Tracks how many ticks ran, how many papers were added, and why the
   * expander stopped being called. Absent when no expander was wired.
   */
  frontierExpansion?: {
    ticksRun: number;
    totalAdded: number;
    convergence: "k-empty" | "exhausted" | "still-active";
    exhaustionReason?: "fetch-budget-exceeded" | "all-concepts-empty" | "no-concepts";
  };
}

export interface ReadingLoopDeps {
  fetchArxivById?: typeof import("./crawlers.js").fetchArxivById;
  searchArxivByTitle?: (
    query: string,
    max: number,
  ) => Promise<Array<{ arxivId: string; title: string; authors: string[]; year?: number; abstract?: string }>>;
  /**
   * Fallback resolver for harvested citations that arxiv title search couldn't
   * find. Defaults to {@link defaultCrossrefSearch} from canonical-landmarks-
   * search (the same client that pre-arxiv canon resolution uses). Tests can
   * inject a stub; pass `() => Promise.resolve([])` to disable the fallback.
   *
   * Why: dogfood-run-d79c820c42b7 left 55 unresolvedCitations, almost all of
   * which were real `\\ref{lmm:...}` references to pre-arxiv classics
   * (1973/1937/older Springer reprints / French/Russian originals) that
   * arxiv simply doesn't index. Crossref does — without this fallback the
   * report buries the references as "unresolved" and the wiki bibliography
   * is forced to invent or omit them.
   */
  searchCrossref?: import("./prior-art/canonical-landmarks-search.js").CrossrefSearchFn;
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

// Priority bands. Canon (LLM-named landmark papers) outrank user-supplied seeds
// because canon represents the field's historical baseline a researcher MUST
// see first; surveys outrank canon because a survey of a problem subsumes the
// "what should I read first" question. Survey ≻ canon ≻ seed ≻ survey-keyref ≻ harvest.
const PRIORITY_SURVEY = 1e12;
const PRIORITY_CANON = 5e11;
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
  /**
   * Publication year, when known. Used as a SECONDARY sort key after
   * priority — within the same priority band, earlier papers are read first
   * so the reader sees the methodological lineage in the order it actually
   * unfolded (Brun 1920 → Selberg 1950 → Chen 1973, not "Chen first because
   * the LLM happened to list it first in the canon array"). Missing year
   * sorts AFTER all dated entries so we still make forward progress.
   */
  year?: number;
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
  // Lazy-import the real Crossref client (kept lazy because it's only used
  // when an arxiv title search misses, which is the rare path; avoiding the
  // import keeps the cold-start cost on the happy path unchanged).
  const searchCrossref =
    deps.searchCrossref ??
    (async (q) => {
      const { defaultCrossrefSearch } = await import("./prior-art/canonical-landmarks-search.js");
      return defaultCrossrefSearch(q);
    });
  const K = CONVERGENCE_K_DEFAULT;

  const queue: QueueEntry[] = [];
  const queued = new Set<string>();
  const reads = new Map<string, PaperRead>();
  // Cache PaperNode metadata for each read paper so we can construct
  // lineage context (priorReads) for the next read without re-hitting disk.
  // 层 0 (2026-06-27 narrative-ordering): the reader sees what it has already
  // absorbed so it can frame the current paper as a step in the story.
  const nodeById = new Map<string, PaperNode>();
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
    push({ paperId: s.paperId, why: `survey: ${s.why}`, priority: PRIORITY_SURVEY, year: s.year });
  }
  // Canonical landmarks resolved to arxiv (Chen 1973-class papers the LLM named
  // and Crossref/arxiv resolved). These outrank user seeds: a user seed is
  // whatever they happened to know about; a canon entry is what the field
  // collectively considers required reading.
  for (const lm of config.priorArt?.canonicalLandmarks ?? []) {
    if (!lm.arxivId) continue;
    push({
      paperId: lm.arxivId,
      why: `canonical landmark: ${lm.why}`,
      priority: PRIORITY_CANON,
      year: lm.year,
    });
  }
  for (const seedId of config.seedPaperIds) {
    // Seeds were already ingested before reading-loop started, so their
    // PaperNode is on disk — fetch year for the chronological tiebreaker.
    // Missing node (race / not-yet-ingested) just leaves year undefined.
    const seedNode = await getPaper(config.workspace, seedId);
    push({
      paperId: seedId,
      why: "user-confirmed seed",
      priority: PRIORITY_SEED,
      year: seedNode?.year,
    });
  }
  // Expository MO/SE answers are URLs, not papers (§7.1) — only enqueue if an
  // arxiv id is resolvable. We have no URL→arxiv resolver here, so they are
  // recorded as context only and skipped from the paper queue.
  for (const ans of config.priorArt?.expositoryAnswers ?? []) {
    log(`[reading-loop] expository answer noted (not enqueued, no arxiv id): ${ans.url}`);
  }

  const canonCount = (config.priorArt?.canonicalLandmarks ?? []).filter((l) => l.arxivId).length;
  log(
    `[reading-loop] start: ${queue.length} initial candidates ` +
      `(${config.priorArt?.surveys.length ?? 0} surveys, ${canonCount} canon, ${config.seedPaperIds.length} seeds), K=${K}`,
  );

  // ── Main loop ──────────────────────────────────────────────────────────────
  let reason: ReadingLoopResult["convergence"]["reason"] = "queue_exhausted";

  // Layer 2: plan + replan bookkeeping. `currentPlan` evolves across the run
  // — set from config.plan at start, then replaced by each successful replan
  // callback. `readsSinceReplan` triggers the next callback. We do NOT short-
  // circuit convergence on plan-exhaustion (the queue may still hold useful
  // harvest the planner ignored on purpose); the existing K-empty convergence
  // and circuit breaker still gate exit.
  const replanCadenceCfg = Math.max(1, config.replanCadence ?? RP_REPLAN_CADENCE_DEFAULT);
  let currentPlan: import("./reading-plan/index.js").ReadingPlan = config.plan ?? RP_EMPTY_PLAN;
  let readsSinceReplan = 0;

  // 2026-06-30 — Frontier expansion state.
  // `frontierCadenceCfg` defaults to replanCadence so by default frontier
  // runs right after replan (one tick → both fire on the same K-read boundary).
  // `frontierKEmptyStreak` counts consecutive 0-add ticks; when it reaches
  // FRONTIER_K_EMPTY_TO_EXHAUST we stop calling the expander for the rest
  // of the run (convergence: the spine isn't producing concepts that hit
  // arxiv).
  // `frontierStopped` is set true once we've stopped calling expandFrontier
  // for ANY reason (k-empty, exhausted return, or no expander wired).
  const frontierCadenceCfg = Math.max(1, config.frontierCadence ?? replanCadenceCfg);
  let readsSinceFrontier = 0;
  let frontierTicksRun = 0;
  let frontierTotalAdded = 0;
  let frontierKEmptyStreak = 0;
  let frontierStopped = config.expandFrontier == null;
  let frontierExhaustionReason: "fetch-budget-exceeded" | "all-concepts-empty" | "no-concepts" | undefined;

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

    // Layer 2: if a plan exists and proposes a paperId currently in the
    // queue, honour it. Otherwise fall back to the bare priority pick.
    let bestIdx = -1;
    const plannedPaperId = currentPlan.narrativeArcs.length > 0
      ? rpNextPlannedPaperId(currentPlan, new Set(reads.keys()))
      : null;
    if (plannedPaperId) {
      const idx = queue.findIndex((c) => c.paperId === plannedPaperId);
      if (idx >= 0) {
        bestIdx = idx;
        log(`[reading-loop] plan v${currentPlan.planVersion} → pop "${plannedPaperId}"`);
      }
    }
    if (bestIdx < 0) {
      // Pick the highest-priority candidate; within the same priority band,
      // pick the EARLIEST year (Brun 1920 before Chen 1973 within `canon`).
      // Missing year sorts last so it never starves a dated entry.
      bestIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        const cand = queue[i];
        const best = queue[bestIdx];
        if (cand.priority > best.priority) {
          bestIdx = i;
        } else if (cand.priority === best.priority) {
          const candYear = cand.year ?? Number.POSITIVE_INFINITY;
          const bestYear = best.year ?? Number.POSITIVE_INFINITY;
          if (candYear < bestYear) bestIdx = i;
        }
      }
    }
    const candidate = queue.splice(bestIdx, 1)[0];
    queued.delete(candidate.paperId);

    // Load (or ingest) the paper node.
    const node = await loadOrIngestNode(workspace, candidate.paperId, fetchArxivById, log);
    if (!node) {
      log(`[reading-loop] could not load/ingest "${candidate.paperId}" — skipping`);
      continue;
    }
    nodeById.set(candidate.paperId, node);

    // Attach this paper to the project so downstream UI / `mathran project
    // papers` / wiki bibliography see every paper we actually engaged with,
    // not just the user-supplied seeds. Run-d79c820c42b7 caught the gap: 21
    // reads + 33 ingested papers, but only 3 entries in associations.jsonl
    // because the v3 reading-loop never called this — only the legacy v1
    // arxiv-crawl path did, and it doesn't run in v3.
    // Best-effort: a failure here is not worth aborting the read for.
    try {
      // Coarse discovery taxonomy based on priority band.
      const discoveredBy =
        candidate.priority >= PRIORITY_SEED
          ? "seed"
          : candidate.priority >= PRIORITY_SURVEY_KEYREF
            ? "survey-keyref"
            : "harvest";
      await associatePaperToProject(config.projectDir, candidate.paperId, {
        discoveredBy,
        depth: candidate.priority >= PRIORITY_SEED ? 0 : 1,
        relevanceScore: candidate.priority >= PRIORITY_CANON ? 1 : 0.6,
      });
    } catch (err) {
      log(`[reading-loop] associatePaperToProject(${candidate.paperId}) failed: ${errMsg(err)}`);
    }

    // Defensively flag surveys (should already be set during prior-art ingest).
    const isSurvey = node.isSurvey || surveyConfidence.has(candidate.paperId);

    // Build the lineage context (priorReads) from everything read so far so the
    // reader can frame the current paper relative to its predecessors. 12-cap +
    // chronological sort applied inside buildPriorReadsBlock at the prompt layer.
    const priorReads: PriorReadSummary[] = [];
    for (const [pid, r] of reads.entries()) {
      const pNode = nodeById.get(pid);
      priorReads.push({
        paperId: pid,
        title: pNode?.title ?? r.paperId,
        firstAuthor: pNode?.authors?.[0] ?? "",
        year: pNode?.year,
        oneLineSummary: r.skim?.oneLineSummary ?? "",
        mainContribution: r.skim?.mainContribution,
      });
    }

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
      priorReads,
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

    // ── Off-topic papers are KEPT but NOT harvested. Treat as empty-novelty.  ─
    // (Audit determined the paper is internally fine but unrelated to the
    // project's target problem — descending its citation graph would walk into
    // an unrelated field. Keep the read so the user can see what was visited;
    // skip survey distillation, skip biblio harvest, and count this round as
    // empty so the convergence-K can trip and stop the off-topic walk.)
    if (read.audit?.verdict === "off_topic") {
      // Same logic as the post-harvest novelty check below: off_topic on a
      // harvest candidate IS a signal that the citation walk has drifted out
      // of scope and should converge. Off_topic on an INITIAL candidate
      // (survey/canon/seed) means the user (or canon LLM) misjudged the
      // paper's relevance — we shouldn't punish the rest of the queue for it.
      const isHarvestCandidate = candidate.priority < PRIORITY_SEED;
      if (isHarvestCandidate) consecutiveEmptyRounds++;
      const flagStr = read.audit.flags?.length ? ` [${read.audit.flags.join(",")}]` : "";
      emit({
        type: "log",
        message: `[reading-loop] paper_off_topic: "${node.title}"${flagStr} — kept, no harvest (consecutiveEmptyRounds=${consecutiveEmptyRounds}/${K}, initialBand=${!isHarvestCandidate})`,
      });
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
          if (refId) push({ paperId: refId, why: `survey key reference: ${ref.whyTheSurveyHighlighted}`, priority: PRIORITY_SURVEY_KEYREF, year: ref.year });
        }
      }
    }

    // ── Novelty check. ────────────────────────────────────────────────────────
    // Convergence (consecutiveEmptyRounds) tracks "harvest exploration has run
    // dry", NOT "the initial well-curated queue is uninteresting". Initial
    // candidates (surveys, canon, seeds — anything with priority >= PRIORITY_SEED)
    // should ALWAYS be read regardless of their novelty contribution. Otherwise
    // a survey or abstract-only canon entry that legitimately has 0 outgoing
    // citations can trip the K=3 timer and kill the loop while 4 untouched
    // canon/seed entries are still sitting in the queue.
    //
    // Caught in dogfood-run-11 (2026-06-27): chronological tiebreaker pulled
    // Montgomery 1975 (abstract-only, 0 citations) ahead of Helfgott 2013;
    // 3 reads in a row with 0 novel citations → premature `natural` convergence,
    // 4 papers left unread. Pre-tiebreaker runs got lucky because Helfgott
    // happened to be read first and its 138 citations flooded the queue.
    const isHarvestCandidate = candidate.priority < PRIORITY_SEED;
    if (isHarvestCandidate) {
      if (isNovelty(read)) {
        consecutiveEmptyRounds = 0;
      } else {
        consecutiveEmptyRounds++;
      }
    } else {
      // Initial candidate consumed — explicitly reset so a streak of empty
      // harvest rounds before this one doesn't carry over.
      consecutiveEmptyRounds = 0;
    }
    emit({
      type: "log",
      message: `[reading-loop] convergence_check: consecutiveEmptyRounds=${consecutiveEmptyRounds}/${K}, reads=${reads.size}, initialBand=${!isHarvestCandidate}`,
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
          push({ paperId: citedId, why: citation.contextInThisPaper, priority, year: citation.citedYear });
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
            push({ paperId: citedId, why: citation.contextInThisPaper, priority, year: citation.citedYear });
          }
          continue;
        }
        // Arxiv missed — try Crossref before giving up. dogfood-run-
        // d79c820c42b7 had 55 unresolved citations, most pre-arxiv classics
        // that Crossref indexes (Chen 1973, Vinogradov 1937, Springer reprints,
        // foreign-language originals). Crossref only gives us a DOI + title,
        // no PDF — so we CANNOT push it into the read queue (no source to
        // skim/read/audit). What we CAN do is record the resolution in
        // attemptedResolutions so the run report can surface "55 unresolved
        // — of which 30 have a DOI you can fetch from the venue" instead of
        // a blanket "55 unresolved" with no path forward.
        const attempted = ["arxiv: 0 hits"];
        let resolvedDoi: string | undefined;
        let resolvedAuthors: string[] | undefined;
        let resolvedYear: number | undefined;
        let resolvedVenue: string | undefined;
        try {
          const crossrefHits = await searchCrossref({
            title: citation.citedTitle,
            author: citation.citedAuthors?.[0],
            rows: 3,
          });
          if (crossrefHits.length > 0) {
            const top = crossrefHits[0]!;
            resolvedDoi = top.doi;
            resolvedAuthors = top.authors.length > 0 ? top.authors : undefined;
            resolvedYear = top.year;
            resolvedVenue = top.venue;
            attempted.push(`crossref: doi=${top.doi}`);
          } else {
            attempted.push("crossref: 0 hits");
          }
        } catch (err) {
          attempted.push(`crossref: error (${errMsg(err)})`);
        }
        unresolved.push({
          citedTitle: citation.citedTitle,
          citedAuthors: resolvedAuthors ?? citation.citedAuthors,
          citedYear: resolvedYear ?? citation.citedYear,
          whyImportant: citation.contextInThisPaper,
          attemptedResolutions: attempted,
          status: "unresolved",
          ...(resolvedDoi ? { doi: resolvedDoi } : {}),
          ...(resolvedVenue ? { venue: resolvedVenue } : {}),
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

    // Layer 2 — re-plan tick. Fire AFTER harvest (so the planner sees the
    // newly-ingested candidates) but BEFORE the next pop. config.replan is
    // optional; absent it the plan never changes after construction.
    readsSinceReplan++;
    if (config.replan && readsSinceReplan >= replanCadenceCfg) {
      readsSinceReplan = 0;
      try {
        const next = await config.replan({
          readPaperIds: Array.from(reads.keys()),
          queuedPaperIds: queue.map((q) => q.paperId),
          previousPlan: currentPlan,
        });
        // Only adopt the new plan if it actually differs (planVersion changed)
        // so a no-op replan call doesn't churn logs.
        if (next.planVersion !== currentPlan.planVersion) {
          currentPlan = next;
        }
      } catch (err) {
        log(`[reading-loop] replan callback failed (${errMsg(err)}) — carry v${currentPlan.planVersion}`);
      }
    }

    // 2026-06-30 — Layer 3: Frontier expansion tick. Fires AFTER replan
    // so the expander sees the latest plan + spine. Skipped once
    // frontierStopped is true (K-empty / exhausted / not wired).
    readsSinceFrontier++;
    if (!frontierStopped && config.expandFrontier && readsSinceFrontier >= frontierCadenceCfg) {
      readsSinceFrontier = 0;
      try {
        const spine = config.getCurrentSpine?.() ?? null;
        const result = await config.expandFrontier({
          readPapers: Array.from(reads.values()),
          readNodesById: nodeById,
          spine,
          alreadyQueuedArxivIds: new Set(
            queue
              .map((q) => nodeById.get(q.paperId)?.arxivId)
              .filter((id): id is string => typeof id === "string"),
          ),
          alreadyReadArxivIds: new Set(
            Array.from(reads.values())
              .map((r) => r.arxivId)
              .filter((id): id is string => typeof id === "string"),
          ),
        });
        frontierTicksRun++;

        // Ingest each kept candidate into the paper-graph (so it has a real
        // paperId), then push at PRIORITY_FRONTIER + the LLM-suggested
        // importance bucket (essential/supporting/passing → fine-grained
        // sub-priority within the FRONTIER band).
        let actuallyPushed = 0;
        for (const { candidate, verdict } of result.kept) {
          const paperId = await ingestArxiv(
            config.workspace,
            candidate.arxivId,
            candidate.title,
            candidate.authors,
            candidate.year,
            fetchArxivById,
            log,
            candidate.abstract,
          );
          if (!paperId) continue;
          const band = verdict.priorityBand ?? "passing";
          const importance = IMPORTANCE_PRIORITY[band] ?? IMPORTANCE_PRIORITY.passing;
          push({
            paperId,
            why: `frontier (${candidate.fromConcept}): ${verdict.reason}`,
            priority: PRIORITY_FRONTIER + importance,
            year: candidate.year,
          });
          // 2026-06-30 — Cache the newly-ingested PaperNode into nodeById
          // immediately. Without this, the NEXT frontier tick computes
          // alreadyQueuedArxivIds via `nodeById.get(pid)?.arxivId` and misses
          // the paper we just pushed (because the reader hasn't popped it yet
          // to populate nodeById at line 400). Frontier's own seenAcrossTicks
          // set catches the duplicate at arxiv-fetch time, so correctness is
          // preserved either way, but caching here saves a redundant arxiv
          // round-trip + a wasted LLM relevance verdict.
          try {
            const node = await getPaper(config.workspace, paperId);
            if (node) nodeById.set(paperId, node);
          } catch (err) {
            log(`[reading-loop] frontier: cache nodeById for ${paperId} failed: ${errMsg(err)}`);
          }
          actuallyPushed++;
        }
        frontierTotalAdded += actuallyPushed;

        // Convergence: K-empty streak based on what the LLM kept (NOT what
        // we actually pushed — push can fail to dedup-by-paperId but that
        // still means the expander "found something new"). Using
        // result.addedCount here so an LLM-kept paper that ingest fails to
        // create still counts as forward progress.
        if (result.addedCount === 0) {
          frontierKEmptyStreak++;
          if (frontierKEmptyStreak >= FRONTIER_K_EMPTY_TO_EXHAUST) {
            log(
              `[reading-loop] frontier: K-empty streak hit ${frontierKEmptyStreak} — ` +
                `stopping expansion (converged on current spine)`,
            );
            frontierStopped = true;
            if (!frontierExhaustionReason) frontierExhaustionReason = "all-concepts-empty";
          }
        } else {
          frontierKEmptyStreak = 0;
        }
        if (result.exhausted) {
          log(`[reading-loop] frontier: expander reported exhausted (${result.exhaustionReason ?? "unknown"})`);
          frontierStopped = true;
          frontierExhaustionReason = result.exhaustionReason;
        }
      } catch (err) {
        log(`[reading-loop] frontier callback failed (${errMsg(err)}) — disabling for the rest of the run`);
        frontierStopped = true;
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
    // Frontier summary — undefined when no expander was wired so existing
    // callers that don't know about frontier expansion see no extra field.
    ...(config.expandFrontier
      ? {
          frontierExpansion: {
            ticksRun: frontierTicksRun,
            totalAdded: frontierTotalAdded,
            convergence: (frontierStopped
              ? frontierExhaustionReason === "fetch-budget-exceeded" ||
                frontierExhaustionReason === "no-concepts"
                ? "exhausted"
                : "k-empty"
              : "still-active") as "k-empty" | "exhausted" | "still-active",
            ...(frontierExhaustionReason ? { exhaustionReason: frontierExhaustionReason } : {}),
          },
        }
      : {}),
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
    // No maxTokens override — survey distillation emits a JSON tree with
    // potentially long arrays (coveredSubAreas, keyReferences with whyHighlighted
    // text, surveyOutline). A 30+ heading survey can blow past 2500 mid-array
    // and the JSON parser then drops the whole distillation silently (returns
    // null). Same fix class as spine/wiki/reviewer maxTokens drops.
    const raw = await llm(prompt, { temperature: 0 });
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
