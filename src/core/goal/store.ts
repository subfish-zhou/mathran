/**
 * `mathran goal` — long-running, state-tracked agent runs (GAP #11).
 *
 * A Goal is a persistent record of one objective the assistant is working
 * toward, with a budget, an audit log of steps, and a reference to the chat
 * conversation(s) that produced them. Compared with a plain chat session a
 * Goal:
 *
 *   - has an explicit `objective` (frozen at start),
 *   - has explicit budgets (token + round caps),
 *   - records every assistant turn / tool call / tool result to disk so a
 *     later run (resume) can pick up exactly where it left off,
 *   - tracks status (active / paused / complete / failed / cancelled) and
 *     a single end-reason string.
 *
 * One Goal owns at least one chat conversation; the conversation jsonl is
 * the source of truth for replay, and `steps[]` is a denormalised audit
 * trail mirroring the same events for human reading. (`steps` is *derived*
 * — failures writing it do not fail the underlying chat flush.)
 *
 * Filesystem layout:
 *
 *   <workspace>/.mathran/goals/<goalId>.json     // this file
 *
 * The chat history lives in the existing scoped chat store:
 *
 *   <workspace>/.mathran/global-chat/<conversationId>.jsonl
 *   <workspace>/projects/<slug>/chat/<conversationId>.jsonl
 *   <workspace>/projects/<slug>/efforts/<eff>/chat/<conversationId>.jsonl
 *
 * `Goal.conversationIds` carries the reverse pointer.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { ChatScope } from "../chat/store.js";

const GOALS_DIR = path.join(".mathran", "goals");

/** Persisted goal state. */
export interface Goal {
  id: string;
  /** Frozen at start time. */
  objective: string;
  scope: ChatScope;
  /**
   * "active"     started, currently being worked on or ready to be resumed
   * "paused"     explicit user pause (resume to continue)
   * "complete"   the assistant marked the goal complete or hit \"done\"
   * "failed"     unrecoverable error during the run
   * "cancelled"  user cancelled via \`mathran goal cancel\`
   * "exhausted"  budget hit before completion
   * "stalled"    auto-flagged by scripts/audit-stale-goals.ts: was
   *              "active" with no live daemon runner past a threshold
   *              (likely a pre-daemon SPA-driver zombie). endReason
   *              records when/why it was flagged.
   */
  status: "active" | "paused" | "complete" | "failed" | "cancelled" | "exhausted" | "stalled";
  /** Budgets and the model used for this run. `null` = no budget set. */
  budget: { tokensMax: number | null; roundsMax: number | null };
  model: string;
  createdAt: string;
  endedAt?: string;
  endReason?: string;
  stats: {
    tokensUsed: number;
    /**
     * Phase ζ (cost meter) — input (prompt) tokens, split out of the
     * combined `tokensUsed` so per-model $ cost can be computed
     * (pricing differs input vs output). Sums provider-reported
     * `usage.input_tokens` across every LLM round-trip. Defaults to 0
     * for goals created before Phase ζ; `tokensUsed` stays the source
     * of truth for total volume (no breaking change).
     */
    inputTokensUsed: number;
    /**
     * Phase ζ (cost meter) — output (completion) tokens, split out of
     * `tokensUsed`. Sums provider-reported `usage.output_tokens` across
     * every LLM round-trip. Defaults to 0 for pre-Phase-ζ goals.
     */
    outputTokensUsed: number;
    /**
     * Number of daemon iterations run (each `runOneIteration` /
     * `ChatSession.send`). This is what the user's `--max-rounds` /
     * `budget.roundsMax` controls. Renamed from `roundsRun` (defect #3)
     * because a single iteration can contain many assistant turns.
     */
    iterationsRun: number;
    /**
     * Total distinct assistant turns across all iterations — i.e. every
     * LLM call result that produced text and/or tool calls. In a
     * daemon-driven iteration this can be far larger than `iterationsRun`.
     */
    assistantTurnsTotal: number;
    /**
     * Total distinct chat-completions calls. Equal to `assistantTurnsTotal`
     * unless the infrastructure tracks retries separately (it currently
     * doesn't, so they match).
     */
    llmCallsTotal: number;
    toolCallCount: number;
    /**
     * @deprecated Alias for {@link iterationsRun}, kept for backward
     * compatibility with on-disk goal records and existing API/SPA
     * consumers. Always serialized equal to `iterationsRun`.
     */
    roundsRun: number;
    /**
     * TODO-2 §3.2 / C7 — total number of successful compactV2 swaps in
     * this goal's lifetime. Incremented from runner.ts each time a
     * compaction `iteration-end` event is received from the chat
     * session. Defaults to 0 for goals created before TODO-2.
     */
    compactionRuns: number;
    /**
     * TODO-2 §3.2 / C7 — cumulative `originalTokens - newTokens` across
     * all successful compactions. Approximates how many tokens were
     * "saved" by compaction (best-effort, depends on the model-specific
     * token counter). Defaults to 0 for goals created before TODO-2.
     */
    compactionTokensDropped: number;
    /**
     * TODO-2 §3.2 / C7 — reason on the most-recent successful compaction
     * (budget_exceeded / token_limit / user_requested / ...). null when
     * no compaction has run yet.
     */
    lastCompactionReason: string | null;
    /**
     * TODO-2 §3.2 / C7 — ISO timestamp of the most-recent successful
     * compaction. null when no compaction has run yet.
     */
    lastCompactionAt: string | null;
    /**
     * Layer 1 (token budget continuation) — number of times `mark_done`
     * was blocked and the model was nudged to keep working because the
     * goal hadn't yet spent 90% of `budget.tokensMax`. Persisted across
     * iterations so the diminishing-returns guard (count >= 3) survives
     * daemon reschedules. Defaults to 0 for goals created before Layer 1.
     */
    budgetContinuationCount: number;
    /**
     * Layer 1 — Δtokens between the two most-recent budget checks. Feeds
     * the diminishing-returns guard (a continuation is "stalled" when
     * both this and the current delta are < 500). Defaults to 0.
     */
    budgetLastDeltaTokens: number;
    /**
     * Layer 1 — `stats.tokensUsed` snapshot at the most-recent budget
     * check, used to compute the next delta. Defaults to 0.
     */
    budgetLastCheckTokens: number;
    /**
     * Layer 2 (mark_done review) — number of times a `mark_done` was
     * blocked by the content-review hook (deterministic plan check or LLM
     * reviewer) and the model was nudged to keep working. Persisted across
     * iterations so the force-accept cap (count >= 3) survives daemon
     * reschedules. Defaults to 0 for goals created before Layer 2.
     */
    markDoneReviewRejectionCount: number;
  };
  /** Chat conversation ids this goal spawned. The first one is the primary. */
  conversationIds: string[];
  /** Append-only step audit log. */
  steps: GoalStep[];
  /**
   * Path (relative to workspace) to the post-completion summary markdown
   * file at `.mathran/goals/<id>.summary.md`. Written by the runner after
   * `mark_done` / `give_up`. `null` (or missing) when not yet generated
   * or when the summary round failed (see endReason for details).
   */
  summaryPath?: string | null;
  /**
   * v0.16 §9 audit #4: path (relative to workspace) to the goal's active
   * plan markdown file at `.mathran/goals/<id>.plan.md`. Written by the
   * runner on the first round ("plan bootstrap") when one doesn't yet
   * exist; subsequently mutated in-place by the `update_plan_item` tool.
   * `null` / missing when bootstrap was skipped (sub-goal, opt-out) or
   * when the bootstrap round failed without producing a usable plan.
   */
  planPath?: string | null;
  /** v0.16 §3 (thread support): when this goal was spawned by another
   *  goal via `spawn_sub_goal`, the parent's id. Null/omitted for top-level
   *  goals. Drives the "jump back to parent thread" link in the UI. */
  parentGoalId?: string | null;
  /** v0.16 §3: ids of sub-goals this goal spawned, in creation order.
   *  The SPA reads this to render thread badges on `spawn_sub_goal`
   *  tool-calls without having to regex sub-goal ids out of tool-result
   *  content. Append-only; we keep ids even for failed sub-goals because
   *  the conversation they produced is still worth inspecting. */
  subGoalIds?: string[];
  /**
   * goal-defaults-timer (2026-06-23): optional free-form addendum the
   * user types into the create-goal modal's third field ("额外指令" /
   * "Additional context"). When set, the runner appends it to the system
   * prompt as a labelled "Additional user-provided context" block on
   * every round. Persisted so resume + sub-agent goal trees inherit the
   * same instructions without the user having to retype them.
   *
   * Optional / missing on legacy records.
   */
  extraInstructions?: string;
  /**
   * v0.17 W8: monotonic unix-ms timestamp the runner stamps at the top of
   * every round. The SPA's `GoalRunStatusPanel` uses this to render a
   * "heartbeat freshness" indicator ("active 12s ago" / "stale") so users
   * can tell at a glance whether a background goal-loop is still ticking,
   * even after the SSE stream has been closed. Optional/missing on legacy
   * goal records that pre-date the field. Persisted to disk so a page
   * refresh still has it.
   */
  heartbeatAt?: number;
  /**
   * v0.17 W8: free-form metadata bag the runner/REST layer can poke at
   * without having to evolve the top-level Goal shape every time we add a
   * runtime knob. Currently used for:
   *   - `abortRequested`: set by `POST /api/goals/:id/abort`. The runner
   *     checks this at the top of every round and bails out as an
   *     "aborted" round (NOT a failure) when it's true.
   * Optional / missing on legacy records.
   */
  meta?: GoalMeta;
}

