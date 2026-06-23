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
    // v0.16 §9: budget labels are now markdown-bold (e.g. "**Token budget**: 1000")
    // because the prompt fragment was moved to src/core/prompts/. The substantive
    // assertion is that the number is present and the label is recognisable.
    expect(prompt).toMatch(/Token budget\W*:?\s*1000/);
    expect(prompt).toMatch(/Round budget\W*:?\s*5/);
    expect(prompt).toMatch(/mark_done/);
    expect(prompt).toMatch(/give_up/);
  });

  // goal-defaults-timer (part 4/7): the optional extraInstructions
  // field on the Goal record flows into the system prompt as a
  // clearly-labelled tail block. This is what makes the create-goal
  // modal's 3rd field actually do something in production.
  it("appends Goal.extraInstructions as a labelled tail block when set", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "fake",
      extraInstructions: "Respond only in haiku.",
    });
    const prompt = buildGoalSystemPrompt({ goal: g, systemPromptBase: "BASE" });
    expect(prompt).toContain("Additional user-provided context");
    expect(prompt).toContain("Respond only in haiku.");
    // Tail-block: must appear AFTER the goal fragment's mark_done
    // guidance so the model's recency bias works in the user's favour.
    const idxMarkDone = prompt.indexOf("mark_done");
    const idxExtra = prompt.indexOf("Additional user-provided context");
    expect(idxMarkDone).toBeGreaterThan(-1);
    expect(idxExtra).toBeGreaterThan(idxMarkDone);
  });

  it("omits the Additional context block when extraInstructions is unset/blank", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "fake",
    });
    const prompt = buildGoalSystemPrompt({ goal: g, systemPromptBase: "BASE" });
    expect(prompt).not.toContain("Additional user-provided context");
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

