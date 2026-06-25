/**
 * Layer 1 — token budget continuation unit tests.
 *
 * Spec: DESIGN-REFERENCE.md §7.7. Pure-library coverage of
 * `checkGoalBudget` + `getBudgetContinuationMessage`. The deterministic
 * decision is the whole point of Layer 1 — these tests pin every branch
 * (sub-goal gate, no/negative budget, continue path, count increment,
 * diminishing returns guard, completion threshold) plus the exact,
 * load-bearing nudge wording.
 */
import { describe, it, expect } from "vitest";

import {
  checkGoalBudget,
  getBudgetContinuationMessage,
  type BudgetTracker,
  COMPLETION_THRESHOLD,
  DIMINISHING_THRESHOLD,
} from "./budget-continuation.js";

const tracker = (over: Partial<BudgetTracker> = {}): BudgetTracker => ({
  continuationCount: 0,
  lastDeltaTokens: 0,
  lastCheckTokens: 0,
  ...over,
});

describe("checkGoalBudget", () => {
  it("sub-goal (isSubGoal=true) → 'stop' regardless of budget", () => {
    const d = checkGoalBudget(tracker(), 10_000, 100, true);
    expect(d.action).toBe("stop");
  });

  it("budget === null → 'stop'", () => {
    const d = checkGoalBudget(tracker(), null, 100, false);
    expect(d.action).toBe("stop");
  });

  it("budget <= 0 → 'stop'", () => {
    expect(checkGoalBudget(tracker(), 0, 100, false).action).toBe("stop");
    expect(checkGoalBudget(tracker(), -5, 100, false).action).toBe("stop");
  });

  it("currentTokens < 0.9*budget, count=0 → 'continue', count=1", () => {
    const d = checkGoalBudget(tracker(), 10_000, 2_000, false);
    expect(d.action).toBe("continue");
    if (d.action === "continue") {
      expect(d.continuationCount).toBe(1);
      expect(d.turnTokens).toBe(2_000);
      expect(d.budget).toBe(10_000);
      expect(d.pct).toBe(20);
      expect(typeof d.nudgeMessage).toBe("string");
    }
  });

  it("four consecutive continues advance the tracker to count=4", () => {
    // Simulate the per-goal persistence loop: after each 'continue' the
    // caller writes continuationCount / lastDeltaTokens / lastCheckTokens
    // back onto the tracker (mirrors runner.ts maybeContinueByBudget).
    const t = tracker();
    let used = 0;
    for (let i = 1; i <= 4; i++) {
      used += 1_000; // Δ = 1000 > 500 each round → never diminishing
      const d = checkGoalBudget(t, 100_000, used, false);
      expect(d.action).toBe("continue");
      if (d.action === "continue") {
        expect(d.continuationCount).toBe(i);
        t.lastDeltaTokens = used - t.lastCheckTokens;
        t.lastCheckTokens = used;
        t.continuationCount = d.continuationCount;
      }
    }
    expect(t.continuationCount).toBe(4);
  });

  it("Δ<500 AND count>=3 → 'stop' with diminishingReturns:true", () => {
    // count=3, prior delta < 500, and this check moves only 200 tokens.
    const t = tracker({
      continuationCount: 3,
      lastDeltaTokens: 400,
      lastCheckTokens: 1_000,
    });
    const d = checkGoalBudget(t, 100_000, 1_200, false);
    expect(d.action).toBe("stop");
    if (d.action === "stop") expect(d.diminishingReturns).toBe(true);
  });

  it("Δ>500 AND count>=3 → still 'continue' (productive work continues)", () => {
    const t = tracker({
      continuationCount: 3,
      lastDeltaTokens: 1_000,
      lastCheckTokens: 1_000,
    });
    const d = checkGoalBudget(t, 100_000, 2_000, false); // Δ = 1000 > 500
    expect(d.action).toBe("continue");
    if (d.action === "continue") expect(d.continuationCount).toBe(4);
  });

  it("currentTokens > 0.9*budget → 'stop'", () => {
    const d = checkGoalBudget(tracker(), 1_000, 950, false); // 95% > 90%
    expect(d.action).toBe("stop");
    if (d.action === "stop") expect(d.diminishingReturns).toBeFalsy();
  });
});

describe("getBudgetContinuationMessage", () => {
  it("matches the exact CC wording (comma thousands + em-dash)", () => {
    expect(getBudgetContinuationMessage(47, 1_234, 2_600)).toBe(
      "Stopped at 47% of token target (1,234 / 2,600). Keep working \u2014 do not summarize.",
    );
  });
});

describe("constants", () => {
  it("threshold constants match the CC source", () => {
    expect(COMPLETION_THRESHOLD).toBe(0.9);
    expect(DIMINISHING_THRESHOLD).toBe(500);
  });
});
