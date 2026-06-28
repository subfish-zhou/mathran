/**
 * Reading-plan types (Layer 2 — narrative-ordering-design.md §3).
 *
 * A ReadingPlan is a *sequenced reading arc* over a candidate set, grouped
 * into NarrativeArcs. Each step in an arc names a specific paper plus the
 * `purpose` for reading it at that point. The reading-loop pops next-in-plan
 * candidates ahead of the bare priority queue, so the loop's ORDER of reads
 * tracks the LLM's understanding of the field's lineage, not the queue's
 * heuristic priority bands.
 *
 * A plan is re-evaluated every N reads (REPLAN_CADENCE_DEFAULT) so harvest
 * results can join arcs or open new ones. Failure of a re-plan call is
 * non-fatal: the prior plan stays in effect.
 */

/** One step in a narrative arc: read THIS paper next FOR this reason. */
export interface ReadingPlanStep {
  paperId: string;
  /** Why THIS paper at THIS point in the arc. 1-2 sentences max. */
  purpose: string;
}

/** A coherent reading sub-arc within a plan. */
export interface NarrativeArc {
  /** Human-readable arc name. Verb-shape preferred ("Trace the sieve lineage from Brun to Chen"). */
  name: string;
  /** 1-2 sentence justification for the arc itself. */
  rationale: string;
  /** Steps in the order the LLM wants them read. */
  steps: ReadingPlanStep[];
}

export interface ReadingPlan {
  /** Arcs, in suggested reading order (read all of arc 1, then arc 2, …). */
  narrativeArcs: NarrativeArc[];
  /** Total reads the plan expects (sum of step counts; cap-aware). */
  expectedTotalReads: number;
  /** Open questions the plan is trying to answer. Informational; not consumed by the loop. */
  openQuestions: string[];
  /**
   * The plan version (1, 2, 3…). Each re-plan call bumps this so logs / report
   * data can correlate reads with the plan iteration that pulled them.
   */
  planVersion: number;
  /** ISO timestamp the plan was produced. */
  producedAt: string;
}

/** Empty plan (used when no planner has run yet). */
export const EMPTY_PLAN: ReadingPlan = {
  narrativeArcs: [],
  expectedTotalReads: 0,
  openQuestions: [],
  planVersion: 0,
  producedAt: "1970-01-01T00:00:00.000Z",
};

/** Default cadence: re-plan after every N reads. */
export const REPLAN_CADENCE_DEFAULT = 3;

/** Cap on the planner's expectedTotalReads (avoid hour-long plans). */
export const PLAN_EXPECTED_READS_CAP = 25;