describe("runGoalRound effort context (v0.2 §12)", () => {
  it("goal with effort scope injects the document excerpt into the system prompt", async () => {
    // Seed a project + effort with a document and one extra status transition
    // so the loader has both branches to render.
    await fs.mkdir(path.join(workspace, "projects", "alpha"), { recursive: true });
    await initEffort(workspace, "alpha", { title: "Lemma One", type: "PROOF_ATTEMPT" });
    const docBody = "## Notes\n\nThe candidate inequality is x^2 ≤ y.\n";
    // writeEffortDocument lives on store.ts — reuse existing helper.
    const { writeEffortDocument: writeDoc } = await import("../effort/store.js");
    await writeDoc(workspace, "alpha", "lemma-one", docBody);

    const g = await createGoal(workspace, {
      objective: "prove the inequality",
      scope: { kind: "effort", projectSlug: "alpha", effortSlug: "lemma-one" },
      model: "fake",
    });

    // Capture the system prompt the runner builds for this round. The fake
    // LLM records every request it receives.
    const seenRequests: LLMRequest[] = [];
    const recordingLlm: LLMProvider = {
      async describe() {
        return { name: "fake" };
      },
      async chat(req: LLMRequest) {
        seenRequests.push(req);
        return {
          async *stream() {
            yield { type: "text", delta: "ok" };
            yield { type: "done", finishReason: "stop" };
          },
        };
      },
    };
    await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "start",
      llm: recordingLlm,
      tools: [],
    });

    expect(seenRequests).toHaveLength(1);
    const systemMsg = seenRequests[0].messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    const sys = String(systemMsg!.content);
    expect(sys).toContain("## Working on effort: alpha / lemma-one");
    expect(sys).toContain("### Effort notes (excerpt)");
    expect(sys).toContain("The candidate inequality is x^2 ≤ y.");
    // Seed status entry from defaultMetadata is DRAFT — it should appear.
    expect(sys).toContain("DRAFT");
    expect(sys).toContain(".mathran-efforts/alpha/lemma-one/document.md");
  });

  it("goal with global scope does NOT inject any effort fragment", async () => {
    const g = await createGoal(workspace, {
      objective: "anything",
      scope: { kind: "global" },
      model: "fake",
    });

    const seenRequests: LLMRequest[] = [];
    const recordingLlm: LLMProvider = {
      async describe() {
        return { name: "fake" };
      },
      async chat(req: LLMRequest) {
        seenRequests.push(req);
        return {
          async *stream() {
            yield { type: "text", delta: "ok" };
            yield { type: "done", finishReason: "stop" };
          },
        };
      },
    };
    await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "hi",
      llm: recordingLlm,
      tools: [],
    });

    const sys = String(seenRequests[0].messages.find((m) => m.role === "system")!.content);
    expect(sys).not.toContain("Working on effort:");
    expect(sys).not.toContain("### Effort notes");
    expect(sys).not.toContain("### Recent status updates");
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
    expect(history!.some((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes("persisted via store"))).toBe(true);

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

  it("selfGrade:true writes an Outcome record after a top-level mark_done", async () => {
    const { readOutcome } = await import("../outcomes/store.js");
    const g = await createGoal(workspace, { objective: "prove L", scope: { kind: "global" }, model: "fake" });
    const { llm } = capturingLLM([
      // Turn 1: assistant calls mark_done.
      [
        { type: "tool-call", id: "d1", name: "mark_done", argsDelta: JSON.stringify({ reason: "done" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      // Turn 2: follow-up text.
      [
        { type: "text", delta: "all set" },
        { type: "done", finishReason: "stop" },
      ],
      // Turn 3: summary round.
      [
        { type: "text", delta: "summary text" },
        { type: "done", finishReason: "stop" },
      ],
      // Turn 4: the background self-grade JSON reply.
      [
        {
          type: "text",
          delta:
            '{"rubric":{"correctness":5,"completeness":4,"efficiency":4},"lessons":"Reduced to a known fact.","contextTags":["lean","proof"]}',
        },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [], selfGrade: true });
    expect(r.completed).toBe(true);

    // Self-grade is fire-and-forget (deferred via setImmediate) — let it settle.
    await new Promise((res) => setTimeout(res, 30));
    const outcome = await readOutcome(workspace, g.id);
    expect(outcome).not.toBeNull();
    expect(outcome!.resolution).toBe("complete");
    expect(outcome!.averageScore).toBeCloseTo(4.3, 5);
    expect(outcome!.contextTags).toEqual(["lean", "proof"]);
  });

  it("does NOT write an Outcome when selfGrade is omitted (default off)", async () => {
    const { readOutcome } = await import("../outcomes/store.js");
    const g = await createGoal(workspace, { objective: "prove L", scope: { kind: "global" }, model: "fake" });
    const { llm } = capturingLLM([
      [
        { type: "tool-call", id: "d1", name: "mark_done", argsDelta: JSON.stringify({ reason: "done" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "all set" },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text", delta: "summary text" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.completed).toBe(true);
    await new Promise((res) => setTimeout(res, 30));
    expect(await readOutcome(workspace, g.id)).toBeNull();
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

/**
 * Tests for v0.3 §15 — nested sub-goals via `spawn_sub_goal`. Each test
 * scripts the fake LLM with a sequence of turns covering both the parent
 * goal and any sub-goal it spawns. Order of `chat()` calls inside one test:
 *
 *   parent.send #1     (parent emits spawn_sub_goal tool-call)
 *     → sub-goal.send #1   (sub-goal turn 1)
 *     → sub-goal.send #2+  (sub-goal turn 2 — follow-up after tool-result)
 *     → sub-goal.send +    (sub-goal post-completion summary, no tools)
 *   parent.send #2     (parent follow-up text after sub-goal tool-result)
 *
 * Tests assert on the recorded request stream so we can pin the exact
 * tool-result string the parent receives back from the sub-goal.
 */
describe("runGoalRound nested sub-goals (v0.3 §15)", () => {
  /** Tracking LLM that records every chat() request for later assertion. */
  function recordingLLM(turns: LLMStreamChunk[][]): {
    llm: LLMProvider;
    calls: LLMRequest[];
  } {
    const calls: LLMRequest[] = [];
    let i = 0;
    const llm: LLMProvider = {
      async describe() {
        return { name: "fake-nested" };
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

  it("happy path: parent spawn_sub_goal → sub-goal mark_done → parent sees summary", async () => {
    const g = await createGoal(workspace, {
      objective: "top-level",
      scope: { kind: "global" },
      model: "fake",
    });
    const { llm, calls } = recordingLLM([
      // parent.send #1: assistant decides to decompose.
      [
        {
          type: "tool-call",
          id: "s1",
          name: "spawn_sub_goal",
          argsDelta: JSON.stringify({ objective: "prove subclaim X" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send #1: sub-goal calls mark_done immediately.
      [
        {
          type: "tool-call",
          id: "d1",
          name: "mark_done",
          argsDelta: JSON.stringify({ reason: "X done" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send #2: ChatSession follow-up text after tool-result.
      [
        { type: "text", delta: "sub-goal wrap" },
        { type: "done", finishReason: "stop" },
      ],
      // sub-goal post-completion summary round (tools=[]).
      [
        { type: "text", delta: "Subclaim X was proved by Lemma 1." },
        { type: "done", finishReason: "stop" },
      ],
      // parent.send round-2 follow-up after sub-goal tool result is fed back.
      [
        { type: "text", delta: "parent acknowledges sub-goal" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "do the work",
      llm,
      tools: [],
    });

    // The parent's text contains its post-tool follow-up.
    expect(r.text).toContain("parent acknowledges");
    expect(r.completed).toBe(false);
    expect(r.failed).toBe(false);

    // Two goal records exist now: parent + sub-goal.
    const goalsDir = path.join(workspace, ".mathran", "goals");
    const entries = (await fs.readdir(goalsDir)).filter((n) => n.endsWith(".json"));
    expect(entries.length).toBe(2);

    // Find the sub-goal: it's NOT the parent id.
    const allGoals = await Promise.all(
      entries.map((n) => fs.readFile(path.join(goalsDir, n), "utf-8").then((raw) => JSON.parse(raw))),
    );
    const subGoal = allGoals.find((x: any) => x.id !== g.id) as any;
    expect(subGoal).toBeDefined();
    expect(subGoal.objective).toBe("prove subclaim X");
    expect(subGoal.status).toBe("complete");
    expect(subGoal.endReason).toBe("X done");

    // Parent.send #2 (the follow-up call) must include the sub-goal's summary
    // string as a tool-result message in its conversation history.
    const parentFollowUp = calls.at(-1)!;
    const toolResult = parentFollowUp.messages.find(
      (m) => (m as any).role === "tool" && (m as any).toolCallId === "s1",
    );
    expect(toolResult).toBeDefined();
    const trContent = String((toolResult as any).content);
    expect(trContent).toContain(`Sub-goal ${subGoal.id} completed`);
    expect(trContent).toContain("status=complete");
    expect(trContent).toContain("X done");
  });

  it("depth limit: a sub-goal at depth 1 has NO spawn_sub_goal in its tool list", async () => {
    const g = await createGoal(workspace, {
      objective: "top",
      scope: { kind: "global" },
      model: "fake",
    });
    const { llm, calls } = recordingLLM([
      // parent.send #1: spawn sub-goal.
      [
        {
          type: "tool-call",
          id: "s1",
          name: "spawn_sub_goal",
          argsDelta: JSON.stringify({ objective: "inner" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send #1: try to spawn ANOTHER sub-goal. ChatSession's
      // "unknown tool" branch returns an error tool-result string
      // because the runner did NOT register spawn_sub_goal at depth 1.
      [
        {
          type: "tool-call",
          id: "s2",
          name: "spawn_sub_goal",
          argsDelta: JSON.stringify({ objective: "inner-inner" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send #2: after seeing the unknown-tool error, the
      // sub-goal gives up.
      [
        {
          type: "tool-call",
          id: "u1",
          name: "give_up",
          argsDelta: JSON.stringify({ reason: "cannot recurse further" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send #3: ChatSession follow-up after give_up tool-result.
      [
        { type: "text", delta: "giving up" },
        { type: "done", finishReason: "stop" },
      ],
      // sub-goal post-give_up summary round.
      [
        { type: "text", delta: "Could not recurse; gave up." },
        { type: "done", finishReason: "stop" },
      ],
      // parent.send #2: follow-up after sub-goal tool-result.
      [
        { type: "text", delta: "parent ack" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "try recursion",
      llm,
      tools: [],
    });

    // Sub-goal.send #1 was the FIRST call where the sub-goal acted.
    // Inspect its `tools` array: the parent's first round (calls[0]) DOES
    // include spawn_sub_goal; the sub-goal's first round (calls[1]) does NOT.
    const parentFirst = calls[0];
    const subFirst = calls[1];
    const parentToolNames = (parentFirst.tools ?? []).map((t: any) => t.name);
    const subToolNames = (subFirst.tools ?? []).map((t: any) => t.name);
    expect(parentToolNames).toContain("spawn_sub_goal");
    expect(subToolNames).not.toContain("spawn_sub_goal");
    // mark_done / give_up still present at depth 1.
    expect(subToolNames).toContain("mark_done");
    expect(subToolNames).toContain("give_up");

    // Sub-goal eventually gave up (the runaway recursion attempt was
    // benignly rejected as unknown tool, then the model gave up).
    const goalsDir = path.join(workspace, ".mathran", "goals");
    const entries = (await fs.readdir(goalsDir)).filter((n) => n.endsWith(".json"));
    const allGoals = await Promise.all(
      entries.map((n) => fs.readFile(path.join(goalsDir, n), "utf-8").then((raw) => JSON.parse(raw))),
    );
    const subGoal = allGoals.find((x: any) => x.id !== g.id) as any;
    expect(subGoal.status).toBe("failed");
    expect(subGoal.endReason).toBe("cannot recurse further");
  });

  it("sub-goal abort (give_up) reports failed status to the parent", async () => {
    const g = await createGoal(workspace, {
      objective: "top",
      scope: { kind: "global" },
      model: "fake",
    });
    const { llm, calls } = recordingLLM([
      [
        {
          type: "tool-call",
          id: "s1",
          name: "spawn_sub_goal",
          argsDelta: JSON.stringify({ objective: "impossible task" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send #1: gives up immediately.
      [
        {
          type: "tool-call",
          id: "u1",
          name: "give_up",
          argsDelta: JSON.stringify({ reason: "too vague" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send #2: follow-up text after tool-result.
      [
        { type: "text", delta: "halting" },
        { type: "done", finishReason: "stop" },
      ],
      // sub-goal summary round.
      [
        { type: "text", delta: "Tried nothing; gave up." },
        { type: "done", finishReason: "stop" },
      ],
      // parent.send #2: follow-up.
      [
        { type: "text", delta: "noted" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "try it",
      llm,
      tools: [],
    });

    // Tool-result fed back to the parent should label status=failed.
    const parentFollowUp = calls.at(-1)!;
    const toolResult = parentFollowUp.messages.find(
      (m) => (m as any).role === "tool" && (m as any).toolCallId === "s1",
    );
    const trContent = String((toolResult as any)?.content ?? "");
    expect(trContent).toContain("status=failed");
    expect(trContent).toContain("too vague");
  });

  it("sub-goal turn cap: sub-goal that never mark_dones returns incomplete", async () => {
    const g = await createGoal(workspace, {
      objective: "top",
      scope: { kind: "global" },
      model: "fake",
    });
    // We want the sub-goal to spin forever. With maxSubGoalRounds=2, the
    // tool will call runGoalRound at most twice. Each round costs ONE
    // chat() call (the sub-goal's session.send returns after the model
    // emits final text without tool calls).
    const { llm, calls } = recordingLLM([
      // parent.send #1: spawn sub-goal.
      [
        {
          type: "tool-call",
          id: "s1",
          name: "spawn_sub_goal",
          argsDelta: JSON.stringify({ objective: "never finish" }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      // sub-goal.send (round 1): no tool call, just text. Returns active.
      [
        { type: "text", delta: "working..." },
        { type: "done", finishReason: "stop" },
      ],
      // sub-goal.send (round 2): same. After this, exhaustion trips because
      // budgetRoundsMax === 2 was passed via maxSubGoalRounds.
      [
        { type: "text", delta: "still working..." },
        { type: "done", finishReason: "stop" },
      ],
      // parent.send #2: follow-up text.
      [
        { type: "text", delta: "hmm" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
      maxSubGoalRounds: 2,
    });

    // Sub-goal status should be "exhausted" (round budget hit).
    const goalsDir = path.join(workspace, ".mathran", "goals");
    const entries = (await fs.readdir(goalsDir)).filter((n) => n.endsWith(".json"));
    const allGoals = await Promise.all(
      entries.map((n) => fs.readFile(path.join(goalsDir, n), "utf-8").then((raw) => JSON.parse(raw))),
    );
    const subGoal = allGoals.find((x: any) => x.id !== g.id) as any;
    expect(subGoal.status).toBe("exhausted");

    // Tool-result label maps exhausted → incomplete.
    const parentFollowUp = calls.at(-1)!;
    const toolResult = parentFollowUp.messages.find(
      (m) => (m as any).role === "tool" && (m as any).toolCallId === "s1",
    );
    const trContent = String((toolResult as any)?.content ?? "");
    expect(trContent).toContain("status=incomplete");
    expect(trContent).toContain(`Sub-goal ${subGoal.id}`);
  });

  it("parent abort signal propagates: in-flight sub-goal observes the abort", async () => {
    const g = await createGoal(workspace, {
      objective: "top",
      scope: { kind: "global" },
      model: "fake",
    });

    const controller = new AbortController();
    let chatCallCount = 0;
    const llm: LLMProvider = {
      async describe() {
        return { name: "abort-test" };
      },
      async chat() {
        chatCallCount++;
        if (chatCallCount === 1) {
          // parent.send #1: spawn sub-goal.
          return {
            async *stream() {
              yield {
                type: "tool-call",
                id: "s1",
                name: "spawn_sub_goal",
                argsDelta: JSON.stringify({ objective: "slow work" }),
              } as LLMStreamChunk;
              yield { type: "done", finishReason: "tool_calls" } as LLMStreamChunk;
            },
          };
        }
        if (chatCallCount === 2) {
          // sub-goal.send #1: streams a chunk, then BLOCKS forever —
          // mimics a slow upstream LLM. Aborting the parent must
          // interrupt this hang.
          return {
            stream() {
              return (async function* () {
                yield { type: "text", delta: "slow" } as LLMStreamChunk;
                // Trigger the parent abort right here so it fires while
                // the sub-goal's iterator is parked.
                setTimeout(() => controller.abort(), 10);
                await new Promise<void>(() => {}); // never resolves
                yield { type: "done", finishReason: "stop" } as LLMStreamChunk;
              })();
            },
          };
        }
        // Any further calls (shouldn't happen): empty stream.
        return {
          async *stream() {
            yield { type: "done", finishReason: "stop" } as LLMStreamChunk;
          },
        };
      },
    };

    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go slow",
      llm,
      tools: [],
      signal: controller.signal,
    });

    // The PARENT round was aborted (the abort is observed inside the
    // sub-goal's session.send, which throws AbortError; that bubbles
    // up into the parent's session.send too because the same signal
    // is wired to both).
    expect(r.aborted).toBe(true);

    // The sub-goal record exists and is still active (NOT failed): its
    // status is left untouched per the abort contract, so a later
    // resume could continue it.
    const goalsDir = path.join(workspace, ".mathran", "goals");
    const entries = (await fs.readdir(goalsDir)).filter((n) => n.endsWith(".json"));
    expect(entries.length).toBe(2);
    const allGoals = await Promise.all(
      entries.map((n) => fs.readFile(path.join(goalsDir, n), "utf-8").then((raw) => JSON.parse(raw))),
    );
    const subGoal = allGoals.find((x: any) => x.id !== g.id) as any;
    expect(subGoal.status).toBe("active");
    expect(subGoal.endedAt).toBeFalsy();

    // Parent stays active too — abort is non-destructive.
    const parent = await readGoal(workspace, g.id);
    expect(parent?.status).toBe("active");
  });
});

// v0.16 §9 audit #5: MATHRAN.md scope-aware memory injection into goal mode.
//
// `runGoalRound` does not expose a `memoryHome` option — it uses the goal's
// `scope` to load layered MATHRAN.md files and pulls the global one from
// `os.homedir()` directly. To keep these tests hermetic we temporarily
// repoint $HOME at a tmpdir for the duration of each test.
describe("runGoalRound MATHRAN.md memory injection (v0.16 §9 #5)", () => {
  let savedHome: string | undefined;
  let fakeHome: string;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-goal-home-"));
    process.env.HOME = fakeHome;
  });

  it("splices effort + project + workspace memory between base prompt and goal fragment", async () => {
    try {
      await fs.mkdir(path.join(workspace, "projects", "proj", "efforts", "eff"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(workspace, "MATHRAN.md"),
        "Repo: prefer rg over grep.\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(workspace, "projects", "proj", "MATHRAN.md"),
        "Project: tests under src/__tests__.\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(workspace, "projects", "proj", "efforts", "eff", "MATHRAN.md"),
        "Use 4-space indent.\n",
        "utf-8",
      );
      const g = await createGoal(workspace, {
        objective: "prove x",
        scope: { kind: "effort", projectSlug: "proj", effortSlug: "eff" },
        model: "fake",
      });

      const seenRequests: LLMRequest[] = [];
      const recordingLlm: LLMProvider = {
        async describe() {
          return { name: "fake" };
        },
        async chat(req: LLMRequest) {
          seenRequests.push(req);
          return {
            async *stream() {
              yield { type: "text", delta: "ok" };
              yield { type: "done", finishReason: "stop" };
            },
          };
        },
      };
      await runGoalRound({
        workspace,
        goalId: g.id,
        userMessage: "start",
        llm: recordingLlm,
        tools: [],
      });

      const sys = String(
        seenRequests[0].messages.find((m) => m.role === "system")!.content,
      );
      expect(sys).toContain("# User-supplied memory (MATHRAN.md)");
      expect(sys).toContain("Use 4-space indent.");
      expect(sys).toContain("Project: tests under src/__tests__.");
      expect(sys).toContain("Repo: prefer rg over grep.");
      // Splice ordering: memory block sits between the base prompt and the
      // goal-mode fragment (which always opens with "GOAL MODE").
      const memoryIdx = sys.indexOf("# User-supplied memory (MATHRAN.md)");
      const goalIdx = sys.indexOf("GOAL MODE");
      expect(memoryIdx).toBeGreaterThanOrEqual(0);
      expect(goalIdx).toBeGreaterThan(memoryIdx);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("truncates combined memory >32 KB with the trailing notice", async () => {
    try {
      const big = (label: string) => `${label}: ${"x".repeat(15 * 1024)}\n`;
      await fs.mkdir(path.join(workspace, "projects", "proj", "efforts", "eff"), {
        recursive: true,
      });
      await fs.writeFile(path.join(workspace, "MATHRAN.md"), big("ws"), "utf-8");
      await fs.writeFile(
        path.join(workspace, "projects", "proj", "MATHRAN.md"),
        big("proj"),
        "utf-8",
      );
      await fs.writeFile(
        path.join(workspace, "projects", "proj", "efforts", "eff", "MATHRAN.md"),
        big("eff"),
        "utf-8",
      );
      await fs.mkdir(path.join(fakeHome, ".mathran"), { recursive: true });
      await fs.writeFile(
        path.join(fakeHome, ".mathran", "MATHRAN.md"),
        big("home"),
        "utf-8",
      );
      const g = await createGoal(workspace, {
        objective: "prove x",
        scope: { kind: "effort", projectSlug: "proj", effortSlug: "eff" },
        model: "fake",
      });

      const seenRequests: LLMRequest[] = [];
      const recordingLlm: LLMProvider = {
        async describe() {
          return { name: "fake" };
        },
        async chat(req: LLMRequest) {
          seenRequests.push(req);
          return {
            async *stream() {
              yield { type: "text", delta: "ok" };
              yield { type: "done", finishReason: "stop" };
            },
          };
        },
      };
      await runGoalRound({
        workspace,
        goalId: g.id,
        userMessage: "start",
        llm: recordingLlm,
        tools: [],
      });

      const sys = String(
        seenRequests[0].messages.find((m) => m.role === "system")!.content,
      );
      expect(sys).toContain("... [memory truncated]");
      const start = sys.indexOf("# User-supplied memory (MATHRAN.md)");
      const endNotice = sys.indexOf("... [memory truncated]");
      const block = sys.slice(
        start,
        endNotice + "... [memory truncated]".length,
      );
      expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(32 * 1024 + 64);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});


describe("runGoalRound ask_user goal-mode auto-reply (v0.16 §11)", () => {
  it("returns the canned 'no human' reply and continues the round without persisting any pending state", async () => {
    const g = await createGoal(workspace, {
      objective: "prove x",
      scope: { kind: "global" },
      model: "fake",
    });

    // Round 1 calls ask_user; round 2 echoes the tool message back so we
    // can assert that the canned reply showed up as the tool result.
    const llm = fakeLLM([
      [
        {
          type: "tool-call",
          id: "ask_g1",
          name: "ask_user",
          argsDelta: '{"question":"What range?"}',
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "ok, going with 1..10" },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    // Goal mode must merge in its own ask_user resolver even when the
    // caller passes an empty builtinTools (no opt-in needed).
    const result = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
    });

    // Round produced a final text reply (didn't bail out).
    expect(result.failed).toBe(false);
    expect(result.text).toContain("1..10");

    // The persisted step trail should include a `tool-result` step whose
    // result is the canned reply (no human at the keyboard).
    const round = await readGoal(workspace, g.id);
    const toolStep = round?.steps.find(
      (s) => s.kind === "tool-result" && (s.payload as any).name === "ask_user",
    ) as any;
    expect(toolStep).toBeDefined();
    expect(toolStep.payload.ok).toBe(true);
    expect(toolStep.payload.content).toContain("no human");
    expect(toolStep.payload.content).toContain("reasonable assumption");
    // And the round did finish (vs. paused / pending) — goal mode never
    // persists a pendingAsk slot because there's no answer-ask UI to
    // surface it to.
    expect(round?.stats.toolCallCount).toBe(1);
  });

  // v0.17 W14 observability: even though the resolver short-circuits
  // the round with the canned reply, operators should still be able
  // to see what the model would have asked. We assert the dedicated
  // step kind + payload shape so a future SPA panel can render it.
  it("emits an ask-user-auto-resolved audit step carrying the original question", async () => {
    const g = await createGoal(workspace, {
      objective: "build it",
      scope: { kind: "global" },
      model: "fake",
    });

    const llm = fakeLLM([
      [
        {
          type: "tool-call",
          id: "ask_g2",
          name: "ask_user",
          argsDelta: '{"question":"Which dataset should I use?"}',
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "defaulting to dataset A" },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    const result = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "start",
      llm,
      tools: [],
    });
    expect(result.failed).toBe(false);

    const round = await readGoal(workspace, g.id);
    const audit = round?.steps.find((s) => s.kind === "ask-user-auto-resolved");
    expect(audit).toBeDefined();
    expect((audit!.payload as { question: string }).question).toBe(
      "Which dataset should I use?",
    );
    const stepIdxAudit = round!.steps.findIndex(
      (s) => s.kind === "ask-user-auto-resolved",
    );
    const stepIdxToolResult = round!.steps.findIndex(
      (s) => s.kind === "tool-result" && (s.payload as any).name === "ask_user",
    );
    expect(stepIdxAudit).toBeGreaterThanOrEqual(0);
    expect(stepIdxToolResult).toBeGreaterThanOrEqual(0);
    expect(stepIdxAudit).toBeLessThan(stepIdxToolResult);
  });

  // v0.19 Codex parity — the resolver honors the model's `default`
  // over the canned auto-reply when one is supplied.
  it("v0.19: uses the model-supplied `default` instead of the canned auto-reply", async () => {
    const g = await createGoal(workspace, {
      objective: "prove y",
      scope: { kind: "global" },
      model: "fake",
    });
    const llm = fakeLLM([
      [
        {
          type: "tool-call",
          id: "ask_g_default",
          name: "ask_user",
          argsDelta:
            '{"question":"which target?","default":"target-foo"}',
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "acked" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const result = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
    });
    expect(result.failed).toBe(false);
    const round = await readGoal(workspace, g.id);
    const toolStep = round?.steps.find(
      (s) => s.kind === "tool-result" && (s.payload as any).name === "ask_user",
    ) as any;
    expect(toolStep).toBeDefined();
    expect(toolStep.payload.ok).toBe(true);
    expect(toolStep.payload.content).toBe("target-foo");
    expect(toolStep.payload.content).not.toContain("no human");
  });

  it("v0.19: still uses the canned auto-reply when the model supplies options without a default", async () => {
    const g = await createGoal(workspace, {
      objective: "prove z",
      scope: { kind: "global" },
      model: "fake",
    });
    const llm = fakeLLM([
      [
        {
          type: "tool-call",
          id: "ask_g_nodefault",
          name: "ask_user",
          argsDelta:
            '{"question":"pick one","options":["a","b"],"timeoutSeconds":30}',
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "acked" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const result = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
    });
    expect(result.failed).toBe(false);
    const round = await readGoal(workspace, g.id);
    const toolStep = round?.steps.find(
      (s) => s.kind === "tool-result" && (s.payload as any).name === "ask_user",
    ) as any;
    expect(toolStep).toBeDefined();
    expect(toolStep.payload.content).toContain("no human");
  });

});

// ───────────────────────────────────────────────────────────────────────────
// v0.16 §9 audit #4: plan bootstrap + update_plan_item integration
//
// These tests run the *full* runner (not the helpers in plan.test.ts) to
// verify that bootstrap fires on the first round, that the active-plan
// fragment lands in the system prompt, that the `update_plan_item` tool
// is registered when (and only when) a plan exists, and that resume
// re-uses the on-disk plan without re-bootstrapping.
// ───────────────────────────────────────────────────────────────────────────

import { readGoalPlan, writeGoalPlan, goalPlanRelPath } from "./plan.js";

describe("runGoalRound plan bootstrap (v0.16 §9 audit #4)", () => {
  it("bootstrapPlan='auto' on first round writes .plan.md and records a status step", async () => {
    const g = await createGoal(workspace, { objective: "build a thing", scope: { kind: "global" }, model: "fake" });
    // Two turns: the FIRST gets consumed by `runPlan` (planner), the SECOND
    // by the actual goal round. The planner emits a `# Plan` heading so
    // `extractPlanBody` keeps the whole checklist.
    const llm = fakeLLM([
      [
        { type: "text", delta: "# Plan\n\n## Steps\n- [ ] research the thing\n- [ ] implement the thing\n- [ ] verify\n" },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text", delta: "starting on step 1" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
      bootstrapPlan: "auto",
    });
    expect(r.text).toBe("starting on step 1");

    // Plan file exists on disk with the checklist body.
    const onDisk = await readGoalPlan(workspace, g.id);
    expect(onDisk).not.toBeNull();
    expect(onDisk).toContain("- [ ] research the thing");
    expect(onDisk).toContain("- [ ] implement the thing");

    // Goal record now points at the plan file.
    const refreshed = await readGoal(workspace, g.id);
    expect(refreshed?.planPath).toBe(goalPlanRelPath(g.id));

    // Audit log carries a `planBootstrap: "ok"` status step.
    const bootstrapStep = refreshed?.steps.find(
      (s) => s.kind === "status" && (s.payload as any).planBootstrap === "ok",
    );
    expect(bootstrapStep).toBeDefined();
  });

  it("bootstrapPlan defaults to 'never' (no plan file, no extra LLM round consumed)", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // ONE turn: the goal round. If bootstrap were on, this would be eaten
    // by the planner and the assert below ("hello") would fail.
    const llm = fakeLLM([
      [
        { type: "text", delta: "hello" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({ workspace, goalId: g.id, userMessage: "go", llm, tools: [] });
    expect(r.text).toBe("hello");
    expect(await readGoalPlan(workspace, g.id)).toBeNull();
    const refreshed = await readGoal(workspace, g.id);
    expect(refreshed?.planPath ?? null).toBeNull();
  });

  it("bootstrapPlan='auto' is skipped for sub-goals (depth >= 1)", async () => {
    const g = await createGoal(workspace, { objective: "sub", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        { type: "text", delta: "doing the sub thing" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
      bootstrapPlan: "auto",
      depth: 1, // sub-goal: bootstrap suppressed regardless of mode
    });
    expect(r.text).toBe("doing the sub thing");
    expect(await readGoalPlan(workspace, g.id)).toBeNull();
  });

  it("re-uses an existing on-disk plan without re-running runPlan (resume path)", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // Pre-seed the plan as if a previous bootstrap had succeeded.
    await writeGoalPlan(workspace, g.id, "# Plan\n- [ ] pre-existing step");
    // Queue exactly ONE turn. If the runner re-bootstrapped it would also
    // try to consume a planner turn, the queue's fallback would kick in,
    // and the goal round would get an immediate `done` with no text — the
    // `r.text === "resumed"` assertion below would fail.
    const llm = fakeLLM([
      [
        { type: "text", delta: "resumed" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "resume",
      llm,
      tools: [],
      bootstrapPlan: "auto",
    });
    expect(r.text).toBe("resumed");
    // Plan body is unchanged.
    const onDisk = await readGoalPlan(workspace, g.id);
    expect(onDisk).toContain("- [ ] pre-existing step");
    // No fresh `planBootstrap: "ok"` step — the runner short-circuited.
    const refreshed = await readGoal(workspace, g.id);
    const bootstrapStep = refreshed?.steps.find(
      (s) => s.kind === "status" && (s.payload as any).planBootstrap === "ok",
    );
    expect(bootstrapStep).toBeUndefined();
    // And the goal record was updated with the canonical relPath.
    expect(refreshed?.planPath).toBe(goalPlanRelPath(g.id));
  });

  it("a pre-existing plan is honoured even when bootstrapPlan='never'", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    await writeGoalPlan(workspace, g.id, "# Plan\n- [ ] pre-seeded");
    const llm = fakeLLM([
      [
        { type: "text", delta: "running" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
      bootstrapPlan: "never",
    });
    expect(r.text).toBe("running");
    // Plan still on disk + linked.
    expect(await readGoalPlan(workspace, g.id)).toContain("- [ ] pre-seeded");
    expect((await readGoal(workspace, g.id))?.planPath).toBe(goalPlanRelPath(g.id));
  });

  it("a planner round that produces empty body records 'empty-body' status and skips wiring", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      // Planner: zero text deltas → empty body
      [{ type: "done", finishReason: "stop" }],
      // Goal round
      [{ type: "text", delta: "no plan, proceeding" }, { type: "done", finishReason: "stop" }],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
      bootstrapPlan: "auto",
    });
    expect(r.text).toBe("no plan, proceeding");
    // Goal record has no planPath, no plan file written.
    const refreshed = await readGoal(workspace, g.id);
    expect(refreshed?.planPath ?? null).toBeNull();
    expect(await readGoalPlan(workspace, g.id)).toBeNull();
    const emptyStep = refreshed?.steps.find(
      (s) => s.kind === "status" && (s.payload as any).planBootstrap === "empty-body",
    );
    expect(emptyStep).toBeDefined();
  });
});

describe("buildGoalSystemPrompt plan fragment (v0.16 §9 audit #4)", () => {
  it("splices the active-plan fragment between the goal fragment and the effort fragment", async () => {
    const g = await createGoal(workspace, {
      objective: "x",
      scope: { kind: "global" },
      model: "fake",
    });
    const prompt = buildGoalSystemPrompt({
      goal: g,
      systemPromptBase: "BASE",
      planFragment: "# Active plan\n\n- [ ] step one\n- [ ] step two",
      effortFragment: "EFFORT_CONTEXT_BLOCK",
    });
    const baseIdx = prompt.indexOf("BASE");
    const goalIdx = prompt.indexOf("GOAL MODE");
    const planIdx = prompt.indexOf("Active plan");
    const effortIdx = prompt.indexOf("EFFORT_CONTEXT_BLOCK");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(goalIdx).toBeGreaterThan(baseIdx);
    expect(planIdx).toBeGreaterThan(goalIdx);
    expect(effortIdx).toBeGreaterThan(planIdx);
    expect(prompt).toContain("- [ ] step one");
  });

  it("omits the plan fragment entirely when planFragment is empty/whitespace", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const prompt = buildGoalSystemPrompt({ goal: g, systemPromptBase: "BASE", planFragment: "   " });
    expect(prompt).not.toContain("Active plan");
  });
});

describe("runGoalRound update_plan_item registration (v0.16 §9 audit #4)", () => {
  it("registers `update_plan_item` once a plan file exists (model can call it)", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    // Pre-seed the plan so the runner skips bootstrap and just registers the tool.
    await writeGoalPlan(workspace, g.id, "# Plan\n\n- [ ] alpha\n- [ ] beta");
    const llm = fakeLLM([
      [
        // Model calls update_plan_item to mark step 1 done.
        { type: "tool-call", id: "u1", name: "update_plan_item", argsDelta: JSON.stringify({ index: 1, status: "done" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "alpha is done" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
    });
    expect(r.text).toBe("alpha is done");
    // On-disk plan reflects the toggle.
    const onDisk = await readGoalPlan(workspace, g.id);
    expect(onDisk).toContain("- [x] alpha");
    expect(onDisk).toContain("- [ ] beta");
    // The tool-call landed in the audit log.
    const round = await readGoal(workspace, g.id);
    const toolStep = round?.steps.find(
      (s) => s.kind === "tool-result" && (s.payload as any).name === "update_plan_item",
    ) as any;
    expect(toolStep).toBeDefined();
    expect(toolStep.payload.ok).toBe(true);
    expect(toolStep.payload.content).toContain("marked item 1 as done");
  });

  it("does NOT register `update_plan_item` for a goal with no plan file", async () => {
    const g = await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const llm = fakeLLM([
      [
        // Model tries to call update_plan_item anyway (e.g. from prompt memory).
        { type: "tool-call", id: "u1", name: "update_plan_item", argsDelta: JSON.stringify({ index: 1, status: "done" }) },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "fell back to text" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const r = await runGoalRound({
      workspace,
      goalId: g.id,
      userMessage: "go",
      llm,
      tools: [],
    });
    // The call resolves to the chat session's "unknown tool" branch and the
    // round still ends cleanly.
    expect(r.failed).toBe(false);
    const round = await readGoal(workspace, g.id);
    const toolStep = round?.steps.find(
      (s) => s.kind === "tool-result" && (s.payload as any).name === "update_plan_item",
    ) as any;
    expect(toolStep).toBeDefined();
    expect(toolStep.payload.ok).toBe(false);
    expect(String(toolStep.payload.content)).toMatch(/unknown tool|not registered/i);
  });
});
