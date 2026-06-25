/**
 * Goal-mode token budget continuation — ported from claude-code's
 * src/query/tokenBudget.ts, adapted to mathran's per-goal lifetime
 * budget semantics.
 *
 * Source reference (CC):
 *   src/query/tokenBudget.ts  (checkTokenBudget / createBudgetTracker)
 *   src/utils/tokenBudget.ts  (getBudgetContinuationMessage)
 *
 * Differences from CC:
 *   - per-goal (not per-turn). The tracker state is persisted in
 *     `goal.stats.budget*` fields between iterations rather than living
 *     in an in-memory turn loop.
 *   - Triggered when the model calls `mark_done` (not at CC's
 *     `!needs_follow_up`). The deterministic check decides whether to
 *     honour the mark_done or to nudge the model to keep working.
 *   - Sub-goals (`goal.parentGoalId !== undefined`) skip the check —
 *     they are spawned with their own short-lived intent and must be
 *     allowed to finish.
 *
 * This module is a PURE library: no I/O, no clock reads that affect the
 * decision. All persistence + side effects live in runner.ts.
 */

/** Persisted continuation tracker. Lives in `goal.stats.budget*`. */
export interface BudgetTracker {
  continuationCount: number;
  lastDeltaTokens: number;
  lastCheckTokens: number;
}

/** Outcome of a single budget check. */
export type BudgetDecision =
  | {
      action: "continue";
      nudgeMessage: string;
      pct: number;
      continuationCount: number;
      turnTokens: number;
      budget: number;
    }
  | { action: "stop"; diminishingReturns?: boolean };

/** Treat >= 90% of the token target as "done enough". */
export const COMPLETION_THRESHOLD = 0.9;
/** Δtokens < 500 between checks counts as "stalled". */
export const DIMINISHING_THRESHOLD = 500;

/**
 * Decide whether a `mark_done` should be honoured or blocked with a
 * continuation nudge.
 *
 * @param tracker        the persisted per-goal continuation state.
 * @param budget         the goal's `budget.tokensMax` (null / <= 0 → stop).
 * @param currentTokens  the goal's `stats.tokensUsed` so far.
 * @param isSubGoal      true when `goal.parentGoalId` is set → always stop.
 */
export function checkGoalBudget(
  tracker: BudgetTracker,
  budget: number | null,
  currentTokens: number,
  isSubGoal: boolean,
): BudgetDecision {
  // Sub-goals, no budget, or a non-positive budget: honour mark_done.
  if (isSubGoal || budget === null || budget <= 0) {
    return { action: "stop" };
  }

  const pct = Math.round((currentTokens / budget) * 100);
  const delta = currentTokens - tracker.lastCheckTokens;

  // Diminishing returns: after 3 continuations, if the model is barely
  // producing new tokens (this check AND the previous one both moved the
  // needle < 500 tokens), stop nudging — otherwise the nudge can loop
  // forever on a model that has genuinely run out of productive work.
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    delta < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD;

  if (!isDiminishing && currentTokens < budget * COMPLETION_THRESHOLD) {
    return {
      action: "continue",
      pct,
      continuationCount: tracker.continuationCount + 1,
      turnTokens: currentTokens,
      budget,
      nudgeMessage: getBudgetContinuationMessage(pct, currentTokens, budget),
    };
  }

  return { action: "stop", diminishingReturns: isDiminishing };
}

/**
 * The nudge message. The exact wording is part of the design — the CC
 * engineers picked "Keep working — do not summarize" for its measured
 * effect on GPT's early-stop behaviour. Do NOT translate or reword.
 *
 *   - comma-separated thousands via Intl.NumberFormat('en-US')
 *   - em-dash (\u2014) separator
 */
export function getBudgetContinuationMessage(
  pct: number,
  used: number,
  budget: number,
): string {
  const fmt = (n: number): string => new Intl.NumberFormat("en-US").format(n);
  return `Stopped at ${pct}% of token target (${fmt(used)} / ${fmt(
    budget,
  )}). Keep working \u2014 do not summarize.`;
}
