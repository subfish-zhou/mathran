import { z } from "zod";

/**
 * Per-user × per-scope AI Assistant goal-supervisor configuration.
 *
 * Stored in `assistant_goal_settings.config` (jsonb), keyed by
 * (userId, scope, scopeId). Shared between:
 *  - tRPC router (assistant-goal.ts) for get/update
 *  - executor / goal-provider core (Worker B)
 *  - AssistantSidebar / GoalAutonomyCard UI (Worker C)
 */
export const assistantGoalConfigSchema = z.object({
  /** Whether goal-continuation is enabled (must be explicitly turned on). */
  enabled: z.boolean(),
  /** How aggressively the agent self-handles decision points before interrupting the user. */
  autonomyLevel: z.enum(["conservative", "balanced", "aggressive"]),
  /** Interval between periodic progress summaries, in ms. Min 60s. */
  summaryIntervalMs: z.number().int().min(60000),
  /**
   * Summary cadence/strategy (design §2.5):
   *  - realtime → in-loop slice(-1500) progress notes (short tasks).
   *  - hourly   → cron-driven map-reduce hourly summaries (long/goal tasks).
   *  - daily    → hourly PLUS a day-boundary daily aggregate of the 24 hourlies.
   * realtime keeps the legacy in-loop behavior; hourly/daily move summaries to
   * the durable cron pipeline (goal-watch) so they survive a dead loop.
   */
  summaryGranularity: z.enum(["realtime", "hourly", "daily"]).default("realtime"),
  /** Fallback cap on continuation rounds. */
  maxRounds: z.number().int().positive().optional(),
  /**
   * Budget cap on CUMULATIVE tokens across all rounds of one run. The goal-run
   * outer loop sums `agentResult.budget.totalTokens` each round and stops with
   * stopKind="budget_exceeded" once this is crossed. Prevents an autonomous run
   * from silently burning through tokens for hours (observed: 4.8M tok / $13 in
   * 25 min with no cap). Distinct from the PER-TURN budget in executor.ts.
   */
  maxTokens: z.number().int().positive().optional(),
  /**
   * Budget cap on CUMULATIVE estimated cost (USD) across all rounds. Same loop
   * accumulation as maxTokens but in dollars (tokens × GOAL_COST_PER_1K_USD).
   * Either cap tripping stops the run. Optional; when unset only maxTokens (if
   * set) gates. A coarse estimate — the authoritative bill is llm_usage_log.
   */
  maxCostUsd: z.number().positive().optional(),
  /**
   * P2-5 periodic reviewer cadence. Every K rounds the goal-run loop fires an
   * independent JSON-only reviewer LLM call that judges PROGRESS REALITY (not
   * goal completion — that's the Goal Supervisor gate's job). drift/stuck stops
   * the run as stopKind='needs_review' (resumable). 0 = disabled; default 5.
   *
   * Distinct from the gate: the gate decides done/needsUser based on the
   * agent's own self-eval; the reviewer is an EXTERNAL cross-check that the
   * agent isn't fabricating progress / chasing the wrong subgoal. fail-OPEN
   * (reviewer LLM unavailable → continue) so it can never break the loop.
   */
  reviewerEveryRounds: z.number().int().min(0).optional(),
});

export type AssistantGoalConfig = z.infer<typeof assistantGoalConfigSchema>;

/** Default config used when none is stored (or stored value is null/empty). */
export const DEFAULT_GOAL_CONFIG: AssistantGoalConfig = {
  enabled: false,
  autonomyLevel: "aggressive",
  summaryIntervalMs: 3600000,
  summaryGranularity: "realtime",
  maxRounds: 50,
  // Safety backstops for autonomous runs (子鱼 2026-06-07, after a capless run
  // burned 4.8M tok / $13 in 25 min). Conservative defaults so even a config
  // that omits them can't run away. Power users can raise per scope.
  maxTokens: 3_000_000,
  maxCostUsd: 10,
  // P2-5 quality cross-check. 5 strikes a balance between catching drift
  // early and not paying a reviewer LLM call too often (a typical run of 20
  // rounds gets ~4 review calls). Set to 0 in stored config to disable.
  reviewerEveryRounds: 5,
};

/**
 * Coarse token→USD factor for the goal-run budget estimate (NOT billing —
 * llm_usage_log is authoritative). Blended prompt+completion rate for the
 * default goal model; intentionally rough and on the high side so the cost cap
 * trips early rather than late. Override via env if the model mix changes.
 */
export const GOAL_COST_PER_1K_USD = Number(
  process.env.GOAL_COST_PER_1K_USD ?? "0.003",
);

/**
 * Coerce a possibly-partial / null stored jsonb value into a full config,
 * filling missing fields from defaults.
 */
export function resolveGoalConfig(
  stored: unknown,
): AssistantGoalConfig {
  if (!stored || typeof stored !== "object") {
    return { ...DEFAULT_GOAL_CONFIG };
  }
  const parsed = assistantGoalConfigSchema.partial().safeParse(stored);
  if (!parsed.success) {
    return { ...DEFAULT_GOAL_CONFIG };
  }
  return { ...DEFAULT_GOAL_CONFIG, ...parsed.data };
}
