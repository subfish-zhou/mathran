/**
 * goal-defaults-timer (commit 6/7) — auto-run gate.
 *
 * Pure decision helper for "should the SPA fire the next goal round
 * right now?". Lives in its own file so the policy is unit-testable
 * without dragging React/ChatPanel state into the test setup.
 *
 * The driver lives in `ChatPanel.tsx`:
 *
 *    setInterval(120_000) tick
 *      → call shouldAutoRunNextRound({ ...current state })
 *      → if true, fire runGoalRound(owningGoal.id)
 *
 * Rules (intentionally minimal — anything we can NOT see clearly
 * from the SPA's existing state should bias us toward "skip"):
 *
 *   1. No goal owning the conversation → never auto-run.
 *   2. Goal is not in "active" status → never auto-run. (paused /
 *      complete / failed / cancelled / exhausted should all stop the
 *      timer cleanly.)
 *   3. A round is currently in-flight (`busy === true`) → skip this
 *      tick; the on-going stream will land its own completion and the
 *      next tick will reconsider.
 *   4. The composer textarea has unsent content → skip. The user is
 *      mid-thought; firing a round here would race their typing.
 *   5. The user typed something into the composer in the last 30s →
 *      skip. Even if they cleared it, they were just there — give
 *      them a moment before kicking off a fresh round.
 *
 * The 30s typing-grace window is deliberately shorter than the 120s
 * tick interval: it's not meant to be "the user is still typing", it's
 * meant to be "they were JUST here, don't surprise them". 30s is the
 * same order of magnitude as a "wait for them to come back from a
 * brief context switch" timeout.
 */

export interface AutoRunGateInputs {
  /** The Goal record that owns the current conversation, if any. */
  owningGoal: { status: string } | null;
  /** True while a goal-round stream is open (sets `busy` in ChatPanel). */
  busy: boolean;
  /** Length of the composer textarea's current content (after trim). */
  unsentTextLength: number;
  /** Unix ms of the last keystroke in the composer. 0 = never. */
  lastKeystrokeTs: number;
  /** Unix ms "now" — injected so tests are deterministic. */
  now: number;
}

/** Typing-grace window (ms). See module header for rationale. */
export const TYPING_GRACE_MS = 30_000;

/** Auto-run cadence (ms). The driver's setInterval period. */
export const AUTO_RUN_TICK_MS = 120_000;

export function shouldAutoRunNextRound(opts: AutoRunGateInputs): boolean {
  if (!opts.owningGoal) return false;
  if (opts.owningGoal.status !== "active") return false;
  if (opts.busy) return false;
  if (opts.unsentTextLength > 0) return false;
  if (opts.now - opts.lastKeystrokeTs < TYPING_GRACE_MS) return false;
  return true;
}

/**
 * Helper for the "🕒 Auto-run in Xs" badge the goal-status pill
 * surfaces in the UI. Returns the seconds remaining until the next
 * scheduled tick, or `null` if auto-run is currently gated off (e.g.
 * busy, or the user is typing).
 *
 * `nextTickAt` is the unix-ms the driver expects to fire next. The
 * driver maintains this state in tandem with its `setInterval`.
 */
export function autoRunCountdownSeconds(opts: {
  owningGoal: { status: string } | null;
  busy: boolean;
  unsentTextLength: number;
  lastKeystrokeTs: number;
  now: number;
  nextTickAt: number;
}): number | null {
  // Same gating as shouldAutoRunNextRound — if the tick wouldn't fire,
  // the badge shouldn't tease a countdown.
  if (!opts.owningGoal) return null;
  if (opts.owningGoal.status !== "active") return null;
  if (opts.busy) return null;
  if (opts.unsentTextLength > 0) return null;
  if (opts.now - opts.lastKeystrokeTs < TYPING_GRACE_MS) return null;
  const remainingMs = Math.max(0, opts.nextTickAt - opts.now);
  return Math.ceil(remainingMs / 1000);
}