/** v0.17 W8: runtime metadata bag. Kept narrow on purpose — anything that
 *  belongs on the canonical Goal record gets promoted to a top-level field. */
export interface GoalMeta {
  /** Set by `POST /api/goals/:id/abort`; cleared by `POST /api/goals/:id/resume`
   *  (and by `runGoalRound` itself when a fresh round starts) so a previously
   *  aborted goal can be retried without a stale flag. */
  abortRequested?: boolean;
}

/** One row in the goal's audit log. */
export interface GoalStep {
  /** ISO timestamp. */
  at: string;
  kind:
    | "objective"
    | "text"
    | "tool-call"
    | "tool-result"
    | "plan"
    | "reflect"
    | "status"
    | "ask-user-auto-resolved"
    /** TODO-2 §3.2 / C8 — compaction lifecycle event durable record. */
    | "compaction"
    /** Layer 1 — token budget continuation: mark_done was blocked and the
     *  model nudged to keep working. Payload carries
     *  {pct, continuationCount, tokensUsed, budget}. */
    | "budget-continuation"
    /** Layer 2 — mark_done content review blocked the completion. Payload
     *  carries {rejectionCount, mode, blockingError}. */
    | "mark-done-review-rejected";
  payload: Record<string, unknown> | string;
}

export interface GoalStoreOptions {
  workspace: string;
}

