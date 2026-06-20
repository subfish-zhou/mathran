/**
 * v0.17 mathub parity W9 — Live Steering registry.
 *
 * In-memory, conversation-scoped pending-steer state for the SSE chat
 * + goal-run pipelines. The SPA POSTs a steer message while a stream
 * is in flight; the next round-top inside `ChatSession.runRounds`
 * consumes the pending text, injects it as a `[Steer from user: …]`
 * user message, and emits a `steer-received` SSE frame so the SPA can
 * dismiss its "steer queued" toast.
 *
 * Design choices (deliberately minimal):
 *
 *   - **Single process / single workspace**: `serve` runs as one Hono
 *     process, so a module-level `Map` is the simplest place for this
 *     state. No persistence to disk — if the server restarts, in-flight
 *     steers are lost (the streams they would have hit also died, so
 *     this is correct).
 *
 *   - **Keyed by conversationId**: conversation IDs are workspace-wide
 *     UUID-ish strings minted by `ScopedChatSessionStore.newConversationId`,
 *     so we don't need to compose `(scope, conversationId)` into the
 *     key. Plain chat conversations and goal-owned conversations share
 *     this namespace — exactly what we want, because the steer applies
 *     to the underlying `ChatSession.send` either way.
 *
 *   - **Active-stream gate**: POSTing a steer when no stream is
 *     currently running for the conversation is a 409 — the steer
 *     would never be read. We track active streams in a separate
 *     `Set<string>` (`markStreamActive` / `markStreamInactive` form a
 *     reference-count helper).
 *
 *   - **Consume-on-read**: `consumePendingSteer` returns and clears in
 *     one atomic operation; the round-top callback inside
 *     `ChatSession.runRounds` calls it before every LLM request.
 *
 *   - **Last-write-wins**: if a user fires two steers in quick
 *     succession, only the most recent text is read on the next round.
 *     Mirroring mathub's behaviour and avoiding a backlog of queued
 *     steers that fight each other.
 *
 * This module is intentionally side-effect-free at import time and
 * exposes only pure helpers — no class instance, no dependency
 * injection. Tests can `clearAllForTests()` between cases.
 */

/** conversationId → most recent pending steer text. */
const pending = new Map<string, string>();
/** conversationId → in-flight stream count (we may re-enter for goal /run/stream + chat). */
const activeStreamRefs = new Map<string, number>();

/**
 * Record the most recent steer text for a conversation. Overwrites any
 * prior pending text (last-write-wins). Empty / whitespace-only text
 * is rejected at the caller (the route handler) so we don't have to
 * trim here — but we still defensively coerce `null`/`undefined` to a
 * clear.
 */
export function setPendingSteer(conversationId: string, text: string | null | undefined): void {
  if (typeof text !== "string" || text.length === 0) {
    pending.delete(conversationId);
    return;
  }
  pending.set(conversationId, text);
}

/**
 * Atomically read + clear any pending steer for this conversation.
 * Returns `null` when there is no pending steer.
 *
 * Called from `ChatSession.runRounds` at the top of every round, right
 * before issuing the LLM request. Single-threaded JS guarantees the
 * `get`+`delete` pair is atomic relative to other JS turns.
 */
export function consumePendingSteer(conversationId: string): string | null {
  const text = pending.get(conversationId);
  if (text === undefined) return null;
  pending.delete(conversationId);
  return text;
}

/**
 * Non-destructive peek. Used by the route handler to decide whether to
 * respond 409 ("nothing in flight to steer") vs 200 ("queued"). Note
 * that peeking does NOT count as a read — `consumePendingSteer` is the
 * only path that clears the slot.
 */
export function hasPendingSteer(conversationId: string): boolean {
  return pending.has(conversationId);
}

/**
 * Mark a conversation as having an active stream. The route handler
 * for `POST <chatBase>` / `POST /api/goals/:id/run/stream` calls this
 * right after opening the SSE stream and pairs it with
 * `markStreamInactive` in a `finally` block.
 *
 * Returns a release function for the common case where the caller
 * doesn't want to track the conversationId again.
 */
export function markStreamActive(conversationId: string): () => void {
  const cur = activeStreamRefs.get(conversationId) ?? 0;
  activeStreamRefs.set(conversationId, cur + 1);
  return () => markStreamInactive(conversationId);
}

/**
 * Decrement the active-stream refcount for a conversation. When the
 * refcount hits zero we drop the entry AND clear any pending steer
 * that was never consumed — the stream that would have read it is
 * gone, so leaving the steer in the map would leak it onto a future
 * (unrelated) stream for the same conversationId.
 */
export function markStreamInactive(conversationId: string): void {
  const cur = activeStreamRefs.get(conversationId) ?? 0;
  if (cur <= 1) {
    activeStreamRefs.delete(conversationId);
    // No active stream → any pending steer is unreachable. Clear it
    // so a future stream on the same conversationId doesn't pick up
    // a stale steer from a prior session.
    pending.delete(conversationId);
  } else {
    activeStreamRefs.set(conversationId, cur - 1);
  }
}

/**
 * Returns true when at least one in-flight SSE stream is registered
 * for this conversationId.
 */
export function hasActiveStream(conversationId: string): boolean {
  return (activeStreamRefs.get(conversationId) ?? 0) > 0;
}

/**
 * Format a pending steer text as a user message body. Kept in one
 * place so chat + goal use the exact same `[Steer from user: …]`
 * envelope (the SPA looks for this prefix when rendering the in-line
 * "📣 Steered:" hint under the steered round).
 */
export function formatSteerUserMessage(text: string): string {
  return `[Steer from user: ${text}]`;
}

/**
 * Wipe both maps. Test-only — production code never wants to run
 * this. Exposed under an explicit `ForTests` suffix so it's grep-able.
 */
export function clearAllForTests(): void {
  pending.clear();
  activeStreamRefs.clear();
}
