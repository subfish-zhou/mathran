import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatSession, type ChatEvent, type ToolSpec } from "./session.js";
import { createLeanCheckTool } from "./tools/lean-check.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../providers/llm.js";
import type {
  LeanProvider,
  LeanCheckRequest,
  LeanCheckResult,
} from "../providers/lean.js";

/** Build an LLMResponse from a fixed list of chunks. */
function responseOf(chunks: LLMStreamChunk[]): LLMResponse {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

/**
 * Scripted LLM: returns the next pre-programmed stream on each chat() call and
 * records the requests it received (so we can assert tool messages were fed back).
 */
class ScriptedLLM implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  private turns: LLMStreamChunk[][];
  private i = 0;
  constructor(turns: LLMStreamChunk[][]) {
    this.turns = turns;
  }
  async describe() {
    return { name: "scripted" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const turn = this.turns[this.i] ?? [{ type: "done", finishReason: "stop" }];
    this.i += 1;
    return responseOf(turn);
  }
}

/** Fake lean provider that returns a canned result and records inputs. */
class FakeLean implements LeanProvider {
  readonly seen: LeanCheckRequest[] = [];
  constructor(private result: LeanCheckResult) {}
  async describe() {
    return { name: "fake-lean" };
  }
  async check(req: LeanCheckRequest): Promise<LeanCheckResult> {
    this.seen.push(req);
    return this.result;
  }
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("ChatSession", () => {
  it("streams plain text and finishes when no tools are called", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "hello" },
        { type: "text", delta: " world" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({ llm, model: "m" });

    const events = await collect(session.send("hi"));
    expect(events).toEqual([
      { type: "text", delta: "hello" },
      { type: "text", delta: " world" },
      { type: "done", finishReason: "stop" },
    ]);

    const history = session.history();
    expect(history.at(-2)).toMatchObject({ role: "user", content: "hi" });
    expect(history.at(-1)).toMatchObject({ role: "assistant", content: "hello world" });
  });

  it("executes a lean_check tool call, feeds the result back, and continues", async () => {
    const fakeLean = new FakeLean({
      ok: true,
      messages: [],
      durationMs: 12,
    });
    const tool = createLeanCheckTool(fakeLean);

    const llm = new ScriptedLLM([
      // Round 1: model requests lean_check (args streamed in two deltas).
      [
        { type: "text", delta: "Let me verify." },
        { type: "tool-call", id: "call_1", name: "lean_check", argsDelta: '{"leanSource":' },
        { type: "tool-call", id: "call_1", name: "", argsDelta: '"theorem t : 1 = 1 := rfl"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      // Round 2: model concludes.
      [
        { type: "text", delta: "It compiles." },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    const session = new ChatSession({ llm, model: "m", tools: [tool] });
    const events = await collect(session.send("prove 1=1"));

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "text", // "Let me verify."
      "tool-call",
      "tool-result",
      "text", // "It compiles."
      "done",
    ]);

    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toMatchObject({ name: "lean_check" });

    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult.ok).toBe(true);
    expect(toolResult.content).toContain("OK");

    // The lean provider actually received the assembled source.
    expect(fakeLean.seen).toHaveLength(1);

    // Tools were advertised to the LLM, and the tool result was fed back.
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0].tools?.[0]?.name).toBe("lean_check");
    const secondTurnMessages = llm.requests[1].messages;
    const toolMsg = secondTurnMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.toolCallId).toBe("call_1");
    expect(toolMsg?.content).toContain("OK");

    // Final assistant turn is in history.
    expect(session.history().at(-1)).toMatchObject({
      role: "assistant",
      content: "It compiles.",
    });
  });

  it("reports a failed lean_check with messages", async () => {
    const fakeLean = new FakeLean({
      ok: false,
      messages: [{ severity: "error", message: "unexpected token", line: 1, column: 5 }],
    });
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "c1", name: "lean_check", argsDelta: '{"leanSource":"bad"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "text", delta: "needs fixing" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({ llm, model: "m", tools: [createLeanCheckTool(fakeLean)] });
    const events = await collect(session.send("check bad"));

    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult.ok).toBe(false);
    expect(toolResult.content).toContain("FAILED");
    expect(toolResult.content).toContain("unexpected token");
  });

  it("handles an unknown tool gracefully", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "c1", name: "nope", argsDelta: "{}" },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({ llm, model: "m", tools: [] });
    const events = await collect(session.send("x"));
    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult.ok).toBe(false);
    expect(toolResult.content).toContain("unknown tool");
  });

  it("reset() clears history but keeps the system prompt", async () => {
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "a" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({ llm, model: "m", systemPrompt: "SYS" });
    await collect(session.send("hi"));
    expect(session.history().length).toBeGreaterThan(1);
    session.reset();
    const h = session.history();
    expect(h).toEqual([{ role: "system", content: "SYS" }]);
  });

  it("persists toolCalls on assistant turns so multi-turn replay works (BUG #3)", async () => {
    // Round 1: model emits a tool_call for lean_check.
    // Round 2: model returns plain text after seeing the tool result.
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "call_1", name: "lean_check", argsDelta: '{"leanSource":"theorem t : 1 = 1 := by rfl"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "verified" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const lean = new FakeLean({ ok: true, durationMs: 12, messages: [] });
    const session = new ChatSession({
      llm,
      model: "m",
      systemPrompt: "SYS",
      tools: [createLeanCheckTool(lean)],
    });
    await collect(session.send("please verify"));

    const history = session.history();
    // Find the assistant turn that issued the tool_call.
    const assistantWithCall = history.find(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    expect(assistantWithCall, "assistant turn must persist toolCalls").toBeDefined();
    expect(assistantWithCall!.toolCalls).toEqual([
      {
        id: "call_1",
        name: "lean_check",
        arguments: '{"leanSource":"theorem t : 1 = 1 := by rfl"}',
      },
    ]);

    // The second LLM request must include the assistant.toolCalls so
    // OpenAI/Anthropic adapters can echo `tool_calls` / `tool_use` blocks.
    const secondReq = llm.requests[1];
    const replayed = secondReq.messages.find(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    expect(replayed, "adapter must see toolCalls on the assistant message").toBeDefined();
  });

  it("emits synthetic tool results when the tool-call budget is exhausted (BUG #1)", async () => {
    // First (and only) round: model emits a tool_call but maxToolRounds is 0,
    // so we should NOT execute the tool but MUST keep history well-formed by
    // pushing a synthetic tool message.
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "call_x", name: "lean_check", argsDelta: '{"leanSource":""}' },
        { type: "done", finishReason: "tool_calls" },
      ],
    ]);
    const lean = new FakeLean({ ok: true, durationMs: 1, messages: [] });
    const session = new ChatSession({
      llm,
      model: "m",
      systemPrompt: "SYS",
      tools: [createLeanCheckTool(lean)],
      maxToolRounds: 0,
    });
    const events = await collect(session.send("go"));

    // Both events are surfaced even when tool execution is skipped.
    expect(events.find((e) => e.type === "tool-call")).toBeTruthy();
    expect(events.find((e) => e.type === "tool-result" && e.id === "call_x")).toBeTruthy();

    // Tool was NOT actually invoked.
    expect(lean.seen.length).toBe(0);

    // History stays well-formed: assistant.toolCalls + a tool message.
    const history = session.history();
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")!;
    expect(lastAssistant.toolCalls).toEqual([
      { id: "call_x", name: "lean_check", arguments: '{"leanSource":""}' },
    ]);
    const toolMsg = history.find((m) => m.role === "tool" && m.toolCallId === "call_x");
    expect(toolMsg, "a synthetic tool message must close the call").toBeDefined();
    expect(toolMsg!.content).toMatch(/budget/);
  });

  it("caps a large tool result in history and spills to disk when configured", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-sess-cap-"));
    try {
      const big = "Z".repeat(10_000);
      const bigTool: ToolSpec = {
        name: "big",
        parameters: {},
        async execute() {
          return { ok: false, content: big };
        },
      };
      const llm = new ScriptedLLM([
        [
          { type: "tool-call", id: "call_big", name: "big", argsDelta: "{}" },
          { type: "done", finishReason: "tool_calls" },
        ],
        [{ type: "text", delta: "done" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        tools: [bigTool],
        sessionId: "sess-cap",
        toolOutputCap: { workspace: tmp },
      });

      // The streamed event still carries the full content.
      const events = await collect(session.send("go"));
      const toolResult = events.find((e) => e.type === "tool-result") as Extract<
        ChatEvent,
        { type: "tool-result" }
      >;
      expect(toolResult.content).toBe(big);

      // History message is capped well under 4.5KB and carries the breadcrumb.
      const toolMsg = session.history().find((m) => m.role === "tool")!;
      expect(toolMsg.content).toContain("[output truncated");
      expect(Buffer.byteLength(toolMsg.content, "utf-8")).toBeLessThan(4500);

      // Full output dumped to disk.
      const dump = path.join(tmp, ".mathran", "tool-output", "sess-cap", "call_big.txt");
      const saved = await fs.readFile(dump, "utf-8");
      expect(saved).toBe(big);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not cap tool results when toolOutputCap is unset (backward compat)", async () => {
    const big = "Q".repeat(10_000);
    const bigTool: ToolSpec = {
      name: "big",
      parameters: {},
      async execute() {
        return { ok: true, content: big };
      },
    };
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "call_big", name: "big", argsDelta: "{}" },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "text", delta: "done" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({ llm, model: "m", tools: [bigTool] });
    await collect(session.send("go"));

    const toolMsg = session.history().find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe(big);
    expect(toolMsg.content).not.toContain("[output truncated");
  });

  describe("AbortSignal (v0.2 §7)", () => {
    it("throws AbortError immediately when the signal is already aborted", async () => {
      const llm = new ScriptedLLM([
        [{ type: "text", delta: "should not run" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({ llm, model: "m" });
      const controller = new AbortController();
      controller.abort();

      await expect(collect(session.send("hi", { signal: controller.signal }))).rejects.toMatchObject({
        name: "AbortError",
      });
      // History untouched — not even the user turn was committed, and the LLM
      // was never contacted.
      expect(session.history()).toEqual([]);
      expect(llm.requests).toHaveLength(0);
    });

    it("saves a partial assistant turn with an [aborted] marker on mid-stream abort", async () => {
      // A provider that yields one chunk then blocks forever on the next — the
      // abort must unblock the consumer via the iterator race.
      const slowLlm: LLMProvider = {
        async describe() {
          return { name: "slow" };
        },
        async chat(): Promise<LLMResponse> {
          return {
            stream() {
              return (async function* () {
                yield { type: "text", delta: "partial answer" } as LLMStreamChunk;
                // Never resolves; only the abort race ends the wait.
                await new Promise<void>(() => {});
                yield { type: "done", finishReason: "stop" } as LLMStreamChunk;
              })();
            },
          };
        },
      };
      const session = new ChatSession({ llm: slowLlm, model: "m" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 50);

      const out: ChatEvent[] = [];
      await expect(
        (async () => {
          for await (const ev of session.send("go", { signal: controller.signal })) out.push(ev);
        })(),
      ).rejects.toMatchObject({ name: "AbortError" });
      clearTimeout(timer);

      // We streamed the first delta before the abort landed.
      expect(out).toContainEqual({ type: "text", delta: "partial answer" });

      // History advanced by exactly 2 (user + partial assistant), and the
      // assistant turn carries the [aborted] marker.
      const history = session.history();
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ role: "user", content: "go" });
      expect(history[1].role).toBe("assistant");
      expect(history[1].content).toContain("partial answer");
      expect(history[1].content).toContain("[aborted]");
    });

    it("ignores a signal that aborts only after send() has completed", async () => {
      const llm = new ScriptedLLM([
        [
          { type: "text", delta: "all" },
          { type: "text", delta: " done" },
          { type: "done", finishReason: "stop" },
        ],
      ]);
      const session = new ChatSession({ llm, model: "m" });
      const controller = new AbortController();

      const events = await collect(session.send("hi", { signal: controller.signal }));
      expect(events.at(-1)).toEqual({ type: "done", finishReason: "stop" });

      // Aborting now is a no-op: the completed turn stays intact, no marker.
      controller.abort();
      const history = session.history();
      expect(history.at(-1)).toMatchObject({ role: "assistant", content: "all done" });
      expect(history.at(-1)!.content).not.toContain("[aborted]");
    });
  });
});

// ─── v0.2 §5: /compact + auto-compact ──────────────────────────────────────────

import type { LLMMessage as _LLMMessage } from "../providers/llm.js";

/** Counting LLM — surfaces a configurable countTokens for autoCompact tests. */
class CountingScriptedLLM implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  private i = 0;
  constructor(
    private turns: LLMStreamChunk[][],
    public tokenReturn: number,
  ) {}
  async describe() {
    return { name: "counting-scripted" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const turn = this.turns[this.i] ?? [{ type: "done", finishReason: "stop" }];
    this.i += 1;
    return responseOf(turn);
  }
  countTokens(_msgs: _LLMMessage[]): number {
    return this.tokenReturn;
  }
}

async function withWorkspace<T>(fn: (ws: string) => Promise<T>): Promise<T> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-compact-"));
  try {
    return await fn(ws);
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
}

describe("ChatSession.compact (v0.2 §5)", () => {
  it("swaps the in-memory history when middle chunk is non-empty", async () => {
    await withWorkspace(async (ws) => {
      // Summarizer LLM (used by the runner) and the per-turn scripted LLM are
      // the same object here — simplest possible setup.
      const llm = new ScriptedLLM([
        [{ type: "text", delta: "SUMMARY" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "SYS",
        workspace: ws,
      });
      // Seed 20 rounds worth of history.
      const seed: _LLMMessage[] = [];
      for (let i = 1; i <= 20; i++) {
        seed.push({ role: "user", content: `q${i}` });
        seed.push({ role: "assistant", content: `a${i}` });
      }
      session.replaceHistory(seed);

      const stats = await session.compact({ keepRecentRounds: 3 });
      expect(stats.noop).toBe(false);
      expect(stats.droppedRoundCount).toBe(17);
      expect(stats.originalTokenCount).toBeGreaterThan(stats.newTokenCount);

      const h = session.history();
      // Expect: [system, summary-system, last 3 rounds = 6 msgs]
      expect(h.length).toBe(2 + 6);
      expect(h[0].role).toBe("system");
      expect(h[0].content).toBe("SYS");
      expect(h[1].role).toBe("system");
      expect(h[1].content).toContain("SUMMARY");
      expect(h[h.length - 2]).toMatchObject({ role: "user", content: "q20" });
    });
  });

  it("is a no-op when history is short", async () => {
    await withWorkspace(async (ws) => {
      const llm = new ScriptedLLM([]);
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "SYS",
        workspace: ws,
      });
      session.replaceHistory([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
      const stats = await session.compact({ keepRecentRounds: 5 });
      expect(stats.noop).toBe(true);
      expect(stats.droppedRoundCount).toBe(0);
      // History unchanged.
      const h = session.history();
      expect(h.length).toBe(3); // system + user + assistant
    });
  });

  it("send() still works on the compacted history", async () => {
    await withWorkspace(async (ws) => {
      const llm = new ScriptedLLM([
        // Compaction summarizer call.
        [{ type: "text", delta: "OLD-SUMMARY" }, { type: "done", finishReason: "stop" }],
        // The next send() turn.
        [{ type: "text", delta: "post-compact reply" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "SYS",
        workspace: ws,
      });
      const seed: _LLMMessage[] = [];
      for (let i = 1; i <= 12; i++) {
        seed.push({ role: "user", content: `q${i}` });
        seed.push({ role: "assistant", content: `a${i}` });
      }
      session.replaceHistory(seed);
      await session.compact({ keepRecentRounds: 2 });
      const events = await collect(session.send("new question"));
      const text = events
        .filter((e) => e.type === "text")
        .map((e) => (e as Extract<ChatEvent, { type: "text" }>).delta)
        .join("");
      expect(text).toBe("post-compact reply");
      // Last message is the assistant reply, prior is the new user msg.
      const h = session.history();
      expect(h.at(-1)).toMatchObject({ role: "assistant", content: "post-compact reply" });
      expect(h.at(-2)).toMatchObject({ role: "user", content: "new question" });
    });
  });

  it("autoCompact disabled → never triggers compact even when over threshold", async () => {
    await withWorkspace(async (ws) => {
      const llm = new CountingScriptedLLM(
        [[{ type: "text", delta: "reply" }, { type: "done", finishReason: "stop" }]],
        999_999, // huge token count
      );
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "SYS",
        workspace: ws,
        // autoCompact NOT set.
      });
      const seed: _LLMMessage[] = [];
      for (let i = 1; i <= 20; i++) {
        seed.push({ role: "user", content: `q${i}` });
        seed.push({ role: "assistant", content: `a${i}` });
      }
      session.replaceHistory(seed);
      const lenBefore = session.history().length;
      await collect(session.send("new turn"));
      const lenAfter = session.history().length;
      // No compaction happened → history just grew by user + assistant (2).
      expect(lenAfter).toBe(lenBefore + 2);
    });
  });

  it("autoCompact enabled + high token count → compacts before the provider call", async () => {
    await withWorkspace(async (ws) => {
      const llm = new CountingScriptedLLM(
        [
          // Summarizer call.
          [{ type: "text", delta: "AUTO-SUMMARY" }, { type: "done", finishReason: "stop" }],
          // Real send() turn.
          [{ type: "text", delta: "compacted reply" }, { type: "done", finishReason: "stop" }],
        ],
        999_999, // way over threshold
      );
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "SYS",
        workspace: ws,
        autoCompact: {
          enabled: true,
          thresholdPct: 0.5,
          keepRecentRounds: 2,
          contextWindow: 1000,
        },
      });
      const seed: _LLMMessage[] = [];
      for (let i = 1; i <= 15; i++) {
        seed.push({ role: "user", content: `q${i}` });
        seed.push({ role: "assistant", content: `a${i}` });
      }
      session.replaceHistory(seed);

      await collect(session.send("please continue"));

      const h = session.history();
      // After auto-compact: [system, summary-system, last 2 rounds = 4 msgs, new user, new assistant]
      expect(h.length).toBe(2 + 4 + 2);
      expect(h[1].role).toBe("system");
      expect(h[1].content).toContain("AUTO-SUMMARY");
      // The provider should have been called twice: once for the summarizer,
      // once for the actual user turn.
      expect(llm.requests.length).toBe(2);
    });
  });
});

// ─── v0.2 §9: read_file_summary built-in tool ─────────────────────────

import { SubagentScheduler } from "../subagent/scheduler.js";
import { SubagentRegistry } from "../subagent/registry.js";
import type { SubagentResult } from "../subagent/types.js";

/**
 * Mock SubagentScheduler that records every dispatch and returns canned
 * results. The constructor accepts a callback so tests can decide the
 * response on a per-dispatch basis (so we can vary status: ok / error).
 */
class RecordingScheduler {
  readonly seen: Array<{
    type: string;
    input: Record<string, unknown>;
    hardCapBytes?: number;
  }> = [];
  constructor(
    private respond: (
      task: { type: string; input: Record<string, unknown> },
    ) => Partial<SubagentResult>,
  ) {}
  async dispatch(task: {
    type: string;
    input: Record<string, unknown>;
    hardCapBytes?: number;
  }): Promise<SubagentResult> {
    this.seen.push({
      type: task.type,
      input: task.input,
      hardCapBytes: task.hardCapBytes,
    });
    const base = this.respond(task);
    const now = new Date().toISOString();
    return {
      runId: "sub-mock0000",
      type: "read_summarize",
      status: base.status ?? "ok",
      summary: base.summary ?? "",
      artifactPath: base.artifactPath ?? null,
      stats: {
        startedAt: now,
        endedAt: now,
        durationMs: 0,
      },
      ...(base.errorMessage ? { errorMessage: base.errorMessage } : {}),
    };
  }
}

describe("ChatSession.builtinTools.read_file_summary (v0.2 §9)", () => {
  it("registers the tool, dispatches to the scheduler, feeds the summary back to the LLM", async () => {
    // Two turns: assistant calls read_file_summary; then assistant replies
    // with plain text after seeing the tool result.
    const llm = new ScriptedLLM([
      [
        {
          type: "tool-call",
          id: "call_1",
          name: "read_file_summary",
          argsDelta: JSON.stringify({
            path: "notes.md",
            question: "What's the v0.2 plan?",
          }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "The summary says X." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const scheduler = new RecordingScheduler(() => ({
      status: "ok",
      summary: "v0.2 ships subagents, compact, memory.",
      artifactPath: ".mathran/subagents/sub-abc/source.txt",
    }));
    const session = new ChatSession({
      llm,
      model: "m",
      // Cast: we duck-type the scheduler in tests.
      subagentScheduler: scheduler as unknown as SubagentScheduler,
      builtinTools: { read_file_summary: true },
    });

    const events = await collect(session.send("summarize notes.md please"));

    // The tool was advertised in the first request.
    expect(llm.requests.length).toBe(2);
    const toolsInReq = llm.requests[0].tools ?? [];
    const names = toolsInReq.map((t) => t.name);
    expect(names).toContain("read_file_summary");

    // The scheduler saw exactly one dispatch with the correct shape.
    expect(scheduler.seen.length).toBe(1);
    expect(scheduler.seen[0].type).toBe("read_summarize");
    expect(scheduler.seen[0].input.path).toBe("notes.md");
    expect(scheduler.seen[0].input.question).toBe("What's the v0.2 plan?");
    // llm injected into the runner input (mirrors compact pattern).
    expect(scheduler.seen[0].input.llm).toBeDefined();
    expect(scheduler.seen[0].hardCapBytes).toBe(2048);

    // The second request to the LLM carries the tool result.
    const followupMessages = llm.requests[1].messages;
    const toolMsg = followupMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("v0.2 ships subagents, compact, memory.");
    expect(toolMsg?.content).toContain(".mathran/subagents/sub-abc/source.txt");

    // And the final assistant text streamed out.
    const finalText = events
      .filter((e) => e.type === "text")
      .map((e) => (e as Extract<ChatEvent, { type: "text" }>).delta)
      .join("");
    expect(finalText).toBe("The summary says X.");
  });

  it("surfaces a runner error (path escape) as a non-OK tool result, not a thrown exception", async () => {
    const llm = new ScriptedLLM([
      [
        {
          type: "tool-call",
          id: "call_x",
          name: "read_file_summary",
          argsDelta: JSON.stringify({
            path: "../../etc/passwd",
            question: "creds?",
          }),
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "Sorry, can't." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const scheduler = new RecordingScheduler(() => ({
      status: "error",
      summary: "Refused: path \"../../etc/passwd\" escapes the workspace",
      artifactPath: null,
      errorMessage: "read_summarize: path escapes workspace",
    }));
    const session = new ChatSession({
      llm,
      model: "m",
      subagentScheduler: scheduler as unknown as SubagentScheduler,
      builtinTools: { read_file_summary: true },
    });

    const events = await collect(session.send("read /etc/passwd"));

    // No throw, and the tool result carries the refusal text.
    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult).toBeDefined();
    expect(toolResult.ok).toBe(false);
    expect(toolResult.content).toMatch(/escape|workspace/i);
  });

  it("does NOT register read_file_summary when builtinTools is unset", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "plain reply" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      // builtinTools omitted entirely.
    });
    await collect(session.send("hi"));
    const toolsInReq = llm.requests[0].tools;
    // Either undefined (no tools advertised) or an array that doesn't contain
    // our built-in.
    if (toolsInReq) {
      const names = toolsInReq.map((t) => t.name);
      expect(names).not.toContain("read_file_summary");
    } else {
      expect(toolsInReq).toBeUndefined();
    }
  });
});

