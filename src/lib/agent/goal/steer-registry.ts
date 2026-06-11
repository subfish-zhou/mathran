/**
 * Live Steering — in-process registry for the SYNCHRONOUS chat path.
 *
 * 照搬 Hermes `_pending_steer` (run_agent.py:5180). In Hermes the steer slot is
 * just an instance field guarded by a threading.Lock, because the gateway, the
 * input handler and the agent loop all live in ONE process — a write from the
 * input thread is immediately visible to the loop thread.
 *
 * Mathub's two execution paths need two channels:
 *  - GOAL mode  → the run executes in a separate background worker process, so
 *    the channel is the `assistant_goal_runs.pending_steer/-_interrupt` columns
 *    (see run-state.ts drain helpers). Cross-process, DB-atomic.
 *  - SYNC mode  → the turn executes INSIDE the SSE request, in the web process.
 *    A second steer HTTP request hits the SAME process, so an in-memory map
 *    keyed by conversationId is the faithful Hermes analogue: the steer API
 *    writes here, the running executor drains here. No DB round-trip.
 *
 * This module is the SYNC-mode channel. It is intentionally tiny and global
 * (module-singleton) so any request handler in the process can reach it.
 *
 * Lifecycle: the SSE turn registers its conversationId on start and clears it
 * on finish (try/finally). Steers that arrive with no live turn are dropped
 * (nothing to steer) — the caller surfaces "no active run" to the user.
 */

interface SteerSlot {
  /** Pending soft-steer fragments, concatenated with \n on drain (照搬 Hermes). */
  steer: string[];
  /** Pending hard-interrupt redirect message (last write wins). */
  interrupt: string | null;
}

// Module singleton. Keyed by conversationId. A key exists only while a sync
// turn is live for that conversation.
const slots = new Map<string, SteerSlot>();

/** Mark a conversation as having a live sync turn (call at turn start). */
export function registerSyncTurn(conversationId: string): void {
  if (!conversationId) return;
  if (!slots.has(conversationId)) {
    slots.set(conversationId, { steer: [], interrupt: null });
  }
}

/** Tear down the slot when the sync turn ends (call in finally). */
export function unregisterSyncTurn(conversationId: string): void {
  if (!conversationId) return;
  slots.delete(conversationId);
}

/** Is a sync turn currently live for this conversation? (steer routing gate) */
export function hasLiveSyncTurn(conversationId: string): boolean {
  return slots.has(conversationId);
}

/**
 * Append soft-steer guidance for a live sync turn (照搬 Hermes `steer()`).
 * Returns true if attached (a live turn exists), false otherwise.
 */
export function appendSyncSteer(conversationId: string, text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  const slot = slots.get(conversationId);
  if (!slot) return false;
  slot.steer.push(cleaned);
  return true;
}

/**
 * Drain soft steer for a sync turn (照搬 Hermes `_drain_pending_steer`).
 * Returns the joined text (or null). Clears the slot's queue.
 */
export function drainSyncSteer(conversationId: string): string | null {
  const slot = slots.get(conversationId);
  if (!slot || slot.steer.length === 0) return null;
  const joined = slot.steer.join("\n");
  slot.steer = [];
  return joined;
}

/**
 * Request a hard interrupt redirect for a live sync turn (照搬 Hermes
 * `interrupt(message)`). Returns true if attached.
 */
export function requestSyncInterrupt(conversationId: string, message: string): boolean {
  const cleaned = message.trim();
  if (!cleaned) return false;
  const slot = slots.get(conversationId);
  if (!slot) return false;
  slot.interrupt = cleaned;
  return true;
}

/** Drain the hard-interrupt redirect for a sync turn (read + clear). */
export function drainSyncInterrupt(conversationId: string): string | null {
  const slot = slots.get(conversationId);
  if (!slot || !slot.interrupt) return null;
  const msg = slot.interrupt;
  slot.interrupt = null;
  return msg;
}