/** Path on disk for one goal. */
export function goalFileFor(workspace: string, goalId: string): string {
  return path.join(workspace, GOALS_DIR, `${goalId}.json`);
}

/** Path on disk for the goals directory. */
export function goalsDirFor(workspace: string): string {
  return path.join(workspace, GOALS_DIR);
}

/** Read one goal from disk. Returns null if not found. */
export async function readGoal(workspace: string, goalId: string): Promise<Goal | null> {
  try {
    const raw = await fs.readFile(goalFileFor(workspace, goalId), "utf-8");
    const goal = JSON.parse(raw) as Goal;
    goal.stats = migrateGoalStats((goal as { stats?: unknown }).stats);
    return goal;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Defect #3 migration shim. Older goal records (and sub-goal stubs) only
 * carried `roundsRun`; newer code reads `iterationsRun` plus turn counters.
 * Map `roundsRun → iterationsRun` when the newer field is absent, default the
 * turn counters to 0, and keep `roundsRun` aliased to `iterationsRun` so the
 * on-disk format never loses the deprecated field.
 */
export function migrateGoalStats(raw: unknown): Goal["stats"] {
  const s = (raw ?? {}) as Partial<Goal["stats"]> & { roundsRun?: number };
  const iterationsRun = s.iterationsRun ?? s.roundsRun ?? 0;
  return {
    tokensUsed: s.tokensUsed ?? 0,
    // Phase ζ — input/output split. Pre-Phase-ζ goals default to 0; their
    // combined `tokensUsed` is preserved so historical totals stay correct.
    inputTokensUsed: s.inputTokensUsed ?? 0,
    outputTokensUsed: s.outputTokensUsed ?? 0,
    iterationsRun,
    assistantTurnsTotal: s.assistantTurnsTotal ?? 0,
    llmCallsTotal: s.llmCallsTotal ?? 0,
    toolCallCount: s.toolCallCount ?? 0,
    roundsRun: iterationsRun,
    // TODO-2 §3.2 / C7 — compaction stats (default for pre-TODO-2 goals).
    compactionRuns: s.compactionRuns ?? 0,
    compactionTokensDropped: s.compactionTokensDropped ?? 0,
    lastCompactionReason: s.lastCompactionReason ?? null,
    lastCompactionAt: s.lastCompactionAt ?? null,
    // Layer 1 — token budget continuation (default for pre-Layer-1 goals).
    budgetContinuationCount: s.budgetContinuationCount ?? 0,
    budgetLastDeltaTokens: s.budgetLastDeltaTokens ?? 0,
    budgetLastCheckTokens: s.budgetLastCheckTokens ?? 0,
    // Layer 2 — mark_done review (default for pre-Layer-2 goals).
    markDoneReviewRejectionCount: s.markDoneReviewRejectionCount ?? 0,
  };
}

/** Write one goal to disk, creating the goals/ directory if needed. */
export async function writeGoal(workspace: string, goal: Goal): Promise<void> {
  const file = goalFileFor(workspace, goal.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(goal, null, 2) + "\n", "utf-8");
}

/** List all goals on disk, newest first. */
export async function listGoals(workspace: string): Promise<Goal[]> {
  const dir = goalsDirFor(workspace);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const goals: Goal[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf-8");
      const g = JSON.parse(raw) as Goal;
      g.stats = migrateGoalStats((g as { stats?: unknown }).stats);
      goals.push(g);
    } catch {
      /* skip malformed */
    }
  }
  goals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return goals;
}

export interface CreateGoalInput {
  objective: string;
  scope: ChatScope;
  model: string;
  budgetTokensMax?: number | null;
  budgetRoundsMax?: number | null;
  /** v0.16 §3: parent goal id when this goal is a sub-goal. The caller is
   *  responsible for also appending the new id to the parent's
   *  `subGoalIds` via {@link addSubGoalId}; we keep the two writes
   *  separate so a parent goal that's currently being read for other
   *  reasons doesn't race against `createGoal`'s write of the child. */
  parentGoalId?: string | null;
  /** goal-defaults-timer: free-form addendum that flows straight into
   *  `Goal.extraInstructions` and ends up appended to every round's
   *  system prompt. Trim by the REST layer; empty strings become
   *  undefined here so the persisted record stays clean. */
  extraInstructions?: string;
}

/**
 * Make a brand-new Goal on disk. The caller still has to actually drive it
 * (build a ChatSession, send the objective, append steps). This helper only
 * scaffolds the record.
 */
export async function createGoal(
  workspace: string,
  input: CreateGoalInput,
): Promise<Goal> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const goal: Goal = {
    id,
    objective: input.objective,
    scope: input.scope,
    status: "active",
    budget: {
      tokensMax: input.budgetTokensMax ?? null,
      roundsMax: input.budgetRoundsMax ?? null,
    },
    model: input.model,
    createdAt: now,
    stats: {
      tokensUsed: 0,
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      iterationsRun: 0,
      assistantTurnsTotal: 0,
      llmCallsTotal: 0,
      toolCallCount: 0,
      roundsRun: 0,
      compactionRuns: 0,
      compactionTokensDropped: 0,
      lastCompactionReason: null,
      lastCompactionAt: null,
      budgetContinuationCount: 0,
      budgetLastDeltaTokens: 0,
      budgetLastCheckTokens: 0,
      markDoneReviewRejectionCount: 0,
    },
    conversationIds: [],
    parentGoalId: input.parentGoalId ?? null,
    subGoalIds: [],
    ...(input.extraInstructions && input.extraInstructions.trim().length > 0
      ? { extraInstructions: input.extraInstructions }
      : {}),
    steps: [
      { at: now, kind: "objective", payload: input.objective },
    ],
  };
  await writeGoal(workspace, goal);
  return goal;
}

