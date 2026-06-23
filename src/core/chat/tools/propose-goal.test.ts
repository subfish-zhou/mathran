/**
 * Unit tests for the `propose_goal` chat-mode tool (v0.17 follow-up).
 *
 * The tool drives a structured ask-user → parse-reply → createGoal flow.
 * We test the parser and the end-to-end flow with a mocked resolver and a
 * temp workspace, asserting:
 *
 *   1. The reply parser accepts the documented free-text shapes.
 *   2. The reply parser fails CLOSED (treat ambiguous input as cancel).
 *   3. On confirm, a Goal record is actually written to disk via createGoal.
 *   4. On cancel, NO goal is written.
 *   5. The tool returns the structured JSON the SPA / SSE pump expects.
 *   6. Bad args (missing objective / reasoning) short-circuit cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createProposeGoalTool, parseProposeGoalReply, PROPOSE_GOAL_DEFAULT_MAX_ROUNDS } from "./propose-goal";
import type { AskUserResolver } from "./ask-user";
import { listGoals } from "../../goal/store";
import type { ChatScope } from "../store";

const scope: ChatScope = { kind: "global" };

describe("parseProposeGoalReply", () => {
  it("accepts plain `confirm`", () => {
    expect(parseProposeGoalReply("confirm")).toEqual({
      kind: "confirm",
      maxRounds: PROPOSE_GOAL_DEFAULT_MAX_ROUNDS,
      tokensCap: null,
    });
  });

  it("accepts `confirm <rounds>`", () => {
    expect(parseProposeGoalReply("confirm 80")).toEqual({
      kind: "confirm",
      maxRounds: 80,
      tokensCap: null,
    });
  });

  it("accepts `confirm <rounds> <tokens>`", () => {
    expect(parseProposeGoalReply("confirm 80 50000")).toEqual({
      kind: "confirm",
      maxRounds: 80,
      tokensCap: 50000,
    });
  });

  it("treats `yes` / `y` / `ok` / `go` as confirm with suggested values", () => {
    expect(parseProposeGoalReply("yes", 120, 90000)).toEqual({
      kind: "confirm",
      maxRounds: 120,
      tokensCap: 90000,
    });
    expect(parseProposeGoalReply("y")).toMatchObject({ kind: "confirm" });
    expect(parseProposeGoalReply("ok")).toMatchObject({ kind: "confirm" });
    expect(parseProposeGoalReply("go")).toMatchObject({ kind: "confirm" });
  });

  it("uses suggested values when confirm has no override and they were passed", () => {
    expect(parseProposeGoalReply("confirm", 75, 12000)).toEqual({
      kind: "confirm",
      maxRounds: 75,
      tokensCap: 12000,
    });
  });

  it("override beats suggestion", () => {
    expect(parseProposeGoalReply("confirm 30 1000", 200, 99999)).toEqual({
      kind: "confirm",
      maxRounds: 30,
      tokensCap: 1000,
    });
  });

  it("partial override: rounds set, tokens fall back to suggestion", () => {
    expect(parseProposeGoalReply("confirm 30", 200, 99999)).toEqual({
      kind: "confirm",
      maxRounds: 30,
      tokensCap: 99999,
    });
  });

  it("treats `cancel` / `no` / `n` / `abort` / `stop` as cancel", () => {
    for (const word of ["cancel", "no", "n", "abort", "stop"]) {
      expect(parseProposeGoalReply(word)).toEqual({ kind: "cancel" });
    }
  });

  it("fails CLOSED: unknown reply becomes cancel", () => {
    expect(parseProposeGoalReply("idk maybe")).toEqual({ kind: "cancel" });
    expect(parseProposeGoalReply("")).toEqual({ kind: "cancel" });
    expect(parseProposeGoalReply("   ")).toEqual({ kind: "cancel" });
  });

  it("is case- / whitespace-insensitive", () => {
    expect(parseProposeGoalReply("  CONFIRM 50  ")).toEqual({
      kind: "confirm",
      maxRounds: 50,
      tokensCap: null,
    });
    expect(parseProposeGoalReply("Cancel")).toEqual({ kind: "cancel" });
  });

  it("ignores non-positive / non-numeric tail tokens", () => {
    expect(parseProposeGoalReply("confirm 0 abc", 200)).toEqual({
      kind: "confirm",
      maxRounds: 200,
      tokensCap: null,
    });
    expect(parseProposeGoalReply("confirm -5")).toEqual({
      kind: "confirm",
      maxRounds: PROPOSE_GOAL_DEFAULT_MAX_ROUNDS,
      tokensCap: null,
    });
  });
});

describe("createProposeGoalTool — end-to-end", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-propose-goal-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function makeTool(resolverReply: string) {
    const resolver: AskUserResolver = async () => resolverReply;
    return createProposeGoalTool({
      resolver,
      workspace,
      scope,
      model: "copilot/gpt-5.5",
    });
  }

  it("on confirm: writes a Goal and returns structured payload", async () => {
    const tool = makeTool("confirm 50 25000");
    const res = await tool.execute({
      objective: "audit every site of X across the repo",
      reasoning: "spans 40+ files and needs verification",
      suggestedMaxRounds: 100,
    });

    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload).toMatchObject({
      ok: true,
      objective: "audit every site of X across the repo",
      maxRounds: 50,
      tokensCap: 25000,
      autoRun: false,
    });
    expect(typeof payload.goalId).toBe("string");
    expect(payload.goalId.length).toBeGreaterThan(0);

    // Goal must actually be on disk.
    const goals = await listGoals(workspace);
    expect(goals).toHaveLength(1);
    expect(goals[0].objective).toBe("audit every site of X across the repo");
    expect(goals[0].budget.roundsMax).toBe(50);
    expect(goals[0].budget.tokensMax).toBe(25000);
    expect(goals[0].model).toBe("copilot/gpt-5.5");
  });

  it("on confirm without overrides: uses suggested budget", async () => {
    const tool = makeTool("yes");
    const res = await tool.execute({
      objective: "refactor module Y end-to-end",
      reasoning: "touches 5 dependent modules + their tests",
      suggestedMaxRounds: 75,
      suggestedTokensCap: 40000,
    });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.maxRounds).toBe(75);
    expect(payload.tokensCap).toBe(40000);
    const goals = await listGoals(workspace);
    expect(goals[0].budget.roundsMax).toBe(75);
    expect(goals[0].budget.tokensMax).toBe(40000);
  });

  it("on cancel: NO goal is written, returns cancelled payload", async () => {
    const tool = makeTool("cancel");
    const res = await tool.execute({
      objective: "do the thing",
      reasoning: "because reasons",
    });
    expect(res.ok).toBe(false);
    const payload = JSON.parse(res.content);
    expect(payload).toMatchObject({ ok: false, cancelled: true });
    const goals = await listGoals(workspace);
    expect(goals).toHaveLength(0);
  });

  it("on ambiguous reply: fails CLOSED (no goal, treated as cancel)", async () => {
    const tool = makeTool("hmm not sure");
    const res = await tool.execute({
      objective: "do the thing",
      reasoning: "because reasons",
    });
    expect(res.ok).toBe(false);
    expect(JSON.parse(res.content).cancelled).toBe(true);
    const goals = await listGoals(workspace);
    expect(goals).toHaveLength(0);
  });

  it("rejects empty objective short-circuit before asking user", async () => {
    let askedQuestion: string | null = null;
    const tool = createProposeGoalTool({
      resolver: async (q) => {
        askedQuestion = q;
        return "confirm";
      },
      workspace,
      scope,
      model: "copilot/gpt-5.5",
    });
    const res = await tool.execute({ objective: "   ", reasoning: "x" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/objective.*non-empty/);
    expect(askedQuestion).toBeNull(); // never asked the user
    const goals = await listGoals(workspace);
    expect(goals).toHaveLength(0);
  });

  it("rejects empty reasoning short-circuit before asking user", async () => {
    let askedQuestion: string | null = null;
    const tool = createProposeGoalTool({
      resolver: async (q) => {
        askedQuestion = q;
        return "confirm";
      },
      workspace,
      scope,
      model: "copilot/gpt-5.5",
    });
    const res = await tool.execute({ objective: "do thing", reasoning: "" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/reasoning.*required/);
    expect(askedQuestion).toBeNull();
  });

  it("question text includes objective + reasoning + suggested budget", async () => {
    let captured = "";
    const tool = createProposeGoalTool({
      resolver: async (q) => {
        captured = q;
        return "cancel";
      },
      workspace,
      scope,
      model: "copilot/gpt-5.5",
    });
    await tool.execute({
      objective: "audit every Foo in repo",
      reasoning: "30+ files",
      suggestedMaxRounds: 88,
      suggestedTokensCap: 12345,
    });
    expect(captured).toMatch(/audit every Foo in repo/);
    expect(captured).toMatch(/30\+ files/);
    expect(captured).toMatch(/maxRounds=88/);
    expect(captured).toMatch(/tokensCap=12345/);
    expect(captured).toMatch(/`confirm`/);
    expect(captured).toMatch(/`cancel`/);
  });

  // ───────────────────────────────────────────────────────────────────
  // v0.17 P2 — autoRunner integration
  // ───────────────────────────────────────────────────────────────────

  it("on confirm with autoRunner: invokes autoRunner with goalId + objective", async () => {
    const calls: Array<{ goalId: string; userMessage: string }> = [];
    const tool = createProposeGoalTool({
      resolver: async () => "confirm 80",
      workspace,
      scope,
      model: "copilot/gpt-5.5",
      autoRunner: (goalId, userMessage) => {
        calls.push({ goalId, userMessage });
      },
    });
    const res = await tool.execute({
      objective: "implement feature X end-to-end",
      reasoning: "5+ files + tests + build verification",
    });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.autoRun).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].goalId).toBe(payload.goalId);
    expect(calls[0].userMessage).toBe("implement feature X end-to-end");
  });

  it("on cancel with autoRunner: does NOT invoke autoRunner", async () => {
    const calls: Array<{ goalId: string; userMessage: string }> = [];
    const tool = createProposeGoalTool({
      resolver: async () => "cancel",
      workspace,
      scope,
      model: "copilot/gpt-5.5",
      autoRunner: (goalId, userMessage) => {
        calls.push({ goalId, userMessage });
      },
    });
    const res = await tool.execute({
      objective: "do thing",
      reasoning: "because",
    });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("autoRunner throw does NOT propagate — goal stays seeded", async () => {
    const tool = createProposeGoalTool({
      resolver: async () => "confirm",
      workspace,
      scope,
      model: "copilot/gpt-5.5",
      autoRunner: () => {
        throw new Error("runner host blew up");
      },
    });
    const res = await tool.execute({
      objective: "do thing",
      reasoning: "because",
    });
    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.autoRun).toBe(true);
    // Goal must still be on disk despite the runner throw.
    const goals = await listGoals(workspace);
    expect(goals).toHaveLength(1);
    expect(goals[0].id).toBe(payload.goalId);
  });

  it("hint text changes based on autoRunner presence", async () => {
    const tWithout = makeTool("confirm");
    const r1 = await tWithout.execute({ objective: "x", reasoning: "y" });
    expect(JSON.parse(r1.content).hint).toMatch(/kick off the goal from the goal panel/i);

    const tWith = createProposeGoalTool({
      resolver: async () => "confirm",
      workspace,
      scope,
      model: "copilot/gpt-5.5",
      autoRunner: () => {},
    });
    const r2 = await tWith.execute({ objective: "x", reasoning: "y" });
    expect(JSON.parse(r2.content).hint).toMatch(/kicked off in the background/i);
  });
  it("injects retrieved past outcomes (#5 few-shot) into the result", async () => {
    const calls: string[] = [];
    const tool = createProposeGoalTool({
      resolver: async () => "confirm",
      workspace,
      scope,
      model: "copilot/gpt-5.5",
      retrieveFewShot: async (objective: string) => {
        calls.push(objective);
        return "Past outcomes for similar goals (for reference):\n- goal: prior refactor / score: 4.0 / resolution: complete";
      },
    });
    const res = await tool.execute({
      objective: "refactor module Z end-to-end",
      reasoning: "spans dependent modules",
    });
    expect(calls).toEqual(["refactor module Z end-to-end"]);
    const payload = JSON.parse(res.content);
    expect(payload.pastOutcomes).toContain("Past outcomes for similar goals");
  });

  it("swallows retrieval errors and omits pastOutcomes", async () => {
    const tool = createProposeGoalTool({
      resolver: async () => "confirm",
      workspace,
      scope,
      model: "copilot/gpt-5.5",
      retrieveFewShot: async () => {
        throw new Error("retrieval boom");
      },
    });
    const res = await tool.execute({ objective: "x", reasoning: "y" });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content).pastOutcomes).toBeUndefined();
  });

});
