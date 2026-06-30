/**
 * Frontier Expansion — find recent papers (post-seed-era) that the agent
 * would otherwise miss because the existing reading-loop only crawls
 * OUTGOING citations (toward the past) + seeds + survey key-refs.
 *
 * Mathematical SOTA on free-tier APIs (Semantic Scholar locked us out
 * 2026, OpenAlex's math citation index too sparse, Crossref math noise too
 * high) leaves arXiv listing as the cleanest signal: cat:math.NT + all:keyword
 * sorted by submittedDate returns peer-quality preprints from the actual
 * math community without crank pollution.
 *
 * Convergence is treated as first-class: an expander either exhausts (no
 * new keep across K consecutive ticks), saturates (hits per-project fetch
 * budget), or returns 0-keep for the round.
 */

import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead, PaperNode } from "../../../paper-graph/types.js";

/**
 * One concept query the extractor produces. Drives ONE arxiv search per
 * tick. Bounded to 3-5 per tick to keep arxiv API load (rate-limited at
 * ~3 req/s) and LLM context window reasonable.
 */
export interface FrontierConcept {
  /** Human-readable label for logs ("circle-method exceptional sets"). */
  label: string;
  /** arxiv `search_query` value, e.g. `cat:math.NT AND all:"exceptional set"`. */
  arxivQuery: string;
  /** Provenance: spine-thesis / spine-thread / read-novel-term / open-question. */
  source: "spine-thesis" | "spine-thread" | "read-novel-term" | "open-question";
}

/**
 * A candidate paper after arxiv fetch + dedup + time filter, BEFORE LLM
 * relevance filtering. Shape mirrors what the LLM filter needs (title +
 * abstract + year) plus the conceptLabel that surfaced it (for debug).
 */
export interface FrontierCandidate {
  arxivId: string;
  title: string;
  authors: string[];
  year: number;
  abstract: string;
  /** Which concept query surfaced this candidate (for log + debug). */
  fromConcept: string;
}

/**
 * Verdict from the LLM relevance filter for one candidate. `priorityBand`
 * lets the LLM nudge follow-ups it thinks are directly relevant up the queue.
 */
export interface FrontierVerdict {
  arxivId: string;
  decision: "keep" | "skip";
  reason: string;
  /** Optional priority hint — defaults to "harvest" when omitted. */
  priorityBand?: "essential" | "supporting" | "passing";
}

/**
 * What the expander returns per tick. The reading-loop uses
 * `addedCount` (= number of "keep" verdicts after dedup) for K-empty
 * convergence detection and `exhausted` as an absolute stop signal
 * (e.g. fetch budget hit, all concepts saturated).
 *
 * `kept` carries the actual paper info the reading-loop needs to ingest
 * and enqueue (the expander has already fetched the metadata; the loop
 * just needs to ingestPaper(...) and push at PRIORITY_FRONTIER).
 */
export interface FrontierExpansionResult {
  /** Total papers the LLM verdict marked "keep" this tick. */
  addedCount: number;
  /** Concepts run + their per-concept add count, for log. */
  perConcept: Array<{ concept: string; fetched: number; kept: number }>;
  /** True when expander wants to stop being called for the rest of the run. */
  exhausted: boolean;
  /** Why exhausted (for log / reporting). */
  exhaustionReason?: "fetch-budget-exceeded" | "all-concepts-empty" | "no-concepts";
  /**
   * Papers to ingest + enqueue. Already deduplicated against the input's
   * alreadyQueued / alreadyRead sets + LLM-judged "keep". Reading-loop
   * iterates and calls its internal ingest + push helpers.
   */
  kept: Array<{ candidate: FrontierCandidate; verdict: FrontierVerdict }>;
}

/**
 * Input to an expansion tick. Snapshotted by the reading-loop just before
 * calling the expander.
 */
export interface FrontierExpansionInput {
  /** Papers fully read so far (post-distillation). */
  readPapers: PaperRead[];
  /**
   * PaperNode metadata for the read papers, indexed by paperId. The
   * reading-loop already caches these in `nodeById` — passing them through
   * gives the concept extractor access to `categories` (for arxiv cat:
   * scoping) and the relevance filter access to title/year.
   */
  readNodesById: Map<string, PaperNode>;
  /** Spine at this moment (built incrementally during read_and_explore). */
  spine: NarrativeSpine | null;
  /** Papers already queued (so the expander doesn't push duplicates). */
  alreadyQueuedArxivIds: Set<string>;
  /** Papers already read (same dedup constraint). */
  alreadyReadArxivIds: Set<string>;
}

/**
 * The expander seam itself. The reading-loop holds one of these in
 * `deps.expandFrontier` and calls it on the post-replan tick. The
 * expander returns `kept` candidates; the reading-loop is responsible
 * for ingesting them into the paper-graph and pushing into its queue.
 */
export type ExpandFrontierFn = (
  input: FrontierExpansionInput,
) => Promise<FrontierExpansionResult>;

/**
 * Convergence + budget constants. Centralized so tests can override.
 */
export const FRONTIER_MAX_FETCHES_DEFAULT = 200;
export const FRONTIER_MAX_CONCEPTS_PER_TICK = 5;
export const FRONTIER_MAX_RESULTS_PER_CONCEPT = 15;
export const FRONTIER_YEAR_WINDOW_DEFAULT = 3;
export const FRONTIER_K_EMPTY_TO_EXHAUST = 3;

/**
 * Priority slot for frontier-found papers in the reading-loop queue.
 * Centralized here (rather than the reading-loop reading-loop's PRIORITY_*
 * block) so this module owns the design value. Ranks just above harvest
 * (which is sub-1e6) and below user seeds (1e9): the frontier is "fresh
 * but speculative" — strong enough to be looked at, weak enough not to
 * preempt canonical landmarks.
 */
export const PRIORITY_FRONTIER = 1e7;
