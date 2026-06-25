/**
 * Unit tests for the on-disk Goal store (GAP #11).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createGoal,
  readGoal,
  writeGoal,
  listGoals,
  appendStep,
  updateGoalStats,
  endGoal,
  attachConversation,
  addSubGoalId,
  withinBudget,
  goalFileFor,
  goalsDirFor,
} from "./store.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-goal-test-"));
});

describe("createGoal + readGoal", () => {
  it("creates a goal with sane defaults", async () => {
    const g = await createGoal(workspace, {
      objective: "test objective",
      scope: { kind: "global" },
      model: "copilot/gpt-5.5",
    });
    expect(g.id).toBeTruthy();
    expect(g.objective).toBe("test objective");
    expect(g.status).toBe("active");
    expect(g.budget.tokensMax).toBe(null);
    expect(g.budget.roundsMax).toBe(null);
    expect(g.steps).toHaveLength(1);
    expect(g.steps[0].kind).toBe("objective");

    const round = await readGoal(workspace, g.id);
    expect(round).toEqual(g);
  });

  it("respects explicit budgets", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "copilot/gpt-5.5",
      budgetTokensMax: 1000,
      budgetRoundsMax: 5,
    });
    expect(g.budget.tokensMax).toBe(1000);
    expect(g.budget.roundsMax).toBe(5);
  });

  // goal-defaults-timer (part 2/3): the "额外指令" / additional context
  // field flows from CreateGoalInput.extraInstructions → Goal.extraInstructions
  // and is persisted to disk. The runner picks it up on every round.
  it("persists extraInstructions when provided", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "m",
      extraInstructions: "Speak in haiku.",
    });
    expect(g.extraInstructions).toBe("Speak in haiku.");
    const round = await readGoal(workspace, g.id);
    expect(round?.extraInstructions).toBe("Speak in haiku.");
  });

  it("omits extraInstructions when empty or whitespace", async () => {
    // The REST layer is supposed to strip empty strings before they
    // reach us, but defence-in-depth: createGoal also drops blanks so
    // the on-disk record stays clean (no "extraInstructions":"").
    const g1 = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "m",
    });
    expect(g1.extraInstructions).toBeUndefined();

    const g2 = await createGoal(workspace, {
      objective: "y",
      scope: { kind: "global" },
      model: "m",
      extraInstructions: "   ",
    });
    expect(g2.extraInstructions).toBeUndefined();
  });

  it("writes goal under <workspace>/.mathran/goals/", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "m",
    });
    const file = goalFileFor(workspace, g.id);
    expect(file).toBe(path.join(workspace, ".mathran", "goals", `${g.id}.json`));
    expect((await fs.stat(file)).isFile()).toBe(true);
  });
});

describe("listGoals", () => {
  it("returns [] when no goals/ dir exists", async () => {
    expect(await listGoals(workspace)).toEqual([]);
  });

  it("returns goals newest-first", async () => {
    const a = await createGoal(workspace, {
      objective: "a",
      scope: { kind: "global" },
      model: "m",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await createGoal(workspace, {
      objective: "b",
      scope: { kind: "global" },
      model: "m",
    });
    const list = await listGoals(workspace);
    expect(list.map((g) => g.id)).toEqual([b.id, a.id]);
  });

  it("tolerates a malformed file in goals/", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "m" });
    await fs.writeFile(path.join(goalsDirFor(workspace), "bogus.json"), "not-json", "utf-8");
    const list = await listGoals(workspace);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(g.id);
  });
});

describe("appendStep", () => {
  it("appends a step + persists", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "m" });
    await appendStep(workspace, g.id, { kind: "text", payload: "hello world" });
    const round = await readGoal(workspace, g.id);
    expect(round?.steps).toHaveLength(2);
    expect(round?.steps[1]).toMatchObject({ kind: "text", payload: "hello world" });
  });

  it("silently no-ops on an unknown goal id", async () => {
    await expect(
      appendStep(workspace, "ghost", { kind: "text", payload: "x" }),
    ).resolves.toBeUndefined();
  });
});

describe("updateGoalStats", () => {
  it("accumulates counters across calls", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "m" });
    await updateGoalStats(workspace, g.id, { tokensUsed: 100, roundsRun: 1, toolCallCount: 1 });
    await updateGoalStats(workspace, g.id, { tokensUsed: 50, roundsRun: 1 });
    const round = await readGoal(workspace, g.id);
    expect(round?.stats).toEqual({
      tokensUsed: 150,
      inputTokensUsed: 0,
      outputTokensUsed: 0,
      iterationsRun: 2,
      assistantTurnsTotal: 0,
      llmCallsTotal: 0,
      toolCallCount: 1,
      roundsRun: 2,
      // TODO-2 §3.2 / C7 — compaction stats default to 0/null for goals
      // created without any compaction having run yet.
      compactionRuns: 0,
      compactionTokensDropped: 0,
      lastCompactionReason: null,
      lastCompactionAt: null,
      // Layer 1 — token budget continuation tracker defaults.
      budgetContinuationCount: 0,
      budgetLastDeltaTokens: 0,
      budgetLastCheckTokens: 0,
      // Layer 2 — mark_done review rejection counter default.
      markDoneReviewRejectionCount: 0,
    });
  });

  it("accumulates Phase ζ input/output token split", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "gpt-4o" });
    await updateGoalStats(workspace, g.id, { inputTokensUsed: 300, outputTokensUsed: 700, tokensUsed: 1000 });
    await updateGoalStats(workspace, g.id, { inputTokensUsed: 150, outputTokensUsed: 350, tokensUsed: 500 });
    const round = await readGoal(workspace, g.id);
    expect(round?.stats.inputTokensUsed).toBe(450);
    expect(round?.stats.outputTokensUsed).toBe(1050);
    expect(round?.stats.tokensUsed).toBe(1500);
  });
});

describe("endGoal", () => {
  it("flips status + stamps endedAt + appends a status step", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "m" });
    const ended = await endGoal(workspace, g.id, "complete", "task done");
    expect(ended?.status).toBe("complete");
    expect(ended?.endReason).toBe("task done");
    expect(ended?.endedAt).toBeTruthy();
    expect(ended?.steps.at(-1)?.kind).toBe("status");
    expect((ended?.steps.at(-1)?.payload as any).to).toBe("complete");
  });

  it("returns null on missing id", async () => {
    expect(await endGoal(workspace, "ghost", "complete", "x")).toBe(null);
  });
});

describe("attachConversation", () => {
  it("appends a conversation id and stays idempotent", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "m" });
    await attachConversation(workspace, g.id, "conv-1");
    await attachConversation(workspace, g.id, "conv-1"); // idempotent
    await attachConversation(workspace, g.id, "conv-2");
    const round = await readGoal(workspace, g.id);
    expect(round?.conversationIds).toEqual(["conv-1", "conv-2"]);
  });
});

describe("withinBudget", () => {
  it("ok when no budget set", () => {
    const g = {
      stats: { tokensUsed: 9999, roundsRun: 999, toolCallCount: 0 },
      budget: { tokensMax: null, roundsMax: null },
    } as any;
    expect(withinBudget(g).ok).toBe(true);
  });

  it("trips on token budget", () => {
    const g = {
      stats: { tokensUsed: 100, roundsRun: 0, toolCallCount: 0 },
      budget: { tokensMax: 100, roundsMax: null },
    } as any;
    const r = withinBudget(g);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toMatch(/token budget/);
  });

  it("trips on iteration budget", () => {
    const g = {
      stats: { tokensUsed: 0, iterationsRun: 5, toolCallCount: 0 },
      budget: { tokensMax: null, roundsMax: 5 },
    } as any;
    const r = withinBudget(g);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toMatch(/iteration budget/);
  });
});

describe("writeGoal round-trip", () => {
  it("preserves shape across write+read", async () => {
    const g = await createGoal(workspace, {
      objective: "obj",
      scope: { kind: "effort", projectSlug: "p", effortSlug: "e" },
      model: "m",
      budgetTokensMax: 100,
      budgetRoundsMax: 5,
    });
    g.steps.push({ at: new Date().toISOString(), kind: "tool-call", payload: { name: "lean_check" } });
    g.steps.push({
      at: new Date().toISOString(),
      kind: "tool-result",
      payload: { name: "lean_check", ok: true },
    });
    await writeGoal(workspace, g);
    const round = await readGoal(workspace, g.id);
    expect(round?.steps).toHaveLength(3);
    expect(round?.steps.at(-1)?.kind).toBe("tool-result");
  });

  it("preserves summaryPath across write+read", async () => {
    const g = await createGoal(workspace, {
      objective: "with summary",
      scope: { kind: "global" },
      model: "m",
    });
    g.summaryPath = `.mathran/goals/${g.id}.summary.md`;
    await writeGoal(workspace, g);
    const round = await readGoal(workspace, g.id);
    expect(round?.summaryPath).toBe(`.mathran/goals/${g.id}.summary.md`);
  });

  it("a goal written without summaryPath loads with summaryPath === undefined (backward compat)", async () => {
    const g = await createGoal(workspace, {
      objective: "no summary yet",
      scope: { kind: "global" },
      model: "m",
    });
    const round = await readGoal(workspace, g.id);
    expect(round?.summaryPath).toBeUndefined();
  });
});

// ─── Defect #3: stats migration (roundsRun → iterationsRun) ───────────────
describe("Defect #3 — legacy stats migration", () => {
  it("populates iterationsRun from a legacy goal JSON that only has roundsRun", async () => {
    // Hand-write a pre-defect-#3 goal record: stats carries `roundsRun` but
    // none of the newer iteration / turn counters. Such files live in real
    // workspaces and MUST still load + run.
    const id = "legacy-0001";
    const legacy = {
      id,
      objective: "legacy goal",
      scope: { kind: "global" },
      status: "active",
      budget: { tokensMax: null, roundsMax: 30 },
      model: "m",
      createdAt: new Date().toISOString(),
      stats: { tokensUsed: 4242, roundsRun: 7, toolCallCount: 13 },
      conversationIds: [],
      steps: [],
    };
    const file = goalFileFor(workspace, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(legacy, null, 2) + "\n", "utf-8");

    const g = await readGoal(workspace, id);
    expect(g).not.toBeNull();
    expect(g?.stats.iterationsRun).toBe(7);
    // Deprecated alias is kept in lockstep.
    expect(g?.stats.roundsRun).toBe(7);
    // New counters default to 0 (the legacy file never tracked them).
    expect(g?.stats.assistantTurnsTotal).toBe(0);
    expect(g?.stats.llmCallsTotal).toBe(0);
    // Untouched fields survive the migration.
    expect(g?.stats.tokensUsed).toBe(4242);
    expect(g?.stats.toolCallCount).toBe(13);
  });

  it("prefers iterationsRun over roundsRun when both are present", async () => {
    const id = "mixed-0001";
    const mixed = {
      id,
      objective: "mixed goal",
      scope: { kind: "global" },
      status: "active",
      budget: { tokensMax: null, roundsMax: null },
      model: "m",
      createdAt: new Date().toISOString(),
      stats: {
        tokensUsed: 0,
        roundsRun: 2,
        iterationsRun: 9,
        assistantTurnsTotal: 40,
        llmCallsTotal: 41,
        toolCallCount: 0,
      },
      conversationIds: [],
      steps: [],
    };
    const file = goalFileFor(workspace, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(mixed, null, 2) + "\n", "utf-8");

    const g = await readGoal(workspace, id);
    expect(g?.stats.iterationsRun).toBe(9);
    expect(g?.stats.roundsRun).toBe(9);
    expect(g?.stats.assistantTurnsTotal).toBe(40);
    expect(g?.stats.llmCallsTotal).toBe(41);
  });
});

// ─── v0.16 §3: parent / sub-goal relationships ───────────────────────────
describe("parent/sub-goal links", () => {
  it("createGoal stamps parentGoalId when supplied and defaults to null", async () => {
    const parent = await createGoal(workspace, {
      objective: "top",
      scope: { kind: "global" },
      model: "m",
    });
    expect(parent.parentGoalId).toBeNull();
    expect(parent.subGoalIds).toEqual([]);

    const child = await createGoal(workspace, {
      objective: "branch",
      scope: { kind: "global" },
      model: "m",
      parentGoalId: parent.id,
    });
    expect(child.parentGoalId).toBe(parent.id);
    // Round-trip from disk too.
    const reread = await readGoal(workspace, child.id);
    expect(reread?.parentGoalId).toBe(parent.id);
  });

  it("addSubGoalId appends in order and is idempotent", async () => {
    const parent = await createGoal(workspace, {
      objective: "top",
      scope: { kind: "global" },
      model: "m",
    });
    await addSubGoalId(workspace, parent.id, "sub-1");
    await addSubGoalId(workspace, parent.id, "sub-2");
    // Duplicate — must NOT grow the array.
    await addSubGoalId(workspace, parent.id, "sub-1");
    const reread = await readGoal(workspace, parent.id);
    expect(reread?.subGoalIds).toEqual(["sub-1", "sub-2"]);
  });

  it("addSubGoalId on a non-existent goal is a no-op (best-effort)", async () => {
    await expect(addSubGoalId(workspace, "missing-id", "sub-x")).resolves.toBeUndefined();
  });
});
