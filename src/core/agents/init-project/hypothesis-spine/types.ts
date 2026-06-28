/**
 * Hypothesis-spine types (Layer 3 — narrative-ordering-design.md §4).
 *
 * A HypothesisSpine is what the LLM EXPECTS the field's spine to look like,
 * built from problem + canon + survey distillations BEFORE the reading loop
 * runs. Each node carries:
 *   - the same shape as a SpineNode (title / statement / significance / …)
 *   - a `confidence` band ("hypothesis" until reads confirm/refine/falsify)
 *   - `expectedPaperIds` — the canon / survey papers the LLM expects to
 *     justify this node. Reading-loop uses this to bias its reading order.
 *
 * After the reading-loop and build-spine produce a real NarrativeSpine,
 * reconcileSpines() merges them: hypothesis nodes get tagged
 * `confidence: "verified" | "refined" | "falsified"` based on whether their
 * expectedPaperIds were actually read + whether the real spine kept the
 * node's statement essentially intact.
 */

import type { SpineEdge, SpineEra, SpineNode, SpineThread } from "../spine/types.js";

/** Confidence in a hypothesis spine node, tracked across reconcile. */
export type HypothesisConfidence =
  | "hypothesis"   // emitted by the LLM before any reads; unverified.
  | "verified"     // a real spine node matches and the expected papers were read.
  | "refined"      // a real spine node matches but the statement was sharpened.
  | "falsified"    // no real spine node matches OR expected papers were rejected.
  | "unread";      // expected papers were never reached (reading converged early).

export interface HypothesisSpineNode extends Omit<SpineNode, "paperIds" | "effortIds"> {
  /** Papers the LLM expected to ground this node. */
  expectedPaperIds: string[];
  /** Confidence band; set "hypothesis" at build time, updated by reconcile. */
  confidence: HypothesisConfidence;
  /** If reconcile matched this hypothesis to a real spine node, the real id. */
  matchedSpineNodeId?: string;
  /** Reconciliation rationale (1-2 sentences explaining the verdict). */
  reconcileNote?: string;
}

/**
 * A hypothesis spine. Mirrors NarrativeSpine but with hypothesis-flavoured
 * nodes + a build provenance for the run report.
 */
export interface HypothesisSpine {
  globalThesis: string;
  nodes: HypothesisSpineNode[];
  eras: SpineEra[];
  edges: SpineEdge[];
  threads: SpineThread[];
  /** Open questions the hypothesis raises. */
  openQuestions: Array<{ title: string; statement: string; relatedNodeIds: string[]; barrier?: string; partialProgress?: string }>;
  /** ISO timestamp the hypothesis was built. */
  builtAt: string;
  /** What ground truth fed the hypothesis: canon ids + survey paper ids. */
  builtFrom: { canonIds: string[]; surveyPaperIds: string[] };
}

/** Empty hypothesis (returned when build fails or no canon/surveys available). */
export const EMPTY_HYPOTHESIS_SPINE: HypothesisSpine = {
  globalThesis: "",
  nodes: [],
  eras: [],
  edges: [],
  threads: [],
  openQuestions: [],
  builtAt: "1970-01-01T00:00:00.000Z",
  builtFrom: { canonIds: [], surveyPaperIds: [] },
};

/**
 * Per-node reconciliation result, surfaced in the run report and used by the
 * agent to log "your hypothesis was N% verified / N% refined / N% falsified".
 */
export interface SpineReconciliationSummary {
  totalHypothesisNodes: number;
  verified: number;
  refined: number;
  falsified: number;
  unread: number;
  /** Per-node details for the run report. */
  details: Array<{
    hypothesisId: string;
    hypothesisTitle: string;
    confidence: HypothesisConfidence;
    matchedSpineNodeId?: string;
    note?: string;
  }>;
}
