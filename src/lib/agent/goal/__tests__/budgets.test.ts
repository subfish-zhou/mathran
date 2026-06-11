/**
 * GoalBudgetAccounting tests — spec/05-goal.md §4.9.
 *
 * 1. recordTokens 累加正确
 * 2. timeUsedSeconds 单调递增 + 含 initial 偏移
 * 3. snapshot 与内部状态一致
 * 4. 0 init + 累计正确
 * 5. 多个 turn 各自累计 (turnTokens map)
 * 6. rehydrate (initialTokensUsed) 后继续累计正确
 * 7. exceedsBudget / remainingTokens 行为
 *
 * Ported: 2026-06-10 (commit 5a/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect } from "vitest";
import { GoalBudgetAccounting } from "../budgets";

describe("GoalBudgetAccounting", () => {
  it("recordTokens accumulates totalTokens", () => {
    const acct = new GoalBudgetAccounting();
    acct.recordTurnStart("t1");
    acct.recordTokens("t1", 100);
    acct.recordTokens("t1", 250);
    expect(acct.totalTokens).toBe(350);
  });

  it("timeUsedSeconds is monotonic and includes initial offset", async () => {
    const acct = new GoalBudgetAccounting({ initialTimeUsedSeconds: 42 });
    const before = acct.timeUsedSeconds;
    expect(before).toBeGreaterThanOrEqual(42);
    // Real sleep so hrtime advances by ~50ms; budget reports whole seconds
    // so it may still be 42 immediately — repeated reads must not decrease.
    await new Promise((r) => setTimeout(r, 30));
    const after = acct.timeUsedSeconds;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("snapshot returns the same numbers as totalTokens/timeUsedSeconds", () => {
    const acct = new GoalBudgetAccounting({ initialTokensUsed: 5 });
    acct.recordTurnStart("t1");
    acct.recordTokens("t1", 15);
    const snap = acct.snapshot();
    expect(snap.tokensUsed).toBe(20);
    expect(snap.timeUsedSeconds).toBe(acct.timeUsedSeconds);
  });

  it("fresh-start (no initials) starts at 0 tokens and small wall time", () => {
    const acct = new GoalBudgetAccounting();
    expect(acct.totalTokens).toBe(0);
    expect(acct.timeUsedSeconds).toBeGreaterThanOrEqual(0);
    expect(acct.timeUsedSeconds).toBeLessThan(5);
  });

  it("multiple turns each accumulate in turnTokens", () => {
    const acct = new GoalBudgetAccounting();
    acct.recordTurnStart("t1");
    acct.recordTurnStart("t2");
    acct.recordTokens("t1", 100);
    acct.recordTokens("t2", 200);
    acct.recordTokens("t1", 50);
    expect(acct.tokensForTurn("t1")).toBe(150);
    expect(acct.tokensForTurn("t2")).toBe(200);
    expect(acct.tokensForTurn("unknown")).toBe(0);
    expect(acct.recordedTurns()).toEqual(["t1", "t2"]);
    expect(acct.totalTokens).toBe(350);
  });

  it("rehydrate via initialTokensUsed continues accumulation", () => {
    const acct = new GoalBudgetAccounting({ initialTokensUsed: 1000 });
    acct.recordTurnStart("post-restart-t1");
    acct.recordTokens("post-restart-t1", 250);
    expect(acct.totalTokens).toBe(1250);
    // tokensForTurn is the per-turn delta (excludes pre-restart total)
    expect(acct.tokensForTurn("post-restart-t1")).toBe(250);
  });

  it("exceedsBudget / remainingTokens behave for null + numeric budgets", () => {
    const acct = new GoalBudgetAccounting();
    acct.recordTurnStart("t1");
    acct.recordTokens("t1", 500);

    expect(acct.exceedsBudget(null)).toBeNull();
    expect(acct.exceedsBudget(undefined)).toBeNull();
    expect(acct.remainingTokens(null)).toBeNull();

    expect(acct.exceedsBudget(600)).toBe(false);
    expect(acct.remainingTokens(600)).toBe(100);

    expect(acct.exceedsBudget(500)).toBe(true);
    expect(acct.exceedsBudget(400)).toBe(true);
    expect(acct.remainingTokens(400)).toBe(-100);
  });

  it("recordTokens clamps negatives and floors decimals to 0/int", () => {
    const acct = new GoalBudgetAccounting();
    acct.recordTurnStart("t1");
    acct.recordTokens("t1", -50); // clamped to 0
    acct.recordTokens("t1", 100.7); // floored to 100
    expect(acct.totalTokens).toBe(100);
  });

  it("recordTurnStart is idempotent on the same turnId", () => {
    const acct = new GoalBudgetAccounting();
    acct.recordTurnStart("t1");
    acct.recordTokens("t1", 100);
    acct.recordTurnStart("t1"); // no reset
    expect(acct.tokensForTurn("t1")).toBe(100);
  });
});
