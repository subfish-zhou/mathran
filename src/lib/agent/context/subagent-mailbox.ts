/**
 * Sub-agent notification mailbox — process-wide buffer between async
 * sub-agent completion (fire-and-forget .then/.catch handlers in
 * executor.ts) and the parent executor's next LLM turn.
 *
 * Why a mailbox: the SubagentStop callback runs in a different async
 * context from the parent executor loop, so we can't push directly into
 * the parent's local `workingMessages`. The parent drains the mailbox
 * at the top of every iteration via drainSubagentNotifications().
 *
 * Bounded: 64 notifications per conversation. Overflow drops the OLDEST
 * entries (FIFO) and emits a warn. 64 chosen because:
 *   - A goal-run round of ~20 turns producing 1-2 sub-agents per turn is
 *     ~40 notifs max; 64 leaves headroom.
 *   - Anything past 64 in one conversation likely means the parent is
 *     never draining (bug) — dropping silently would hide it; the warn
 *     surfaces it.
 *
 * Process-singleton via module-level Map. Tests reset with _resetForTest.
 *
 * Ported: 2026-06-10 (commit 12/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { SubagentNotificationPayload } from "./fragment";

const QUEUE_CAP = 64;

const queues = new Map<string, SubagentNotificationPayload[]>();

/**
 * Append a notification to the conversation's mailbox. Trims the oldest
 * entries when over QUEUE_CAP.
 */
export function enqueueSubagentNotification(
  conversationId: string,
  notification: SubagentNotificationPayload,
): void {
  if (!conversationId) {
    // Defensive: malformed conversationId would silently lose data. Warn
    // loud so we catch wiring bugs in executor early.
    console.warn(
      "[subagent-mailbox] enqueue called with empty conversationId — dropping",
    );
    return;
  }
  let q = queues.get(conversationId);
  if (!q) {
    q = [];
    queues.set(conversationId, q);
  }
  q.push(notification);
  if (q.length > QUEUE_CAP) {
    const dropped = q.length - QUEUE_CAP;
    q.splice(0, dropped);
    console.warn(
      `[subagent-mailbox] queue for conv ${conversationId} overflowed; dropped ${dropped} oldest notifications`,
    );
  }
}

/**
 * Atomically returns + clears all queued notifications for the
 * conversation. Returns [] when mailbox is empty.
 */
export function drainSubagentNotifications(
  conversationId: string,
): SubagentNotificationPayload[] {
  const q = queues.get(conversationId);
  if (!q || q.length === 0) return [];
  // Slice copy so callers can mutate freely; clear by removing the entry
  // entirely so we don't keep growing the Map for long-lived conversations.
  const out = q.slice();
  queues.delete(conversationId);
  return out;
}

/**
 * Inspect-only peek. Doesn't drain. Useful for tests + observability
 * (e.g. expose a metrics endpoint later).
 */
export function peekSubagentNotifications(
  conversationId: string,
): SubagentNotificationPayload[] {
  const q = queues.get(conversationId);
  return q ? q.slice() : [];
}

/** Reset all queues. Test-only. */
export function _resetForTest(): void {
  queues.clear();
}

/** Exported for tests + observability. */
export const SUBAGENT_MAILBOX_QUEUE_CAP = QUEUE_CAP;
