/**
 * Outcome events — in-memory pub/sub for `goal-graded` notifications (C-2).
 *
 * Self-grade ({@link ../self-grade.ts}) is fire-and-forget: it runs a
 * background LLM round AFTER the goal's terminal flow has already returned, so
 * its result can never travel out on the goal's original SSE stream (that
 * stream is long gone by the time grading lands). This module bridges that gap
 * with a process-local {@link EventEmitter} singleton:
 *
 *   - `publishOutcomeGraded` is called by `self-grade.ts` once the outcome is
 *     safely on disk.
 *   - any active SSE stream (`serve.ts`) calls `subscribeOutcomeGraded` for the
 *     lifetime of the stream and multicasts each event to its client as a
 *     `goal-graded` frame. The SPA filters by `goalId`.
 *
 * Design notes:
 *   - Emission is best-effort and decoupled: a publish with zero subscribers is
 *     a no-op (the grade is still persisted on disk, retrievable via
 *     `/outcomes`). We accept that an outcome graded while no stream is open is
 *     not replayed — see PLAN "不在范围".
 *   - `setMaxListeners(0)` disables Node's leak warning: the number of
 *     concurrent SSE streams is the natural bound, and every subscriber is
 *     paired with an unsubscribe in a `finally`.
 */

import { EventEmitter } from "node:events";

import type { Outcome } from "./schema.js";

/** Payload broadcast when a goal run has been self-graded and persisted. */
export interface OutcomeGradedEvent {
  /** Workspace the outcome was written under (lets multi-root hosts filter). */
  workspace: string;
  /** Originating goal id — the SPA filters its toast/refresh on this. */
  goalId: string;
  /** The freshly persisted, redacted outcome. */
  outcome: Outcome;
}

const GRADED = "graded";

/** Process-local emitter. One per server process — not exported directly. */
const emitter = new EventEmitter();
// Unbounded: concurrent SSE streams are the real cap and each unsubscribes.
emitter.setMaxListeners(0);

/** Broadcast a freshly graded outcome to every active subscriber. */
export function publishOutcomeGraded(event: OutcomeGradedEvent): void {
  emitter.emit(GRADED, event);
}

/**
 * Subscribe to `goal-graded` events. Returns an unsubscribe function the
 * caller MUST invoke when its stream ends (typically in a `finally`).
 */
export function subscribeOutcomeGraded(
  listener: (event: OutcomeGradedEvent) => void,
): () => void {
  emitter.on(GRADED, listener);
  return () => {
    emitter.off(GRADED, listener);
  };
}

/** Current subscriber count — exposed for tests / diagnostics. */
export function outcomeSubscriberCount(): number {
  return emitter.listenerCount(GRADED);
}