/**
 * Append a step to the goal's audit log and persist.
 *
 * Failure to write is *not* propagated — the same convention as the chat
 * Markdown transcript (GAP #13). Goal.steps is a derived view; the chat
 * jsonl remains the source of truth.
 */
export async function appendStep(
  workspace: string,
  goalId: string,
  step: Omit<GoalStep, "at"> & { at?: string },
): Promise<void> {
  try {
    const g = await readGoal(workspace, goalId);
    if (!g) return;
    g.steps.push({ at: step.at ?? new Date().toISOString(), kind: step.kind, payload: step.payload });
    await writeGoal(workspace, g);
  } catch {
    /* swallow */
  }
}

/** Bump aggregate counters on the goal record. */
export async function updateGoalStats(
  workspace: string,
  goalId: string,
  delta: Partial<Goal["stats"]>,
): Promise<void> {
  const g = await readGoal(workspace, goalId);
  if (!g) return;
  const iterationsRun = g.stats.iterationsRun + (delta.iterationsRun ?? delta.roundsRun ?? 0);
  g.stats = {
    tokensUsed: g.stats.tokensUsed + (delta.tokensUsed ?? 0),
    inputTokensUsed: g.stats.inputTokensUsed + (delta.inputTokensUsed ?? 0),
    outputTokensUsed: g.stats.outputTokensUsed + (delta.outputTokensUsed ?? 0),
    iterationsRun,
    assistantTurnsTotal: g.stats.assistantTurnsTotal + (delta.assistantTurnsTotal ?? 0),
    llmCallsTotal: g.stats.llmCallsTotal + (delta.llmCallsTotal ?? 0),
    toolCallCount: g.stats.toolCallCount + (delta.toolCallCount ?? 0),
    roundsRun: iterationsRun,
    // TODO-2 §3.2 / C7 — compaction stats: deltas can carry new values,
    // otherwise carry forward. lastCompactionReason / lastCompactionAt
    // are SET (not added) by callers — pass-through delta values.
    compactionRuns: g.stats.compactionRuns + (delta.compactionRuns ?? 0),
    compactionTokensDropped: g.stats.compactionTokensDropped + (delta.compactionTokensDropped ?? 0),
    lastCompactionReason: delta.lastCompactionReason ?? g.stats.lastCompactionReason,
    lastCompactionAt: delta.lastCompactionAt ?? g.stats.lastCompactionAt,
    // Layer 1 — budget continuation tracker: carried forward (callers SET
    // these directly via writeGoal, not through updateGoalStats deltas).
    budgetContinuationCount:
      delta.budgetContinuationCount ?? g.stats.budgetContinuationCount,
    budgetLastDeltaTokens:
      delta.budgetLastDeltaTokens ?? g.stats.budgetLastDeltaTokens,
    budgetLastCheckTokens:
      delta.budgetLastCheckTokens ?? g.stats.budgetLastCheckTokens,
    // Layer 2 — mark_done review rejection counter: carried forward
    // (the runner SETs this directly via writeGoal, not via deltas).
    markDoneReviewRejectionCount:
      delta.markDoneReviewRejectionCount ?? g.stats.markDoneReviewRejectionCount,
  };
  await writeGoal(workspace, g);
}

