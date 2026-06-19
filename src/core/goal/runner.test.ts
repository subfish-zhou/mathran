/**
 * Tests for the Goal runner (GAP #11).
 *
 * Drives `runGoalRound` against a hand-rolled in-memory LLM. The fake
 * supports queuing N \"turns\" of streamed events, including \"DONE:\" and
 * \"GIVE_UP:\" markers so we can exercise the runner's completion logic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { runGoalRound, buildGoalSystemPrompt } from "./runner.js";
import { createGoal, readGoal } from "./store.js";
import type { LLMProvider, LLMRequest, LLMStreamChunk } from "../providers/llm.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-goal-runner-"));
});

/** Build a fake LLM that streams a fixed set of chunks for the next call. */
function fakeLLM(chunks: LLMStreamChunk[][]): LLMProvider {
  let i = 0;
  return {
    async describe() {
      return { name: "fake", defaultModel: "test" };
    },
    async chat(_req: LLMRequest) {
      const turn = chunks[i++] ?? [{ type: "done", finishReason: "stop" }];
      return {
        async *stream() {
          for (const c of turn) yield c;
        },
      };
    },
  };
}

describe("buildGoalSystemPrompt", () => {
  it("includes objective, scope, budget, and DONE/GIVE_UP hint", async () => {
    const g = await createGoal(workspace, {
      objective: "x objective",
      scope: { kind: "effort", projectSlug: "p", effortSlug: "e" },
      model: "fake",
      budgetTokensMax: 1000,
      budgetRoundsMax: 5,
    });
    const prompt = buildGoalSystemPrompt({ goal: g, systemPromptBase: "BASE" });
    expect(prompt).toContain("BASE");
    expect(prompt).toContain("x objective");
    expect(prompt).toContain("effort p / e");
    expect(prompt).toContain("Token budget: 1000");
    expect(prompt).toContain("Round budget: 5");
    expect(prompt).toMatch(/DONE:/);
    expect(prompt).toMatch(/GIVE_UP:/);
  });
});

describe("runGoalRound", () => {
  it("appends a plan step + text step, bumps rounds, persists conversation", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "fake",
    });
    const llm = fakeLLM([
      [
        { type: "text", delta: "hello " },
        { type: "text", delta: "world" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const result = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "say hi",
      llm,
      tools: [],
    });
    expect(result.text).toBe("hello world");
    expect(result.completed).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.failed).toBe(false);

    const round = await readGoal(workspace, g.id);
    expect(round?.stats.roundsRun).toBe(1);
    expect(round?.stats.toolCallCount).toBe(0);
    expect(round?.conversationIds).toHaveLength(1);
    // Steps: [objective (from createGoal), plan (this round), text]
    expect(round?.steps.map((s) => s.kind)).toEqual(["objective", "plan", "text"]);

    // Conversation jsonl exists with the user + assistant turn.
    const convFile = path.join(workspace, ".mathran", "global-chat", `${round!.conversationIds[0]}.jsonl`);
    const raw = await fs.readFile(convFile, "utf-8");
    expect(raw).toContain("say hi");
    expect(raw).toContain("hello world");
  });

  it("DONE: marker flips status to complete", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "text", delta: "verified the lemma.\nDONE: lemma proved" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.completed).toBe(true);
    expect(r.endReason).toBe("lemma proved");
    const round = await readGoal(workspace, g.id);
    expect(round?.status).toBe("complete");
    expect(round?.endedAt).toBeTruthy();
  });

  it("GIVE_UP: marker flips status to failed", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "text", delta: "GIVE_UP: scope too big" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.failed).toBe(true);
    expect(r.endReason).toBe("scope too big");
    const round = await readGoal(workspace, g.id);
    expect(round?.status).toBe("failed");
  });

  it("round budget exhaustion trips between rounds", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "fake",
      budgetRoundsMax: 1,
    });
    const llm = fakeLLM([
      [
        { type: "text", delta: "round 1" },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text", delta: "round 2 (should not run)" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r1 = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r1.exhausted).toBe(true);
    expect(r1.endReason).toMatch(/round budget/);
    // A second call must short-circuit on the inactive status
    // (the goal already ended; runner returns the original end reason).
    const r2 = await runGoalRound({ workspace, goalId: g.id, userMessage: "go again", llm, tools: [] });
    expect(r2.text).toBe("");
    expect(r2.exhausted).toBe(true);
  });

  it("resume reuses the same conversation file", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "text", delta: "first reply" },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text", delta: "second reply" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    await runGoalRound({ workspace, goalId: g.id, userMessage: "first", llm, tools: [] });
    await runGoalRound({ workspace, goalId: g.id, userMessage: "second", llm, tools: [] });

    const round = await readGoal(workspace, g.id);
    expect(round?.conversationIds).toHaveLength(1);
    expect(round?.stats.roundsRun).toBe(2);

    const convFile = path.join(workspace, ".mathran", "global-chat", `${round!.conversationIds[0]}.jsonl`);
    const raw = await fs.readFile(convFile, "utf-8");
    expect(raw).toContain("first");
    expect(raw).toContain("first reply");
    expect(raw).toContain("second");
    expect(raw).toContain("second reply");
  });

  it("records tool-call + tool-result events as audit steps", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // Round 1: model emits a tool call; runner runs the tool; round 2 final text.
    const llm = fakeLLM([
      [
        { type: "tool-call", id: "c1", name: "echo", argsDelta: JSON.stringify({ msg: "ping" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "got ping" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const tools = [
      {
        name: "echo",
        description: "echo",
        parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
        async execute(args: any) {
          return { ok: true, content: `echoed: ${args.msg}` };
        },
      },
    ];
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "use echo", llm, tools });
    expect(r.text).toBe("got ping");
    const round = await readGoal(workspace, g.id);
    expect(round?.stats.toolCallCount).toBe(1);
    const kinds = round!.steps.map((s) => s.kind);
    expect(kinds).toContain("tool-call");
    expect(kinds).toContain("tool-result");
  });

  it("throws on an unknown goal id", async () => {
    const llm = fakeLLM([[{ type: "done", finishReason: "stop" }]]);
    await expect(
      runGoalRound({ workspace, goalId: "ghost", userMessage: "x", llm, tools: [] }),
    ).rejects.toThrow(/goal not found/);
  });
});

describe("runGoalRound token counting", () => {
  it("uses provider.countTokens when available", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "effort", projectSlug: "p", effortSlug: "e" },
      model: "fake",
      budgetTokensMax: 10000,
      budgetRoundsMax: 5,
    });
    const llm: LLMProvider = {
      ...fakeLLM([
        [
          { type: "text", delta: "hello world" },
          { type: "done", finishReason: "stop" },
        ],
      ]),
      countTokens(_messages) {
        return 42;
      },
    };
    await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    const refreshed = await readGoal(workspace, g.id);
    expect(refreshed!.stats.tokensUsed).toBe(42);
  });
});
