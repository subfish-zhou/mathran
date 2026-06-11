/**
 * Per-conversation in-memory GoalBudgetAccounting registry.
 *
 * Tools (get_goal / update_goal) need a way to read the current budget for
 * the active conversation without pulling it out of the goal-provider
 * internals. This module is a thin singleton that maps conversationId →
 * accounting instance.
 *
 * Lifecycle (commit 5b in-memory only):
 * - Created lazily on first read (with zero-init) if no instance exists.
 * - Mutators (recordTurnStart / recordTokens / recordTurnEnd) are called by
 *   goal-provider once commit 5c wires them in. Until then the singleton
 *   stays at zero — the tool surface still works (returns zero usage), and
 *   the model can call update_goal to ask the runtime to stop.
 * - On process restart this state is lost; commit 5c rehydrates from DB.
 *
 * Ported: 2026-06-10 (commit 5b/6 of mathub-ai-codex-upgrade).
 */

import { GoalBudgetAccounting } from "./budgets";

const budgets: Map<string, GoalBudgetAccounting> = new Map();

/**
 * Read the budget accounting instance for a conversation, lazily allocating
 * a zero-initialised one if none exists. Always returns a non-null value so
 * callers don't have to null-guard the read path.
 */
export function getGoalBudgetForConversation(
  conversationId: string,
): GoalBudgetAccounting {
  let inst = budgets.get(conversationId);
  if (!inst) {
    inst = new GoalBudgetAccounting();
    budgets.set(conversationId, inst);
  }
  return inst;
}

/**
 * Replace the instance for a conversation — e.g. on goal start (fresh
 * budget) or rehydrate-from-DB. Commit 5c uses this; commit 5b ships the
 * setter so the surface is stable.
 */
export function setGoalBudgetForConversation(
  conversationId: string,
  inst: GoalBudgetAccounting,
): void {
  budgets.set(conversationId, inst);
}

/** Drop a conversation's accounting (e.g. on goal complete/abort). */
export function clearGoalBudgetForConversation(conversationId: string): void {
  budgets.delete(conversationId);
}

/**
 * Rehydrate from DB on process restart. Idempotent: replacing an existing
 * instance is fine — caller (run-state.startRun) should only call this
 * once per conversation, but a duplicate call simply re-seeds from the
 * same DB row. Returns the seeded instance for the caller's convenience.
 *
 * [commit-5d] Used by startRun() when resuming a non-terminal run so the
 * model sees the cumulative budget across restarts instead of starting
 * fresh after every crash.
 */
export function seedGoalBudgetForConversation(
  conversationId: string,
  seed: { tokensUsed?: number; timeUsedSeconds?: number; wallStartMs?: number },
): GoalBudgetAccounting {
  const inst = new GoalBudgetAccounting({
    initialTokensUsed: seed.tokensUsed,
    initialTimeUsedSeconds: seed.timeUsedSeconds,
    wallStartMs: seed.wallStartMs,
  });
  budgets.set(conversationId, inst);
  return inst;
}

/** Test-only: clear all in-memory state. */
export function _resetGoalBudgetsForTest(): void {
  budgets.clear();
}
