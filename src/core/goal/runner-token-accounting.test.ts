/**
 * Defect #1 + #3 — goal stats accounting.
 *
 * Defect #1: `stats.tokensUsed` must reflect REAL token consumption. The
 * runner now sums the provider-reported `usage` (input + output tokens) across
 * every LLM round-trip in an iteration, and falls back to `llm.countTokens`
 * over the WHOLE message list (system + history + tools + output) when the
 * provider returns no usage block.
 *
 * Defect #3: each iteration records `assistantTurnsTotal` / `llmCallsTotal`
 * (one per `llm.chat()` call) alongside the renamed `iterationsRun`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { runGoalRound } from "./runner.js";
import { createGoal, readGoal } from "./store.js";
import type { LLMMessage, LLMProvider, LLMRequest, LLMStreamChunk } from "../providers/llm.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-goal-tokens-"));
});

/**
 * Build a fake LLM that streams a fixed set of chunks per call. Optional
 * `countTokens` lets a test exercise the fallback branch deterministically.
 */
function fakeLLM(
  chunks: LLMStreamChunk[][],
  countTokens?: (messages: LLMMessage[]) => number,
): LLMProvider {
  let i = 0;
  const llm: LLMProvider = {
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
  if (countTokens) llm.countTokens = countTokens;
  return llm;
}

describe("Defect #1 — real LLM-reported token accounting", () => {
  it("sums provider-reported usage (input + output) for the iteration", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // Single LLM round-trip that reports usage far larger than the short
    // (user + assistant text) estimate the old code produced.
    const llm = fakeLLM([
      [
        { type: "text", delta: "ok" },
        { type: "done", finishReason: "stop", usage: { promptTokens: 12000, completionTokens: 3400 } },
      ],
    ]);

    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.completed).toBe(false);

    const round = await readGoal(workspace, g.id);
    // tokensUsed must be the SUM the provider reported, not the ~1-token
    // char-based estimate of "go" + "ok".
    expect(round?.stats.tokensUsed).toBe(15400);
  });

  it("sums usage across multiple LLM round-trips within one iteration", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // Round 1: a tool call (reports usage A). Round 2: final text (usage B).
    const llm = fakeLLM([
      [
        { type: "tool-call", id: "c1", name: "echo", argsDelta: JSON.stringify({ msg: "ping" }) },
        { type: "done", finishReason: "tool_calls", usage: { promptTokens: 5000, completionTokens: 200 } },
      ],
      [
        { type: "text", delta: "done" },
        { type: "done", finishReason: "stop", usage: { promptTokens: 5300, completionTokens: 150 } },
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

    await runGoalRound({ workspace, goalId: g.id, userMessage: "use echo", llm, tools });

    const round = await readGoal(workspace, g.id);
    // (5000 + 200) + (5300 + 150)
    expect(round?.stats.tokensUsed).toBe(10650);
  });

  it("falls back to countTokens over the WHOLE message list when no usage reported", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    let lastSeen: LLMMessage[] = [];
    // countTokens returns a sentinel that proves: (a) the fallback ran, and
    // (b) it was handed the full message list (system + user + assistant),
    // NOT just the 2-element (user, assistant) pair the old code used.
    const llm = fakeLLM(
      [
        [
          { type: "text", delta: "no usage here" },
          { type: "done", finishReason: "stop" },
        ],
      ],
      (messages) => {
        lastSeen = messages;
        return 99999;
      },
    );

    await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });

    const round = await readGoal(workspace, g.id);
    expect(round?.stats.tokensUsed).toBe(99999);
    // The fallback must count the full conversation, which always includes a
    // system prompt + the user turn + the assistant turn (> 2 messages).
    expect(lastSeen.length).toBeGreaterThan(2);
    expect(lastSeen.some((m) => m.role === "system")).toBe(true);
  });
});

describe("Defect #3 — iteration + assistant-turn counters", () => {
  it("populates assistantTurnsTotal and llmCallsTotal per LLM call", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // Two LLM round-trips (tool call + final text) = two assistant turns.
    const llm = fakeLLM([
      [
        { type: "tool-call", id: "c1", name: "echo", argsDelta: JSON.stringify({ msg: "ping" }) },
        { type: "done", finishReason: "tool_calls", usage: { promptTokens: 10, completionTokens: 2 } },
      ],
      [
        { type: "text", delta: "done" },
        { type: "done", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 3 } },
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

    await runGoalRound({ workspace, goalId: g.id, userMessage: "use echo", llm, tools });

    const round = await readGoal(workspace, g.id);
    expect(round?.stats.iterationsRun).toBe(1);
    expect(round?.stats.assistantTurnsTotal).toBe(2);
    expect(round?.stats.llmCallsTotal).toBe(2);
    // Deprecated alias stays in lockstep with iterationsRun.
    expect(round?.stats.roundsRun).toBe(1);
  });

  it("counts assistant turns even when the provider reports no usage", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "text", delta: "hi" },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });

    const round = await readGoal(workspace, g.id);
    expect(round?.stats.assistantTurnsTotal).toBe(1);
    expect(round?.stats.llmCallsTotal).toBe(1);
  });
});
