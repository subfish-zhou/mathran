/**
 * Blocked-state machine — guards against premature `status: blocked`.
 *
 * Codex insight (spec §4.4): models prematurely declare blocked when they
 * hit any first transient failure. The fix is a 3-consecutive-turn threshold
 * on the SAME blocker signature. Different blocker → reset counter to 1.
 * A clean turn (status=active/complete) → reset to 0.
 *
 * Persistence: caller passes `initialConsecutive` + `initialSignature`
 * loaded from the `assistant_goal_runs` row, and re-persists the snapshot()
 * after each evaluate()/reset().
 *
 * Ported: 2026-06-10 (commit 5a/6 of mathub-ai-codex-upgrade).
 */

import { createHash } from "crypto";

export interface BlockedStateSnapshot {
  consecutiveBlockedTurns: number;
  lastBlockSignature?: string;
}

export interface BlockedDecision {
  /** True iff the threshold is met and the run may transition to status=blocked. */
  allowBlocked: boolean;
  /** Count of consecutive turns with the same blocker (post-increment). */
  consecutiveTurns: number;
  /** Whether this turn's blocker matched the prior blocker's signature. */
  sameAsLast: boolean;
  /** The (truncated) signature this turn was bucketed under. */
  signature: string;
}

const DEFAULT_THRESHOLD = 3;
const SIGNATURE_LEN = 16;

/**
 * Compute the per-turn blocker signature. We hash `reason + errorClass`
 * because either alone is too coarse:
 * - reason alone collides for "rate-limited" vs "rate-limited (with different
 *   provider)" if model paraphrases.
 * - errorClass alone groups all "TimeoutError"s together regardless of which
 *   resource timed out.
 *
 * Exported for tests + callers that want to dedupe blockers across runs.
 */
export function makeBlockSignature(reason: string, errorClass?: string): string {
  const input = `${reason ?? ""}\n${errorClass ?? ""}`.trim();
  return createHash("sha256").update(input).digest("hex").slice(0, SIGNATURE_LEN);
}

export class BlockedStateMachine {
  private consecutive: number;
  private lastSignature: string | undefined;
  private readonly threshold: number;

  constructor(opts: {
    threshold?: number;
    initialConsecutive?: number;
    initialSignature?: string;
  } = {}) {
    const t = opts.threshold ?? DEFAULT_THRESHOLD;
    this.threshold = Math.max(1, Math.floor(t));
    this.consecutive = Math.max(0, Math.floor(opts.initialConsecutive ?? 0));
    this.lastSignature = opts.initialSignature;
  }

  /**
   * Evaluate a `status=blocked` request. Increments the counter when the
   * signature matches the prior blocker; resets to 1 otherwise. Returns
   * whether the threshold is now met.
   *
   * Caller MUST persist snapshot() after calling this so a process restart
   * does not lose the counter.
   */
  evaluate(reason: string, errorClass?: string): BlockedDecision {
    const sig = makeBlockSignature(reason, errorClass);
    const sameAsLast = sig === this.lastSignature;

    if (sameAsLast) {
      this.consecutive += 1;
    } else {
      this.consecutive = 1;
      this.lastSignature = sig;
    }

    return {
      allowBlocked: this.consecutive >= this.threshold,
      consecutiveTurns: this.consecutive,
      sameAsLast,
      signature: sig,
    };
  }

  /**
   * Reset the machine when the run transitions out of blocked-pending state
   * (e.g., status='active' on a productive turn, or status='complete').
   */
  reset(): void {
    this.consecutive = 0;
    this.lastSignature = undefined;
  }

  /** Configured threshold (default 3). */
  get effectiveThreshold(): number {
    return this.threshold;
  }

  /** Current consecutive count. */
  get currentCount(): number {
    return this.consecutive;
  }

  /** Current signature (undefined when reset). */
  get currentSignature(): string | undefined {
    return this.lastSignature;
  }

  /** Snapshot suitable for DB persistence. */
  snapshot(): BlockedStateSnapshot {
    const out: BlockedStateSnapshot = {
      consecutiveBlockedTurns: this.consecutive,
    };
    if (this.lastSignature !== undefined) {
      out.lastBlockSignature = this.lastSignature;
    }
    return out;
  }
}
