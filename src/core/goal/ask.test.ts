/**
 * Tests for goal-ask context builder — NEW-F7.
 */

import { describe, it, expect } from "vitest";
import { buildGoalAskContext } from "./ask.js";
import type { Goal, GoalStep } from "./store.js";

function fakeGoal(overrides: Partial<Goal>): Goal {
  return {
    id: "g-ask-test",
    objective: "default obj",
    scope: { kind: "global" },
    model: "fake-model",
    status: "active",
    conversationIds: [],
    createdAt: "2026-06-24T20:00:00.000Z",
    steps: [],
    budget: { tokensMax: null, roundsMax: null },
    stats: {
      tokensUsed: 0,
      iterationsRun: 0,
      roundsRun: 0,
      assistantTurnsTotal: 0,
      llmCallsTotal: 0,
      toolCallCount: 0,
      compactionRuns: 0,
      compactionTokensDropped: 0,
      lastCompactionReason: null,
      lastCompactionAt: null,
    },
    ...overrides,
  } as Goal;
}

describe("buildGoalAskContext", () => {
  it("includes identity + status + scope + model", () => {
    const g = fakeGoal({ id: "g-x", model: "openai/gpt-4o", scope: { kind: "project", projectSlug: "proj-1" } as any });
    const out = buildGoalAskContext(g);
    expect(out).toContain("id: g-x");
    expect(out).toContain("status: active");
    expect(out).toContain("scope: project:proj-1");
    expect(out).toContain("model: openai/gpt-4o");
  });

  it("renders effort scope correctly", () => {
    const g = fakeGoal({ scope: { kind: "effort", projectSlug: "p", effortSlug: "e" } as any });
    expect(buildGoalAskContext(g)).toContain("scope: effort:p/e");
  });

  it("includes endedAt + endReason when present", () => {
    const g = fakeGoal({ status: "complete" as any, endedAt: "2026-06-24T21:00:00.000Z", endReason: "user mark_done" });
    const out = buildGoalAskContext(g);
    expect(out).toContain("endedAt: 2026-06-24T21:00:00.000Z");
    expect(out).toContain("endReason: user mark_done");
  });

  it("truncates very long objectives", () => {
    const long = "A".repeat(2000);
    const g = fakeGoal({ objective: long });
    const out = buildGoalAskContext(g);
    expect(out).toContain("…(truncated)");
    const aRun = out.match(/A{2,}/)?.[0] ?? "";
    expect(aRun.length).toBeLessThanOrEqual(600);
  });

  it("renders progress stats", () => {
    const g = fakeGoal({
      stats: {
        ...fakeGoal({}).stats,
        iterationsRun: 5,
        toolCallCount: 27,
        tokensUsed: 12345,
      } as any,
      budget: { tokensMax: 50000, roundsMax: 30 } as any,
    });
    const out = buildGoalAskContext(g);
    expect(out).toContain("iterationsRun: 5");
    expect(out).toContain("toolCallCount: 27");
    expect(out).toContain("tokensUsed: 12345");
    expect(out).toContain("tokensMax: 50000");
    expect(out).toContain("roundsMax: 30");
  });

  it("includes compaction stats when present", () => {
    const g = fakeGoal({
      stats: {
        ...fakeGoal({}).stats,
        compactionRuns: 2,
        compactionTokensDropped: 50000,
      } as any,
    });
    const out = buildGoalAskContext(g);
    expect(out).toContain("compactionRuns: 2");
    expect(out).toContain("compactionTokensDropped: 50000");
  });

  it("skips compaction section when never run", () => {
    const g = fakeGoal({});
    expect(buildGoalAskContext(g)).not.toContain("compactionRuns:");
  });

  it("renders plan body when provided", () => {
    const g = fakeGoal({});
    const out = buildGoalAskContext(g, { planBody: "# Plan\n- [ ] step 1\n- [ ] step 2" });
    expect(out).toContain("## Active plan");
    expect(out).toContain("step 1");
  });

  it("truncates very long plan body", () => {
    const g = fakeGoal({});
    const longPlan = "B".repeat(8000);
    const out = buildGoalAskContext(g, { planBody: longPlan });
    expect(out).toContain("…(truncated)");
    const bRun = out.match(/B{2,}/)?.[0] ?? "";
    expect(bRun.length).toBeLessThanOrEqual(4000);
  });

  it("renders files-changed summary", () => {
    const g = fakeGoal({
      steps: [
        { at: "2026-06-24T20:01:00.000Z", kind: "tool-call", payload: { name: "write_file", argsJson: JSON.stringify({ path: "src/foo.ts" }), toolCallId: "c1" } } as any,
        { at: "2026-06-24T20:01:01.000Z", kind: "tool-result", payload: { toolCallId: "c1", ok: true } } as any,
      ],
    });
    const out = buildGoalAskContext(g);
    expect(out).toContain("## Files changed");
    expect(out).toContain("src/foo.ts");
  });

  it("skips files-changed section when none", () => {
    const g = fakeGoal({});
    expect(buildGoalAskContext(g)).not.toContain("## Files changed");
  });

  it("renders recent steps with payload projection", () => {
    const g = fakeGoal({
      steps: Array.from({ length: 30 }, (_, i) => ({
        at: `2026-06-24T20:${String(i).padStart(2, "0")}:00.000Z`,
        kind: "iteration-end",
        payload: { ok: true, reason: `iter-${i}` },
      } as unknown as GoalStep)),
    });
    const out = buildGoalAskContext(g);
    expect(out).toContain("## Recent audit steps (last 25)");
    // Last step (iter-29) should be present
    expect(out).toContain("iter-29");
    // Earliest 5 should be dropped
    expect(out).not.toContain("iter-0]");
  });

  it("skips recent-steps section when no steps", () => {
    const g = fakeGoal({});
    expect(buildGoalAskContext(g)).not.toContain("## Recent audit steps");
  });

  it("includes the read-only preamble", () => {
    const out = buildGoalAskContext(fakeGoal({}));
    expect(out).toContain("read-only query");
    expect(out).toContain("Do NOT propose actions");
  });
});
