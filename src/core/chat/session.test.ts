import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatSession, type ChatEvent, type ToolSpec } from "./session.js";
import { createLeanCheckTool } from "./tools/lean-check.js";
import { ApprovalBroker } from "./approval-broker.js";
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
      { type: "usage" },
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
      "usage",
      "tool-call",
      "tool-result",
      "text", // "It compiles."
      "usage",
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
      expect(Buffer.byteLength(toolMsg.content as string, "utf-8")).toBeLessThan(4500);

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


// ─── v0.2 §8: builtinTools.search ─────────────────────────────────────────────

import { SubagentRegistry } from "../subagent/registry.js";
import { SubagentScheduler } from "../subagent/scheduler.js";
import { searchRunner } from "../subagent/runners/search.js";

describe("ChatSession builtinTools.search (v0.2 §8)", () => {
  it("does NOT register the search tool when builtinTools.search is unset", () => {
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "plain" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      // builtinTools omitted entirely.
    });
    return collect(session.send("hi")).then(() => {
      const req = llm.requests[0];
      const toolNames = (req.tools ?? []).map((t) => t.name);
      expect(toolNames).not.toContain("search");
    });
  });

  it("registers the search tool via lazy scheduler when builtinTools.search is true (no explicit scheduler)", async () => {
    // v0.2 §9+ unified semantics: built-in tools use the lazy
    // `getOrBuildScheduler()` pattern (same as compact / read_file_summary),
    // so the tool registers even without an injected scheduler.
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "no tool" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      builtinTools: { search: true },
    });
    await collect(session.send("hi"));
    const req = llm.requests[0];
    const toolNames = (req.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("search");
  });

  it("registers and exposes the search tool when scheduler is wired", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-search-"));
    try {
      const registry = new SubagentRegistry();
      registry.register(searchRunner);
      const scheduler = new SubagentScheduler({ workspace: ws, registry });
      const llm = new ScriptedLLM([
        [{ type: "text", delta: "no tool" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        builtinTools: { search: true },
        subagentScheduler: scheduler,
      });
      await collect(session.send("hi"));
      const req = llm.requests[0];
      const toolNames = (req.tools ?? []).map((t) => t.name);
      expect(toolNames).toContain("search");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("executes the search tool and returns the summary text", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-search-"));
    try {
      // Seed one file with three matches.
      await fs.writeFile(path.join(ws, "a.ts"), "needle\nother\nneedle\nneedle\n");

      // Mock scheduler that returns a fixed summary regardless of input.
      const stubScheduler = {
        async dispatch(task: any) {
          return {
            runId: "sub-stub0001",
            type: task.type,
            status: "ok" as const,
            summary: 'Found 3 matches in 1 file for "needle".',
            artifactPath: ".mathran/subagents/sub-stub0001/matches.jsonl",
            stats: {
              startedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: 0,
            },
          };
        },
        inFlightCount() {
          return 0;
        },
      } as unknown as SubagentScheduler;

      const llm = new ScriptedLLM([
        // First turn: assistant calls the search tool.
        [
          {
            type: "tool-call",
            id: "call_1",
            name: "search",
            argsDelta: '{"query":"needle"}',
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        // Second turn: assistant produces final text.
        [
          { type: "text", delta: "done" },
          { type: "done", finishReason: "stop" },
        ],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        builtinTools: { search: true },
        subagentScheduler: stubScheduler,
      });

      const events = await collect(session.send("look up needle"));
      const toolResult = events.find((e) => e.type === "tool-result") as
        | Extract<ChatEvent, { type: "tool-result" }>
        | undefined;
      expect(toolResult).toBeDefined();
      expect(toolResult!.ok).toBe(true);
      expect(toolResult!.content).toContain('Found 3 matches in 1 file for "needle".');

      // The history should record the tool message with the summary.
      const h = session.history();
      const toolMsg = h.find((m) => m.role === "tool");
      expect(toolMsg?.content).toContain("Found 3 matches");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
// ─── v0.2 §9: read_file_summary built-in tool ─────────────────────────

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

describe("ChatSession memoryFiles (v0.3 §14)", () => {
  it("injects memory block before systemPrompt when MATHRAN.md exists", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-mem-"));
    try {
      await fs.writeFile(path.join(tmp, "MATHRAN.md"), "PROJECT_NOTES_XYZ", "utf8");

      const llm = new ScriptedLLM([]);
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "persona-prompt",
        memoryFiles: { enabled: true, workspace: tmp },
      });

      const history = session.history();
      // Two system messages: memory first, persona second.
      expect(history[0].role).toBe("system");
      expect(history[0].content).toContain("PROJECT_NOTES_XYZ");
      expect(history[0].content).toContain("# Persistent memory");
      expect(history[1]?.role).toBe("system");
      expect(history[1]?.content).toBe("persona-prompt");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("injects only persona when memoryFiles is omitted (default off)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-mem-"));
    try {
      await fs.writeFile(path.join(tmp, "MATHRAN.md"), "NEVER_INJECTED", "utf8");
      const llm = new ScriptedLLM([]);
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "persona-prompt",
        // memoryFiles intentionally unset — default behavior must NOT touch
        // disk for MATHRAN.md.
      });
      const history = session.history();
      expect(history.length).toBe(1);
      expect(history[0].role).toBe("system");
      expect(history[0].content).toBe("persona-prompt");
      expect(history[0].content).not.toContain("NEVER_INJECTED");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("injects nothing when memoryFiles.enabled=true but no files exist", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-mem-"));
    try {
      const llm = new ScriptedLLM([]);
      // Use a non-existent workspace dir so neither global (likely absent) nor
      // project file is found. We can't easily mock $HOME here so the global
      // file is probably absent in CI; if it exists, the persona is still
      // present after it.
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "persona-only",
        memoryFiles: { enabled: true, workspace: tmp },
      });
      const history = session.history();
      // Last leading system message must be the persona.
      const personaIdx = history.findIndex((m) => m.content === "persona-only");
      expect(personaIdx).toBeGreaterThanOrEqual(0);
      // No system message should contain a project body header pointing into
      // our (empty) tmp dir.
      const projHeader = `## Project (${path.join(tmp, "MATHRAN.md")})`;
      const sawProj = history.some(
        (m) => m.role === "system" && typeof m.content === "string" && (m.content ?? "").includes(projHeader),
      );
      expect(sawProj).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reset() preserves both leading system messages (memory + persona)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-mem-"));
    try {
      await fs.writeFile(path.join(tmp, "MATHRAN.md"), "MEM_BODY", "utf8");
      const llm = new ScriptedLLM([
        [
          { type: "text", delta: "hi" },
          { type: "done", finishReason: "stop" },
        ],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        systemPrompt: "persona",
        memoryFiles: { enabled: true, workspace: tmp },
      });
      // Add a user/assistant round, then reset.
      await collect(session.send("yo"));
      session.reset();
      const remaining = session.history();
      expect(remaining.every((m) => m.role === "system")).toBe(true);
      // Memory should still be there.
      expect(remaining.some((m) => typeof m.content === "string" && (m.content ?? "").includes("MEM_BODY"))).toBe(true);
      expect(remaining.some((m) => m.content === "persona")).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});


// ─── v0.4 §1: filesystem & shell builtin tools ──────────────────────────
describe("ChatSession builtinTools.{bash,read_file,write_file,edit_file} (v0.4 §1)", () => {
  it("registers none of the v0.4 tools when their flags are unset", async () => {
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      builtinTools: {},
    });
    await collect(session.send("hi"));
    const names = (llm.requests[0].tools ?? []).map((t) => t.name);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
  });

  it("registers each tool exactly when its flag is true", async () => {
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      builtinTools: {
        bash: true,
        read_file: true,
        write_file: true,
        edit_file: true,
      },
    });
    await collect(session.send("hi"));
    const names = (llm.requests[0].tools ?? []).map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
  });

  it("read_file resolves paths against ChatSession.workspace", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-rf-"));
    try {
      await fs.writeFile(path.join(ws, "hi.txt"), "hello v0.4");
      const llm = new ScriptedLLM([
        [
          {
            type: "tool-call",
            id: "call_1",
            name: "read_file",
            argsDelta: '{"path":"hi.txt"}',
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [{ type: "text", delta: "done" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        workspace: ws,
        builtinTools: { read_file: true },
      });
      const events = await collect(session.send("hi"));
      const result = events.find((e) => e.type === "tool-result") as
        | Extract<ChatEvent, { type: "tool-result" }>
        | undefined;
      expect(result).toBeDefined();
      expect(result!.ok).toBe(true);
      expect(result!.content).toContain("hello v0.4");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("write_file persists to disk inside ChatSession.workspace", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-wf-"));
    try {
      const llm = new ScriptedLLM([
        [
          {
            type: "tool-call",
            id: "call_1",
            name: "write_file",
            argsDelta: '{"path":"out.txt","content":"round trip"}',
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [{ type: "text", delta: "done" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        workspace: ws,
        builtinTools: { write_file: true },
      });
      const events = await collect(session.send("hi"));
      const result = events.find((e) => e.type === "tool-result") as
        | Extract<ChatEvent, { type: "tool-result" }>
        | undefined;
      expect(result).toBeDefined();
      expect(result!.ok).toBe(true);
      const onDisk = await fs.readFile(path.join(ws, "out.txt"), "utf-8");
      expect(onDisk).toBe("round trip");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("edit_file replaces a unique occurrence inside ChatSession.workspace", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-ef-"));
    try {
      await fs.writeFile(path.join(ws, "doc.md"), "alpha\nbeta\n");
      const llm = new ScriptedLLM([
        [
          {
            type: "tool-call",
            id: "call_0",
            name: "read_file",
            argsDelta: '{"path":"doc.md"}',
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          {
            type: "tool-call",
            id: "call_1",
            name: "edit_file",
            argsDelta:
              '{"path":"doc.md","old_string":"beta","new_string":"delta"}',
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [{ type: "text", delta: "done" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        workspace: ws,
        builtinTools: { read_file: true, edit_file: true },
      });
      const events = await collect(session.send("hi"));
      const result = events.findLast((e) => e.type === "tool-result") as
        | Extract<ChatEvent, { type: "tool-result" }>
        | undefined;
      expect(result).toBeDefined();
      expect(result!.ok).toBe(true);
      const onDisk = await fs.readFile(path.join(ws, "doc.md"), "utf-8");
      expect(onDisk).toBe("alpha\ndelta\n");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("bash runs a quick command inside ChatSession.workspace", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-session-bash-"));
    try {
      await fs.writeFile(path.join(ws, "marker"), "yes");
      const llm = new ScriptedLLM([
        [
          {
            type: "tool-call",
            id: "call_1",
            name: "bash",
            argsDelta: '{"command":"cat marker"}',
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [{ type: "text", delta: "done" }, { type: "done", finishReason: "stop" }],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        workspace: ws,
        builtinTools: { bash: true },
      });
      const events = await collect(session.send("hi"));
      const result = events.find((e) => e.type === "tool-result") as
        | Extract<ChatEvent, { type: "tool-result" }>
        | undefined;
      expect(result).toBeDefined();
      expect(result!.ok).toBe(true);
      expect(result!.content).toContain("yes");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

// ─── v0.5 §7: read-before-write tracking (Gap #7) ────────────────────────────
describe("ChatSession read-before-write tracking (v0.5 §7)", () => {
  it("read_file then write_file on existing file succeeds end-to-end", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readtrack-"));
    try {
      await fs.writeFile(path.join(ws, "doc.txt"), "original\n", "utf8");
      const llm = new ScriptedLLM([
        [
          {
            type: "tool-call",
            id: "c1",
            name: "read_file",
            argsDelta: JSON.stringify({ path: "doc.txt" }),
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          {
            type: "tool-call",
            id: "c2",
            name: "write_file",
            argsDelta: JSON.stringify({ path: "doc.txt", content: "updated\n" }),
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          { type: "text", delta: "done" },
          { type: "done", finishReason: "stop" },
        ],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        workspace: ws,
        builtinTools: { read_file: true, write_file: true },
      });

      const events = await collect(session.send("update doc.txt"));
      const results = events.filter((e) => e.type === "tool-result") as Extract<
        ChatEvent,
        { type: "tool-result" }
      >[];
      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
      expect(await fs.readFile(path.join(ws, "doc.txt"), "utf8")).toBe("updated\n");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("write_file on existing file without prior read_file returns helpful error", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readtrack-"));
    try {
      await fs.writeFile(path.join(ws, "doc.txt"), "original\n", "utf8");
      const llm = new ScriptedLLM([
        [
          {
            type: "tool-call",
            id: "c1",
            name: "write_file",
            argsDelta: JSON.stringify({ path: "doc.txt", content: "nope\n" }),
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          { type: "text", delta: "ok" },
          { type: "done", finishReason: "stop" },
        ],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        workspace: ws,
        builtinTools: { read_file: true, write_file: true },
      });

      const events = await collect(session.send("overwrite doc.txt"));
      const result = events.find((e) => e.type === "tool-result") as Extract<
        ChatEvent,
        { type: "tool-result" }
      >;
      expect(result.ok).toBe(false);
      expect(result.content).toContain("must read this file first");
      // File left untouched.
      expect(await fs.readFile(path.join(ws, "doc.txt"), "utf8")).toBe("original\n");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("replaceHistory clears readPaths so next write needs re-read", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readtrack-"));
    try {
      await fs.writeFile(path.join(ws, "doc.txt"), "original\n", "utf8");
      const llm = new ScriptedLLM([
        // Send 1: read_file registers the path.
        [
          {
            type: "tool-call",
            id: "c1",
            name: "read_file",
            argsDelta: JSON.stringify({ path: "doc.txt" }),
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          { type: "text", delta: "read" },
          { type: "done", finishReason: "stop" },
        ],
        // Send 2 (after replaceHistory): write_file must be rejected.
        [
          {
            type: "tool-call",
            id: "c2",
            name: "write_file",
            argsDelta: JSON.stringify({ path: "doc.txt", content: "x\n" }),
          },
          { type: "done", finishReason: "tool_calls" },
        ],
        [
          { type: "text", delta: "ok" },
          { type: "done", finishReason: "stop" },
        ],
      ]);
      const session = new ChatSession({
        llm,
        model: "m",
        workspace: ws,
        builtinTools: { read_file: true, write_file: true },
      });

      await collect(session.send("read doc.txt"));
      // Wipe conversation context — read tracking must reset too.
      session.replaceHistory([]);

      const events = await collect(session.send("overwrite doc.txt"));
      const result = events.find((e) => e.type === "tool-result") as Extract<
        ChatEvent,
        { type: "tool-result" }
      >;
      expect(result.ok).toBe(false);
      expect(result.content).toContain("must read this file first");
      expect(await fs.readFile(path.join(ws, "doc.txt"), "utf8")).toBe("original\n");
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

describe("ChatSession layeredSkills injection", () => {
  it("injects a skills system message before the persona prompt", () => {
    const llm = new ScriptedLLM([]);
    const session = new ChatSession({
      llm,
      model: "m",
      systemPrompt: "PERSONA",
      layeredSkills: [
        {
          name: "lean-helper",
          layer: "workspace",
          path: "/x/SKILL.md",
          manifest: { name: "lean-helper", description: "Helps with Lean" },
          body: "body",
        },
      ],
    });
    const sys = session.history().filter((m) => m.role === "system");
    const joined = sys.map((m) => m.content).join("\n");
    expect(joined).toContain("Available skills");
    expect(joined).toContain("lean-helper");
    // persona prompt must come after the skills fragment
    const idxSkills = sys.findIndex((m) => String(m.content).includes("lean-helper"));
    const idxPersona = sys.findIndex((m) => m.content === "PERSONA");
    expect(idxSkills).toBeLessThan(idxPersona);
  });

  it("injects nothing when layeredSkills is empty", () => {
    const llm = new ScriptedLLM([]);
    const session = new ChatSession({ llm, model: "m", layeredSkills: [] });
    const sys = session.history().filter((m) => m.role === "system");
    expect(sys.every((m) => !String(m.content).includes("Available skills"))).toBe(true);
  });
});

describe("ChatSession skill triggers (Skills/Plugins 二层)", () => {
  function skill(
    name: string,
    manifest: Record<string, unknown>,
    body = "",
  ) {
    return {
      name,
      layer: "user" as const,
      path: `/x/${name}/SKILL.md`,
      manifest: { name, ...manifest } as any,
      body,
    };
  }

  it("injects an always-skill body at construction (permanent)", () => {
    const llm = new ScriptedLLM([]);
    const session = new ChatSession({
      llm,
      model: "m",
      layeredSkills: [skill("always-one", {}, "ALWAYS BODY TEXT")],
    });
    const joined = session
      .history()
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(joined).toContain("ALWAYS BODY TEXT");
  });

  it("does NOT inject a trigger-skill body at construction", () => {
    const llm = new ScriptedLLM([]);
    const session = new ChatSession({
      llm,
      model: "m",
      layeredSkills: [
        skill("kw", { trigger: "lean" }, "TRIGGER BODY TEXT"),
      ],
    });
    const joined = session
      .history()
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(joined).not.toContain("TRIGGER BODY TEXT");
  });

  it("injects a matched trigger skill into the turn's LLM request, then removes it", async () => {
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      layeredSkills: [
        skill("kw", { trigger: "lean", promptTemplate: "SKILL FOR: {{userMessage}}" }),
      ],
    });
    await collect(session.send("my lean proof"));
    // The request the model saw must include the rendered skill fragment.
    const reqSystem = llm.requests[0].messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(reqSystem).toContain("SKILL FOR: my lean proof");
    // But it is transient: gone from persisted history after the turn.
    const histSystem = session
      .history()
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(histSystem).not.toContain("SKILL FOR:");
  });

  it("does not inject when the trigger does not match", async () => {
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      layeredSkills: [skill("kw", { trigger: "lean" }, "SHOULD NOT APPEAR")],
    });
    await collect(session.send("hello world"));
    const reqSystem = llm.requests[0].messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(reqSystem).not.toContain("SHOULD NOT APPEAR");
  });

  it("registers an always-skill's allowedTools as session rules at construction", () => {
    const llm = new ScriptedLLM([]);
    const broker = new ApprovalBroker({ policy: "on-request" });
    new ChatSession({
      llm,
      model: "m",
      approvalBroker: broker,
      layeredSkills: [skill("a", { allowedTools: ["bash:lake"] }, "body")],
    });
    expect(broker.sessionRulesSnapshot).toEqual([
      { tool: "bash", prefix: "lake", action: "allow", scope: "session" },
    ]);
  });

  it("registers a trigger-skill's allowedTools only when it matches", async () => {
    const llm = new ScriptedLLM([
      [{ type: "text", delta: "ok" }, { type: "done", finishReason: "stop" }],
      [{ type: "text", delta: "ok" }, { type: "done", finishReason: "stop" }],
    ]);
    const broker = new ApprovalBroker({ policy: "on-request" });
    const session = new ChatSession({
      llm,
      model: "m",
      approvalBroker: broker,
      layeredSkills: [skill("kw", { trigger: "lean", allowedTools: ["bash"] })],
    });
    // No match yet.
    expect(broker.sessionRulesSnapshot).toEqual([]);
    await collect(session.send("no relevant words"));
    expect(broker.sessionRulesSnapshot).toEqual([]);
    // Now it matches → rule registered.
    await collect(session.send("my lean goal"));
    expect(broker.sessionRulesSnapshot).toEqual([
      { tool: "bash", action: "allow", scope: "session" },
    ]);
  });
});
