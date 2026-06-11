/**
 * update_plan tool tests — spec/06-skills.md §4.8.
 *
 * 1. Valid plan → success + getCurrentPlan reflects
 * 2. Invalid status string → error displayText
 * 3. Empty step string → error
 * 4. Non-array plan → error
 * 5. Large plan (100 steps) → success
 * 6. Replaces prior plan (not append)
 * 7. Per-conversation isolation
 *
 * Ported: 2026-06-10 (commit 6a/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  updatePlanTool,
  getCurrentPlan,
  _resetPlansForTest,
} from "../update-plan";
import type { ToolContext } from "../types";

beforeEach(() => {
  _resetPlansForTest();
});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "user-1",
    conversationId: "conv-1",
    // db is required by the type but update-plan does not touch it; cast
    // through unknown to keep the test typed.
    db: undefined as unknown as ToolContext["db"],
    ...overrides,
  };
}

describe("update_plan tool", () => {
  it("accepts a valid plan and stores it", async () => {
    const res = await updatePlanTool.execute(
      {
        plan: [
          { step: "Read spec", status: "completed" },
          { step: "Write code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
        explanation: "Initial plan",
      },
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(res.displayText).toContain("3 steps");
    expect(res.displayText).toContain("1 done");
    expect(res.displayText).toContain("1 in progress");
    expect(res.displayText).toContain("1 pending");

    const stored = getCurrentPlan("user-1", "conv-1");
    expect(stored?.steps).toHaveLength(3);
    expect(stored?.explanation).toBe("Initial plan");
  });

  it("rejects an invalid status enum value", async () => {
    const res = await updatePlanTool.execute(
      { plan: [{ step: "x", status: "bogus" }] },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("status");
  });

  it("rejects an empty step string", async () => {
    const res = await updatePlanTool.execute(
      { plan: [{ step: "  ", status: "pending" }] },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("non-empty string");
  });

  it("rejects a non-array plan", async () => {
    const res = await updatePlanTool.execute(
      { plan: "not an array" },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("array");
  });

  it("accepts a large plan (100 steps)", async () => {
    const plan = Array.from({ length: 100 }, (_, i) => ({
      step: `step ${i + 1}`,
      status: "pending" as const,
    }));
    const res = await updatePlanTool.execute({ plan }, makeCtx());
    expect(res.success).toBe(true);
    expect(getCurrentPlan("user-1", "conv-1")?.steps).toHaveLength(100);
  });

  it("replaces the prior plan (not append)", async () => {
    await updatePlanTool.execute(
      { plan: [{ step: "old", status: "completed" }] },
      makeCtx(),
    );
    await updatePlanTool.execute(
      {
        plan: [
          { step: "new1", status: "pending" },
          { step: "new2", status: "pending" },
        ],
      },
      makeCtx(),
    );
    const stored = getCurrentPlan("user-1", "conv-1");
    expect(stored?.steps.map((s) => s.step)).toEqual(["new1", "new2"]);
  });

  it("isolates plans per (user, conversation) pair", async () => {
    await updatePlanTool.execute(
      { plan: [{ step: "a", status: "pending" }] },
      makeCtx({ userId: "user-1", conversationId: "conv-A" }),
    );
    await updatePlanTool.execute(
      { plan: [{ step: "b", status: "pending" }] },
      makeCtx({ userId: "user-1", conversationId: "conv-B" }),
    );
    expect(getCurrentPlan("user-1", "conv-A")?.steps[0]?.step).toBe("a");
    expect(getCurrentPlan("user-1", "conv-B")?.steps[0]?.step).toBe("b");
    expect(getCurrentPlan("user-2", "conv-A")).toBeUndefined();
  });

  it("includes 'cancelled' count in summary when applicable", async () => {
    const res = await updatePlanTool.execute(
      {
        plan: [
          { step: "a", status: "completed" },
          { step: "b", status: "cancelled" },
          { step: "c", status: "cancelled" },
        ],
      },
      makeCtx(),
    );
    expect(res.success).toBe(true);
    expect(res.displayText).toContain("2 cancelled");
  });
});
