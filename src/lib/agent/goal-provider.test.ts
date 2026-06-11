import { describe, it, expect } from "vitest";
import {
  decideGateAction,
  parseEvalResult,
  autonomyClause,
  SAFE_FALLBACK_EVAL,
  type GoalEvalResult,
} from "./goal-provider";

/**
 * Unit tests for the Goal Supervisor gate decision + verdict parsing.
 * Locks the three-branch (done / needsUser / continue) semantics and the
 * tolerant JSON parser's conservative fallback so refactors can't silently
 * regress runaway protection.
 */

describe("decideGateAction (three-branch gate)", () => {
  const enabled = { enabled: true };

  it("done=true → 'done'", () => {
    const r: GoalEvalResult = { done: true, needsUser: false };
    expect(decideGateAction(r, enabled)).toBe("done");
  });

  it("needsUser=true (and !done) → 'needsUser'", () => {
    const r: GoalEvalResult = { done: false, needsUser: true, reason: "缺信息" };
    expect(decideGateAction(r, enabled)).toBe("needsUser");
  });

  it("not done, not needsUser → 'continue'", () => {
    const r: GoalEvalResult = { done: false, needsUser: false, nextHint: "继续" };
    expect(decideGateAction(r, enabled)).toBe("continue");
  });

  it("done takes precedence over needsUser", () => {
    const r: GoalEvalResult = { done: true, needsUser: true };
    expect(decideGateAction(r, enabled)).toBe("done");
  });

  it("disabled config → always 'done' (defensive; executor short-circuits earlier)", () => {
    const r: GoalEvalResult = { done: false, needsUser: false };
    expect(decideGateAction(r, { enabled: false })).toBe("done");
  });
});

describe("parseEvalResult (tolerant JSON verdict parser)", () => {
  it("parses a clean JSON object", () => {
    const r = parseEvalResult(
      '{"done": true, "needsUser": false, "nextHint": "x", "reason": "y"}',
    );
    expect(r.done).toBe(true);
    expect(r.needsUser).toBe(false);
    expect(r.nextHint).toBe("x");
    expect(r.reason).toBe("y");
  });

  it("strips ```json code fences", () => {
    const r = parseEvalResult('```json\n{"done": false, "needsUser": true}\n```');
    expect(r.done).toBe(false);
    expect(r.needsUser).toBe(true);
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const r = parseEvalResult('好的，结论是 {"done": true, "needsUser": false} 完成');
    expect(r.done).toBe(true);
  });

  it("falls back conservatively on empty input", () => {
    expect(parseEvalResult("")).toEqual(SAFE_FALLBACK_EVAL);
  });

  it("falls back conservatively on non-JSON garbage", () => {
    expect(parseEvalResult("not json at all")).toEqual(SAFE_FALLBACK_EVAL);
  });

  it("falls back conservatively on malformed JSON", () => {
    expect(parseEvalResult('{"done": tru')).toEqual(SAFE_FALLBACK_EVAL);
  });

  it("coerces non-boolean done/needsUser to false", () => {
    const r = parseEvalResult('{"done": "yes", "needsUser": 1}');
    expect(r.done).toBe(false);
    expect(r.needsUser).toBe(false);
  });

  it("fallback is non-terminating (done=false, needsUser=false) → 'continue'", () => {
    const r = parseEvalResult("garbage");
    expect(decideGateAction(r, { enabled: true })).toBe("continue");
  });
});

describe("autonomyClause", () => {
  it("aggressive mentions 自己扛", () => {
    expect(autonomyClause("aggressive")).toContain("激进");
  });
  it("conservative biases toward interrupting", () => {
    expect(autonomyClause("conservative")).toContain("保守");
  });
  it("balanced is the default fallback", () => {
    expect(autonomyClause("balanced")).toContain("平衡");
  });
});

// [commit-5c] decideGateAction × budget-check tests.
describe("decideGateAction × budgetCheck (commit 5c)", () => {
  const ENABLED = { enabled: true };
  const CONT = { done: false, needsUser: false } as const;
  const DONE = { done: true, needsUser: false } as const;

  it("returns 'budgetLimited' when tokensUsed >= tokenBudget", () => {
    expect(
      decideGateAction(CONT, ENABLED, { tokensUsed: 1500, tokenBudget: 1000 }),
    ).toBe("budgetLimited");
  });

  it("budgetLimited fires even when evalResult would be 'done'", () => {
    // Codex behavior: budget limit takes priority over normal completion so the
    // model gets a chance to write a budget-aware summary turn.
    expect(
      decideGateAction(DONE, ENABLED, { tokensUsed: 9999, tokenBudget: 1000 }),
    ).toBe("budgetLimited");
  });

  it("returns normal action when tokensUsed < tokenBudget", () => {
    expect(
      decideGateAction(CONT, ENABLED, { tokensUsed: 100, tokenBudget: 1000 }),
    ).toBe("continue");
  });

  it("treats tokenBudget=null as unlimited", () => {
    expect(
      decideGateAction(CONT, ENABLED, { tokensUsed: 999999, tokenBudget: null }),
    ).toBe("continue");
  });

  it("treats tokenBudget=undefined as unlimited", () => {
    expect(
      decideGateAction(CONT, ENABLED, { tokensUsed: 999999, tokenBudget: undefined }),
    ).toBe("continue");
  });

  it("treats tokenBudget=0 as unlimited (defensive)", () => {
    expect(
      decideGateAction(CONT, ENABLED, { tokensUsed: 999999, tokenBudget: 0 }),
    ).toBe("continue");
  });

  it("budgetCheck arg is optional — three-branch behavior preserved", () => {
    expect(decideGateAction(CONT, ENABLED)).toBe("continue");
    expect(decideGateAction(DONE, ENABLED)).toBe("done");
  });
});