/** Mark the goal as ended with a final status + reason. */
export async function endGoal(
  workspace: string,
  goalId: string,
  status: Goal["status"],
  reason: string,
): Promise<Goal | null> {
  const g = await readGoal(workspace, goalId);
  if (!g) return null;
  g.status = status;
  g.endedAt = new Date().toISOString();
  g.endReason = reason;
  g.steps.push({
    at: g.endedAt,
    kind: "status",
    payload: { to: status, reason },
  });
  await writeGoal(workspace, g);
  return g;
}

/**
 * NEW-F1 — flip a non-terminal goal status (e.g. active → paused) without
 * setting endedAt / endReason (those are reserved for terminal flips).
 * Appends a `status` audit step so the history shows the transition.
 * Returns the updated goal, or null if it doesn't exist.
 */
export async function flipGoalStatus(
  workspace: string,
  goalId: string,
  to: Goal["status"],
  reason: string,
): Promise<Goal | null> {
  const g = await readGoal(workspace, goalId);
  if (!g) return null;
  if (g.status === to) return g;
  const from = g.status;
  g.status = to;
  g.steps.push({
    at: new Date().toISOString(),
    kind: "status",
    payload: { from, to, reason },
  });
  await writeGoal(workspace, g);
  return g;
}

/**
 * Attach a chat conversation id to the goal (idempotent).
 * Called when the runner spins up its first ChatSession so the goal can
 * point back at the chat jsonl on disk.
 */
