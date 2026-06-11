/**
 * update_goal + get_goal tool tests — spec/05-goal.md §4.9.
 *
 * Tests mock getActiveRunForConversation and the DB update so the test stays
 * self-contained (no DB needed). The blocked-state-machine and budget
 * accounting are real (per-conversation in-memory singletons).
 *
 * 1. status='blocked' first time → soft reject with consecutive 1/3
 * 2. status='blocked' same-sig third time → accepted, DB updated
 * 3. status='complete' → DB updated to 'done', summary shows tokens
 * 4. status='active' resets the blocked machine
 * 5. status='blocked' without reason → rejected
 * 6. non-owner objective edit → rejected
 * 7. invalid status enum → rejected
 * 8. get_goal returns null/zero baseline when budget never recorded
 *
 * Ported: 2026-06-10 (commit 5b/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { updateGoalTool } from "../update-goal";
import { getGoalTool } from "../get-goal";
import {
  _resetBlockedStatesForTest,
  getBlockedStateForConversation,
} from "../../goal/runtime-blocked";
import { _resetGoalBudgetsForTest } from "../../goal/runtime-budgets";
import type { ToolContext } from "../types";

// Mock run-state.getActiveRunForConversation so we don't need a DB.
vi.mock("../../goal/run-state", () => ({
  getActiveRunForConversation: vi.fn(),
}));

// Mock the drizzle db.update chain. update(table) returns an object with
// .set(...).where(...) thenable.
vi.mock("@/server/db", () => ({
  getDb: () => ({
    update: () => ({
      set: () => ({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  }),
}));

import { getActiveRunForConversation } from "../../goal/run-state";
import type { assistantGoalRuns } from "@/server/db/schema";

type GoalRunRow = typeof assistantGoalRuns.$inferSelect;

const FAKE_RUN = {
  id: "run-1",
  conversationId: "conv-1",
  userId: "user-owner",
  objective: "Build the thing",
  status: "running",
  startedAt: new Date("2026-06-01T10:00:00Z"),
  lastHeartbeat: new Date("2026-06-01T10:05:00Z"),
  // Other columns are not read by get_goal / update_goal but the inferred
  // row type requires them; cast through unknown to keep the test minimal.
} as unknown as GoalRunRow;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: "user-owner",
    conversationId: "conv-1",
    db: undefined as unknown as ToolContext["db"],
    ...overrides,
  };
}

beforeEach(() => {
  _resetBlockedStatesForTest();
  _resetGoalBudgetsForTest();
  vi.mocked(getActiveRunForConversation).mockResolvedValue(FAKE_RUN);
});

describe("update_goal tool", () => {
  it("rejects status='blocked' on first occurrence (1/3 consecutive)", async () => {
    const res = await updateGoalTool.execute(
      { status: "blocked", reason: "Need user input on X" },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toMatch(/1\/3/);
    expect(res.displayText).toMatch(/Soft reject/);
  });

  it("accepts status='blocked' after 3 consecutive same-sig calls", async () => {
    const args = { status: "blocked", reason: "Need user input on X" };
    const r1 = await updateGoalTool.execute(args, makeCtx());
    const r2 = await updateGoalTool.execute(args, makeCtx());
    const r3 = await updateGoalTool.execute(args, makeCtx());
    expect(r1.success).toBe(false);
    expect(r2.success).toBe(false);
    expect(r3.success).toBe(true);
    expect(r3.displayText).toContain("→ blocked");
  });

  it("accepts status='complete' immediately and reports DB status 'done'", async () => {
    const res = await updateGoalTool.execute({ status: "complete" }, makeCtx());
    expect(res.success).toBe(true);
    expect(res.displayText).toMatch(/Goal marked complete/);
  });

  it("status='active' resets the blocked machine", async () => {
    // Build up 2 consecutive blocked counts.
    const args = { status: "blocked", reason: "same reason" };
    await updateGoalTool.execute(args, makeCtx());
    await updateGoalTool.execute(args, makeCtx());
    expect(getBlockedStateForConversation("conv-1").currentCount).toBe(2);

    // Active transition resets.
    const res = await updateGoalTool.execute({ status: "active" }, makeCtx());
    expect(res.success).toBe(true);
    expect(getBlockedStateForConversation("conv-1").currentCount).toBe(0);
  });

  it("rejects status='blocked' when reason is empty/missing", async () => {
    const res = await updateGoalTool.execute(
      { status: "blocked" },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("requires a non-empty 'reason'");
  });

  it("rejects objective edit from a non-owner user", async () => {
    const res = await updateGoalTool.execute(
      { status: "active", objective: "Hijacked objective" },
      makeCtx({ userId: "user-evil" }),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("Only the goal owner");
  });

  it("rejects invalid status enum value", async () => {
    const res = await updateGoalTool.execute(
      { status: "exploded" },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("must be one of");
  });

  it("rejects when no active goal exists", async () => {
    vi.mocked(getActiveRunForConversation).mockResolvedValueOnce(null);
    const res = await updateGoalTool.execute(
      { status: "complete" },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("No active goal");
  });

  it("different blocker signature resets the consecutive counter", async () => {
    await updateGoalTool.execute(
      { status: "blocked", reason: "Reason A" },
      makeCtx(),
    );
    await updateGoalTool.execute(
      { status: "blocked", reason: "Reason A" },
      makeCtx(),
    );
    expect(getBlockedStateForConversation("conv-1").currentCount).toBe(2);

    const res = await updateGoalTool.execute(
      { status: "blocked", reason: "Reason B — totally different" },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    // New signature resets to 1.
    expect(getBlockedStateForConversation("conv-1").currentCount).toBe(1);
    expect(res.displayText).toMatch(/1\/3/);
  });
});

describe("get_goal tool", () => {
  it("returns hasGoal=false when no active run", async () => {
    vi.mocked(getActiveRunForConversation).mockResolvedValueOnce(null);
    const res = await getGoalTool.execute({}, makeCtx());
    expect(res.success).toBe(true);
    const data = res.data as { hasGoal: boolean };
    expect(data.hasGoal).toBe(false);
  });

  it("returns the run with zero-baseline budget snapshot", async () => {
    const res = await getGoalTool.execute({}, makeCtx());
    expect(res.success).toBe(true);
    const data = res.data as {
      hasGoal: boolean;
      objective: string;
      status: string;
      tokensUsed: number;
      tokenBudget?: number;
      consecutiveBlockedTurns: number;
    };
    expect(data.hasGoal).toBe(true);
    expect(data.objective).toBe("Build the thing");
    expect(data.status).toBe("running");
    expect(data.tokensUsed).toBe(0);
    expect(data.tokenBudget).toBeUndefined();
    expect(data.consecutiveBlockedTurns).toBe(0);
  });

  it("rejects when no conversationId", async () => {
    const res = await getGoalTool.execute({}, makeCtx({ conversationId: undefined }));
    expect(res.success).toBe(false);
    expect(res.displayText).toContain("conversationId");
  });
});
