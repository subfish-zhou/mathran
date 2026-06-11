/**
 * Per-conversation in-memory BlockedStateMachine registry.
 *
 * Mirrors runtime-budgets.ts — maps conversationId → blocked-state
 * machine. update_goal calls .evaluate() to enforce the 3-turn audit.
 *
 * Lifecycle (commit 5b in-memory only):
 * - Created lazily on first read with default threshold=3.
 * - Reset by update_goal when status transitions to 'active' or 'complete'.
 * - Commit 5c rehydrates from DB columns consecutive_blocked_turns +
 *   last_block_signature on process restart.
 *
 * Ported: 2026-06-10 (commit 5b/6 of mathub-ai-codex-upgrade).
 */

import { BlockedStateMachine } from "./blocked-state-machine";

const machines: Map<string, BlockedStateMachine> = new Map();

/**
 * Lazy lookup with auto-create. Always non-null so callers can chain on the
 * result without null-guarding.
 */
export function getBlockedStateForConversation(
  conversationId: string,
): BlockedStateMachine {
  let inst = machines.get(conversationId);
  if (!inst) {
    inst = new BlockedStateMachine();
    machines.set(conversationId, inst);
  }
  return inst;
}

export function setBlockedStateForConversation(
  conversationId: string,
  inst: BlockedStateMachine,
): void {
  machines.set(conversationId, inst);
}

export function clearBlockedStateForConversation(conversationId: string): void {
  machines.delete(conversationId);
}

/**
 * Rehydrate from DB on process restart. Builds a fresh machine seeded with
 * the persisted `consecutive_blocked_turns` and `last_block_signature` so
 * the next `evaluate()` call sees the correct continuity (e.g. a turn 2
 * of a 3-turn streak that crashed mid-streak resumes as turn 2, not 1).
 *
 * [commit-5d] Used by startRun() when resuming a non-terminal run.
 */
export function seedBlockedStateForConversation(
  conversationId: string,
  seed: { consecutive?: number; signature?: string | null },
): BlockedStateMachine {
  const inst = new BlockedStateMachine({
    initialConsecutive: seed.consecutive,
    initialSignature: seed.signature ?? undefined,
  });
  machines.set(conversationId, inst);
  return inst;
}

/** Test-only: clear all in-memory state. */
export function _resetBlockedStatesForTest(): void {
  machines.clear();
}
