import { describe, it, expect } from "vitest";
import { ChatSession, type ChatEvent } from "./session.js";
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
});
