/**
 * Pure (React-free) helpers for the InitAgentProgress dashboard. Kept separate
 * from the component so they can be unit-tested under the root vitest config
 * without pulling in `react`.
 */

export type InitPhase =
  | "seed_research"
  | "deep_crawl"
  | "build_wiki"
  | "explore_graph"
  | "build_spine"
  | "build_efforts"
  | "spine_wiki"
  | "review_refine"
  | "verify"
  | "link_review"
  | "completeness_check"
  | "completed"
  | "error";

const V1A_ORDER: InitPhase[] = [
  "seed_research",
  "deep_crawl",
  "build_wiki",
  "review_refine",
  "verify",
  "link_review",
  "completeness_check",
  "completed",
];

const SPINE_ORDER: InitPhase[] = [
  "explore_graph",
  "build_spine",
  "build_efforts",
  "spine_wiki",
  "review_refine",
  "verify",
  "link_review",
  "completeness_check",
  "completed",
];

/** Ordered phase list for the given pipeline mode. */
export function getPhaseOrder(mode: "v1a" | "spine"): InitPhase[] {
  return mode === "v1a" ? [...V1A_ORDER] : [...SPINE_ORDER];
}

/**
 * Status of `target` relative to the run's `current` phase within `order`.
 * Phases before the current one are "past", the current one is "current", and
 * anything after (or not in the order) is "future". An `error` current phase
 * marks every other phase as "future" (the run halted).
 */
export function getPhaseStatus(
  current: InitPhase,
  target: InitPhase,
  order: InitPhase[],
): "past" | "current" | "future" {
  if (target === current) return "current";
  if (current === "error") return "future";
  const ci = order.indexOf(current);
  const ti = order.indexOf(target);
  if (ci === -1 || ti === -1) return "future";
  return ti < ci ? "past" : "future";
}