export async function attachConversation(
  workspace: string,
  goalId: string,
  conversationId: string,
): Promise<void> {
  const g = await readGoal(workspace, goalId);
  if (!g) return;
  if (!g.conversationIds.includes(conversationId)) {
    g.conversationIds.push(conversationId);
    await writeGoal(workspace, g);
  }
}

/**
 * v0.16 §3: register a sub-goal id under its parent. Idempotent.
 *
 * Called by `spawn_sub_goal` immediately after `createGoal` returns,
 * before any rounds run, so the parent's `subGoalIds` is in lock-step
 * with the existence of sub-goal records on disk. The SPA reads
 * `subGoalIds` to render thread badges on the parent's `spawn_sub_goal`
 * tool-call bubbles — without it we'd have to regex sub-goal ids out
 * of the tool-result strings, which is fragile.
 */
export async function addSubGoalId(
  workspace: string,
  parentGoalId: string,
  subGoalId: string,
): Promise<void> {
  const g = await readGoal(workspace, parentGoalId);
  if (!g) return;
  if (!g.subGoalIds) g.subGoalIds = [];
  if (!g.subGoalIds.includes(subGoalId)) {
    g.subGoalIds.push(subGoalId);
    await writeGoal(workspace, g);
  }
}

/**
 * v0.16 §9 audit #4: record the goal's plan file path. Called once at
 * bootstrap time by the runner so subsequent reads of the Goal record
 * carry the canonical relative path without anyone having to re-derive
 * it from the goal id. Idempotent: passing the same path again is a
 * no-op and never re-writes the goal file.
 */
export async function setGoalPlanPath(
  workspace: string,
  goalId: string,
  relPath: string,
): Promise<void> {
  const g = await readGoal(workspace, goalId);
  if (!g) return;
  if (g.planPath === relPath) return;
  g.planPath = relPath;
  await writeGoal(workspace, g);
}

/** Decide whether the goal still has budget to spend. */
export function withinBudget(g: Goal): { ok: true } | { ok: false; reason: string } {
  if (g.budget.tokensMax !== null && g.stats.tokensUsed >= g.budget.tokensMax) {
    return { ok: false, reason: `token budget exhausted (${g.stats.tokensUsed}/${g.budget.tokensMax})` };
  }
  if (g.budget.roundsMax !== null && g.stats.iterationsRun >= g.budget.roundsMax) {
    return { ok: false, reason: `iteration budget exhausted (${g.stats.iterationsRun}/${g.budget.roundsMax})` };
  }
  return { ok: true };
}

/**
 * v0.17 W8: stamp the goal's heartbeat with `Date.now()` and persist.
 *
 * Called by the runner at the top of every round so the SPA can tell
 * whether a background goal loop is still ticking even after its SSE
 * stream has been closed ("active 12s ago" / "stale"). All errors are
 * swallowed — a missed heartbeat must not kill the round.
 */
export async function touchHeartbeat(workspace: string, goalId: string): Promise<void> {
  try {
    const g = await readGoal(workspace, goalId);
    if (!g) return;
    g.heartbeatAt = Date.now();
    await writeGoal(workspace, g);
  } catch {
    /* swallow — heartbeat is advisory */
  }
}

/**
 * v0.17 W8: request that the runner abort the next round it sees.
 *
 * The runner checks `meta.abortRequested` at the top of every round and
 * bails out as an `aborted` round (NOT a failure) when set. Idempotent:
 * calling twice is a no-op. Returns the updated goal (or null when
 * not found).
 */
export async function requestGoalAbort(
  workspace: string,
  goalId: string,
): Promise<Goal | null> {
  const g = await readGoal(workspace, goalId);
  if (!g) return null;
  if (!g.meta) g.meta = {};
  if (g.meta.abortRequested) return g;
  g.meta.abortRequested = true;
  g.steps.push({
    at: new Date().toISOString(),
    kind: "status",
    payload: { abortRequested: true, reason: "user abort" },
  });
  await writeGoal(workspace, g);
  return g;
}

/**
 * v0.17 W8: clear a previously-set abort request. Called when a fresh
 * round starts so a stale flag from a prior abort doesn't kill the
 * new round before it has a chance to run.
 */
export async function clearGoalAbortRequest(
  workspace: string,
  goalId: string,
): Promise<void> {
  const g = await readGoal(workspace, goalId);
  if (!g) return;
  if (!g.meta?.abortRequested) return;
  g.meta.abortRequested = false;
  await writeGoal(workspace, g);
}
