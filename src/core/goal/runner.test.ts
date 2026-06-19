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

import { runGoalRound, buildGoalSystemPrompt, GOAL_SUMMARY_PROMPT_DONE, GOAL_SUMMARY_PROMPT_GIVE_UP } from "./runner.js";
import { createGoal, readGoal } from "./store.js";
import { ScopedChatSessionStore, conversationFilePath } from "../chat/store.js";
import { ChatSession } from "../chat/session.js";
import { initEffort, readEffortDocument } from "../effort/store.js";
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
    expect(prompt).toMatch(/mark_done/);
    expect(prompt).toMatch(/give_up/);
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

  it("mark_done tool flips status to complete", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "tool-call", id: "d1", name: "mark_done", argsDelta: JSON.stringify({ reason: "lemma proved" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "all set" },
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

  it("give_up tool flips status to failed", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "tool-call", id: "u1", name: "give_up", argsDelta: JSON.stringify({ reason: "scope too big" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "stopping" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.failed).toBe(true);
    expect(r.endReason).toBe("scope too big");
    const round = await readGoal(workspace, g.id);
    expect(round?.status).toBe("failed");
  });

  it("plain-text DONE: in output does NOT complete the goal (regex must not trigger)", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "text", delta: "I'll mark DONE: when ready" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.completed).toBe(false);
    expect(r.failed).toBe(false);
    const round = await readGoal(workspace, g.id);
    expect(round?.status).toBe("active");
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

  it("returns early on an already-aborted signal without changing goal status", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [{ type: "text", delta: "should not run" }, { type: "done", finishReason: "stop" }],
    ]);
    const controller = new AbortController();
    controller.abort();

    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
      signal: controller.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.completed).toBe(false);
    expect(r.failed).toBe(false);
    expect(r.text).toBe("");

    // Goal status + stats untouched; nothing was run.
    const round = await readGoal(workspace, g.id);
    expect(round?.status).toBe("active");
    expect(round?.stats.roundsRun).toBe(0);
  });

  it("aborted mid-round leaves the goal resumable with no state corruption", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // A provider that streams a partial chunk then blocks until aborted.
    const slowLlm: LLMProvider = {
      async describe() {
        return { name: "slow" };
      },
      async chat() {
        return {
          stream() {
            return (async function* () {
              yield { type: "text", delta: "partial work" } as LLMStreamChunk;
              await new Promise<void>(() => {});
              yield { type: "done", finishReason: "stop" } as LLMStreamChunk;
            })();
          },
        };
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm: slowLlm,
      tools: [],
      signal: controller.signal,
    });
    clearTimeout(timer);

    expect(r.aborted).toBe(true);
    expect(r.completed).toBe(false);
    expect(r.failed).toBe(false);

    // Goal stays active (NOT failed) and the partial conversation is persisted
    // so a later resume continues cleanly.
    const round = await readGoal(workspace, g.id);
    expect(round?.status).toBe("active");
    expect(round?.endedAt).toBeFalsy();
    expect(round?.conversationIds).toHaveLength(1);
    const convFile = path.join(workspace, ".mathran", "global-chat", `${round!.conversationIds[0]}.jsonl`);
    const raw = await fs.readFile(convFile, "utf-8");
    expect(raw).toContain("partial work");
    expect(raw).toContain("[aborted]");

    // Resuming with a normal provider works and finishes the round.
    const finishLlm = fakeLLM([
      [{ type: "text", delta: "resumed and done" }, { type: "done", finishReason: "stop" }],
    ]);
    const r2 = await runGoalRound({ workspace, goalId: g.id, userMessage: "continue", llm: finishLlm, tools: [] });
    expect(r2.aborted).toBe(false);
    expect(r2.text).toBe("resumed and done");
  });
});

