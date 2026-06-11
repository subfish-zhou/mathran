/**
 * Goal budget accounting — token + monotonic wall-clock dual accounting.
 *
 * Ported from codex `codex-rs/ext/goal/src/accounting.rs`. Two key design
 * points:
 *
 * 1. **Monotonic clock**. We measure elapsed time with `process.hrtime.bigint()`
 *    so a system clock jump (NTP, suspend/resume, manual change) does not
 *    poison the wall-clock budget. The "wall start ms" is persisted only so
 *    we can render a friendly created-at date for the UI; budget decisions
 *    always use hrtime delta.
 *
 * 2. **Rehydratable across process restarts**. `initialTokensUsed` and
 *    `initialTimeUsedSeconds` rehydrate from the `assistant_goal_runs` row.
 *    On restart, the monotonic clock starts fresh; we add the elapsed-since-
 *    restart to the persisted total when reading `timeUsedSeconds`.
 *
 * Ported: 2026-06-10 (commit 5a/6 of mathub-ai-codex-upgrade).
 */

export interface GoalBudgetSnapshot {
  tokensUsed: number;
  timeUsedSeconds: number;
}

export class GoalBudgetAccounting {
  private tokensUsed: number;
  private readonly initialTimeUsedSeconds: number;
  private readonly startMono: bigint;
  private readonly wallStartMs: number;
  /** Per-turn token deltas — useful for replay / partial-failure audit. */
  private readonly turnTokens = new Map<string, number>();

  constructor(
    opts: {
      initialTokensUsed?: number;
      initialTimeUsedSeconds?: number;
      wallStartMs?: number;
    } = {},
  ) {
    this.tokensUsed = opts.initialTokensUsed ?? 0;
    this.initialTimeUsedSeconds = opts.initialTimeUsedSeconds ?? 0;
    this.startMono = process.hrtime.bigint();
    this.wallStartMs = opts.wallStartMs ?? Date.now();
  }

  /**
   * Record the start of a turn so per-turn accounting starts at 0 for that
   * turn. Calling again for the same turnId is a no-op (idempotent).
   */
  recordTurnStart(turnId: string): void {
    if (!this.turnTokens.has(turnId)) {
      this.turnTokens.set(turnId, 0);
    }
  }

  /**
   * Add `count` tokens to both the total and the per-turn counter. Negative
   * counts are clamped to 0 (we never subtract — corrections should overwrite
   * via a new budget snapshot, not negate).
   */
  recordTokens(turnId: string, count: number): void {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return;
    this.tokensUsed += n;
    const prior = this.turnTokens.get(turnId) ?? 0;
    this.turnTokens.set(turnId, prior + n);
  }

  /** Optional explicit turn-end hook; currently a no-op but reserved. */
  recordTurnEnd(_turnId: string): void {
    // Intentionally empty; per-turn totals stay in the map for inspection.
  }

  /** Cumulative token usage across all turns since rehydrate / fresh start. */
  get totalTokens(): number {
    return this.tokensUsed;
  }

  /**
   * Total wall-clock seconds on this goal: persisted-from-prior-restarts +
   * since-current-process-start (via hrtime). Floored to whole seconds.
   */
  get timeUsedSeconds(): number {
    const sinceStartNs = process.hrtime.bigint() - this.startMono;
    const sinceStartSec = Number(sinceStartNs / BigInt(1_000_000_000));
    return this.initialTimeUsedSeconds + sinceStartSec;
  }

  /** Original wall-clock ms when the goal first started (for UI display). */
  get wallStartedAtMs(): number {
    return this.wallStartMs;
  }

  /** Cumulative tokens consumed by a specific turn (0 if unknown). */
  tokensForTurn(turnId: string): number {
    return this.turnTokens.get(turnId) ?? 0;
  }

  /** All recorded turns (insertion order). */
  recordedTurns(): string[] {
    return Array.from(this.turnTokens.keys());
  }

  /** Snapshot suitable for DB persistence. */
  snapshot(): GoalBudgetSnapshot {
    return {
      tokensUsed: this.tokensUsed,
      timeUsedSeconds: this.timeUsedSeconds,
    };
  }

  /**
   * Compute whether this run has exceeded the budget. Returns null if no
   * budget set; true/false otherwise. Caller decides whether to transition
   * status to `budget_limited`.
   */
  exceedsBudget(budget: number | null | undefined): boolean | null {
    if (budget == null) return null;
    return this.tokensUsed >= budget;
  }

  /** Remaining tokens if budget set, else null. May be negative if exceeded. */
  remainingTokens(budget: number | null | undefined): number | null {
    if (budget == null) return null;
    return budget - this.tokensUsed;
  }
}
