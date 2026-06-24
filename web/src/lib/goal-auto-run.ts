/**
 * goal-auto-run — compile-time noop shim (C4, todo1-design.md §5.4).
 *
 * Before TODO-1 Phase 2 (C4), this file housed the SPA's `setInterval`
 * auto-run gate: every 120s the ChatPanel asked
 * `shouldAutoRunNextRound(...)` whether to POST `/api/goals/:id/run`
 * to kick the next goal iteration, and rendered a "🕒 Auto-run in Xs"
 * countdown via `autoRunCountdownSeconds(...)`.
 *
 * After C4 the **server-side GoalDaemon** owns goal-loop progress
 * (see `src/core/goal/daemon.ts`, `src/server/serve.ts`), so the SPA
 * no longer needs a timer driver at all — it is now a **passive
 * observer**. The ChatPanel `setInterval(AUTO_RUN_TICK_MS, …)` and
 * the countdown badge have been deleted.
 *
 * What remains here:
 *   * The exported names (`shouldAutoRunNextRound`,
 *     `autoRunCountdownSeconds`, `AUTO_RUN_TICK_MS`, `TYPING_GRACE_MS`,
 *     `AutoRunGateInputs`) survive as **noop shims** so any out-of-tree
 *     importer (e.g. an old reference in a future rebase, a leftover
 *     test, or a downstream fork) keeps compiling.
 *   * `shouldAutoRunNextRound` returns `false` unconditionally — there
 *     is no SPA-side driver to gate any more.
 *   * `autoRunCountdownSeconds` returns `null` unconditionally — there
 *     is no countdown to display.
 *
 * The companion test file (`goal-auto-run.test.ts`) was deleted with
 * this change: it pinned the gating *policy*, and the policy no longer
 * exists.
 */

export interface AutoRunGateInputs {
  /** Retained for source-compat; ignored by the shim. */
  owningGoal: { status: string } | null;
  /** Retained for source-compat; ignored by the shim. */
  busy: boolean;
  /** Retained for source-compat; ignored by the shim. */
  unsentTextLength: number;
  /** Retained for source-compat; ignored by the shim. */
  lastKeystrokeTs: number;
  /** Retained for source-compat; ignored by the shim. */
  now: number;
}

/** Retained for source-compat. Value is the pre-C4 historical default. */
export const TYPING_GRACE_MS = 30_000;

/** Retained for source-compat. Value is the pre-C4 historical default. */
export const AUTO_RUN_TICK_MS = 120_000;

/**
 * Noop shim — always `false` after C4.
 *
 * Pre-C4 this decided whether the SPA's `setInterval` driver should
 * POST `/api/goals/:id/run` on the current tick. After C4 the daemon
 * is the sole driver, so there is no SPA-side decision to make.
 */
export function shouldAutoRunNextRound(_opts: AutoRunGateInputs): boolean {
  return false;
}

/**
 * Noop shim — always `null` after C4.
 *
 * Pre-C4 this fed the "🕒 Auto-run in Xs" badge; that badge was
 * removed in C4 (see ChatPanel.tsx).
 */
export function autoRunCountdownSeconds(_opts: {
  owningGoal: { status: string } | null;
  busy: boolean;
  unsentTextLength: number;
  lastKeystrokeTs: number;
  now: number;
  nextTickAt: number;
}): number | null {
  return null;
}