describe("runGoalRound persistence reuses ChatSessionStore (v0.2 §10)", () => {
  it("two goals in the same workspace persist independently (no cross-contamination)", async () => {
    const gA = await createGoal(workspace, { objective: "A", scope: { kind: "global" }, model: "fake" });
    const gB = await createGoal(workspace, { objective: "B", scope: { kind: "global" }, model: "fake" });

    const llmA = fakeLLM([[{ type: "text", delta: "alpha" }, { type: "done", finishReason: "stop" }]]);
    const llmB = fakeLLM([[{ type: "text", delta: "bravo" }, { type: "done", finishReason: "stop" }]]);

    await Promise.all([
      runGoalRound({ workspace, goalId: gA.id, userMessage: "hello A", llm: llmA, tools: [] }),
      runGoalRound({ workspace, goalId: gB.id, userMessage: "hello B", llm: llmB, tools: [] }),
    ]);

    const refreshedA = await readGoal(workspace, gA.id);
    const refreshedB = await readGoal(workspace, gB.id);
    expect(refreshedA?.conversationIds[0]).toBeTruthy();
    expect(refreshedB?.conversationIds[0]).toBeTruthy();
    expect(refreshedA?.conversationIds[0]).not.toBe(refreshedB?.conversationIds[0]);

    const fileA = conversationFilePath(workspace, { kind: "global" }, refreshedA!.conversationIds[0]);
    const fileB = conversationFilePath(workspace, { kind: "global" }, refreshedB!.conversationIds[0]);
    const rawA = await fs.readFile(fileA, "utf-8");
    const rawB = await fs.readFile(fileB, "utf-8");

    expect(rawA).toContain("hello A");
    expect(rawA).toContain("alpha");
    expect(rawA).not.toContain("hello B");
    expect(rawA).not.toContain("bravo");

    expect(rawB).toContain("hello B");
    expect(rawB).toContain("bravo");
    expect(rawB).not.toContain("hello A");
    expect(rawB).not.toContain("alpha");
  });

  it("goal persistence integrates with ScopedChatSessionStore (index + transcript exist)", async () => {
    // Run one goal round, then enumerate conversations via the chat store: the
    // goal's conversationId should appear in the scope's .index.json (because
    // the runner now goes through the shared flushConversationHistory helper).
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [{ type: "text", delta: "persisted via store" }, { type: "done", finishReason: "stop" }],
    ]);
    await runGoalRound({ workspace, goalId: g.id, userMessage: "check store", llm, tools: [] });

    const refreshed = await readGoal(workspace, g.id);
    const conversationId = refreshed!.conversationIds[0];

    // A bare ScopedChatSessionStore (no factory needs since we only read) sees
    // the goal's conversation listed in the scope index.
    const store = new ScopedChatSessionStore(workspace, () => new ChatSession({ llm }));
    const convs = await store.listConversations({ kind: "global" });
    expect(convs.map((c) => c.id)).toContain(conversationId);
    const meta = convs.find((c) => c.id === conversationId)!;
    expect(meta.messageCount).toBeGreaterThan(0);
    expect(meta.title.length).toBeGreaterThan(0);

    // Reading the same conversation back via the store yields the goal's
    // history (proving they share the on-disk layout, not just the path).
    const history = await store.readHistory({ kind: "global" }, conversationId);
    expect(history).not.toBeNull();
    expect(history!.some((m) => m.role === "user" && m.content === "check store")).toBe(true);
    expect(history!.some((m) => m.role === "assistant" && m.content.includes("persisted via store"))).toBe(true);

    // Transcript Markdown was written next to the jsonl (best-effort by spec
    // but it is the chat store's normal flush path).
    const transcriptFile = path.join(workspace, ".mathran", "global-chat", "transcripts", `${conversationId}.md`);
    const md = await fs.readFile(transcriptFile, "utf-8");
    expect(md).toContain("check store");
    expect(md).toContain("persisted via store");
  });

  it("a pre-existing legacy goal jsonl at the same path is read on resume (backward compat)", async () => {
    // The new persistence layer uses the exact same path layout the old
    // runner did (and the chat store always did). This test seeds a legacy
    // jsonl from a hypothetical pre-§10 install and verifies the runner
    // picks it up unchanged — no migration code, no data loss.
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const conversationId = "legacy-conv-id";
    const dir = path.join(workspace, ".mathran", "global-chat");
    await fs.mkdir(dir, { recursive: true });
    const legacy = [
      { role: "system", content: "legacy system" },
      { role: "user", content: "older question" },
      { role: "assistant", content: "older answer" },
    ];
    await fs.writeFile(
      path.join(dir, `${conversationId}.jsonl`),
      legacy.map((m) => JSON.stringify(m)).join("\n") + "\n",
      "utf-8",
    );
    // Attach the legacy id to the goal so the runner picks it up.
    const { attachConversation } = await import("./store.js");
    await attachConversation(workspace, g.id, conversationId);

    const llm = fakeLLM([
      [{ type: "text", delta: "new turn" }, { type: "done", finishReason: "stop" }],
    ]);
    await runGoalRound({ workspace, goalId: g.id, userMessage: "follow up", llm, tools: [] });

    const raw = await fs.readFile(path.join(dir, `${conversationId}.jsonl`), "utf-8");
    expect(raw).toContain("older question");
    expect(raw).toContain("older answer");
    expect(raw).toContain("follow up");
    expect(raw).toContain("new turn");
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

describe("runGoalRound summary on completion", () => {
  /**
   * Capturing LLM: records every chat() request and streams the queued turn.
   * Lets us assert that the summary round was made *without* tools.
   */
  function capturingLLM(turns: LLMStreamChunk[][]): { llm: LLMProvider; calls: LLMRequest[] } {
    const calls: LLMRequest[] = [];
    let i = 0;
    const llm: LLMProvider = {
      async describe() {
        return { name: "capturing" };
      },
      async chat(req: LLMRequest) {
        calls.push(req);
        const turn = turns[i++] ?? [{ type: "done", finishReason: "stop" }];
        return {
          async *stream() {
            for (const c of turn) yield c;
          },
        };
      },
    };
    return { llm, calls };
  }

  it("mark_done triggers a summary file under .mathran/goals/<id>.summary.md", async () => {
    const g = await createGoal(workspace, { objective: "prove L", scope: { kind: "global" }, model: "fake" });
    const { llm, calls } = capturingLLM([
      // Turn 1: assistant calls mark_done.
      [
        { type: "tool-call", id: "d1", name: "mark_done", argsDelta: JSON.stringify({ reason: "lemma proved" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      // Turn 2: ChatSession's follow-up text after the tool result.
      [
        { type: "text", delta: "all set" },
        { type: "done", finishReason: "stop" },
      ],
      // Turn 3: post-completion summary round (no tools).
      [
        { type: "text", delta: "We proved lemma L by reducing to a known fact." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go prove it", llm, tools: [] });
    expect(r.completed).toBe(true);

    const summaryFile = path.join(workspace, ".mathran", "goals", `${g.id}.summary.md`);
    const body = await fs.readFile(summaryFile, "utf-8");
    expect(body).toContain("# Goal summary: prove L");
    expect(body).toContain("**status**: complete");
    expect(body).toContain("**endReason**: lemma proved");
    expect(body).toContain("We proved lemma L by reducing to a known fact.");

    // The summary round (calls[2]) MUST be a tools-free request to prevent
    // the LLM from re-calling mark_done / give_up and re-entering this path.
    expect(calls).toHaveLength(3);
    expect(calls[2].tools).toBeUndefined();
    // It also must include the closing user prompt for the summary.
    const lastUserMsg = calls[2].messages[calls[2].messages.length - 1];
    expect(lastUserMsg.role).toBe("user");
    expect(lastUserMsg.content).toBe(GOAL_SUMMARY_PROMPT_DONE);
  });

  it("give_up triggers a summary file with abandoned framing in the header", async () => {
    const g = await createGoal(workspace, { objective: "try X", scope: { kind: "global" }, model: "fake" });
    const { llm, calls } = capturingLLM([
      [
        { type: "tool-call", id: "u1", name: "give_up", argsDelta: JSON.stringify({ reason: "scope too big" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "stopping" },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text", delta: "Tried approach A; ran out of time before B." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.failed).toBe(true);

    const summaryFile = path.join(workspace, ".mathran", "goals", `${g.id}.summary.md`);
    const body = await fs.readFile(summaryFile, "utf-8");
    expect(body).toContain("**status**: failed");
    expect(body).toContain("**endReason**: scope too big");
    expect(body).toContain("Tried approach A");

    // The summary prompt for give_up is the abandoned framing.
    const lastUserMsg = calls[2].messages[calls[2].messages.length - 1];
    expect(lastUserMsg.content).toBe(GOAL_SUMMARY_PROMPT_GIVE_UP);
  });

  it("sets goal.summaryPath after a successful completion", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const { llm } = capturingLLM([
      [
        { type: "tool-call", id: "d1", name: "mark_done", argsDelta: JSON.stringify({ reason: "ok" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "all set" },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text", delta: "Summary text." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.completed).toBe(true);

    const refreshed = await readGoal(workspace, g.id);
    expect(refreshed?.summaryPath).toBe(path.join(".mathran", "goals", `${g.id}.summary.md`));
    expect(r.goal.summaryPath).toBe(path.join(".mathran", "goals", `${g.id}.summary.md`));
  });

  it("appends the summary to the effort document.md when goal is effort-scoped", async () => {
    // Scaffold a real effort so appendEffortDocument can find document.md.
    await fs.mkdir(path.join(workspace, "projects", "alpha"), { recursive: true });
    await initEffort(workspace, "alpha", { title: "Lemma A", type: "PROOF_ATTEMPT", slug: "lemma-a" });
    const docBefore = (await readEffortDocument(workspace, "alpha", "lemma-a")) ?? "";

    const g = await createGoal(workspace, {
      objective: "finish lemma A",
      scope: { kind: "effort", projectSlug: "alpha", effortSlug: "lemma-a" },
      model: "fake",
    });
    const { llm } = capturingLLM([
      [
        { type: "tool-call", id: "d1", name: "mark_done", argsDelta: JSON.stringify({ reason: "qed" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "all set" },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text", delta: "We closed Lemma A via approach Y." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    await runGoalRound({ workspace, goalId: g.id, userMessage: "finish it", llm, tools: [] });

    const docAfter = (await readEffortDocument(workspace, "alpha", "lemma-a")) ?? "";
    expect(docAfter.length).toBeGreaterThan(docBefore.length);
    expect(docAfter).toContain("---");
    expect(docAfter).toContain("## Goal: finish lemma A");
    expect(docAfter).toContain("Completed");
    expect(docAfter).toContain("We closed Lemma A via approach Y.");
  });

  it("a failing summary round does not break completion (summaryPath stays null)", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    let i = 0;
    const llm: LLMProvider = {
      async describe() {
        return { name: "flaky" };
      },
      async chat() {
        const turn = i++;
        if (turn === 0) {
          // Tool-call turn (mark_done).
          return {
            async *stream() {
              yield { type: "tool-call", id: "d1", name: "mark_done", argsDelta: JSON.stringify({ reason: "done" }) } as LLMStreamChunk;
              yield { type: "done", finishReason: "tool_calls" } as LLMStreamChunk;
            },
          };
        }
        if (turn === 1) {
          // ChatSession follow-up after tool result — must succeed so the
          // completion path runs and we reach the summary stage.
          return {
            async *stream() {
              yield { type: "text", delta: "all set" } as LLMStreamChunk;
              yield { type: "done", finishReason: "stop" } as LLMStreamChunk;
            },
          };
        }
        // Summary round (turn === 2): explode — must be caught + ignored.
        throw new Error("upstream LLM unavailable");
      },
    };
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.completed).toBe(true);
    const refreshed = await readGoal(workspace, g.id);
    expect(refreshed?.status).toBe("complete");
    // No summary file was written; summaryPath stays unset/null.
    expect(refreshed?.summaryPath ?? null).toBeNull();
    // The error was recorded as a status step.
    const lastStep = refreshed!.steps.at(-1);
    expect((lastStep?.payload as any)?.summaryError).toMatch(/upstream LLM/);
  });
});

