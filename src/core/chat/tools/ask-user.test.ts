/**
 * Tests for the built-in `ask_user` tool (v0.16 §11).
 *
 * Covers:
 *   • CLI / synchronous resolver: question → reply → tool result, round continues.
 *   • Empty / whitespace reply normalized to `"(no reply)"`.
 *   • Empty question argument returns an error tool result without calling the resolver.
 *   • Serve-style resolver: `AskUserPending` propagates out of `ChatSession.send`,
 *     placeholder tool message gets pushed for the failing call, and (most
 *     importantly) for any not-yet-executed sibling calls in the same batch —
 *     the provider-validation invariant requires every assistant `tool_call`
 *     id be paired with a `tool` message before the next turn.
 *   • `ChatSession.resume()` continues the round after the placeholder is
 *     patched in place, without pushing a new user message or auto-compacting.
 *   • Goal-mode canned resolver returns the standard auto-reply string.
 */

import { describe, it, expect } from "vitest";
import { ChatSession, type ChatEvent } from "../session.js";
import {
  AskUserPending,
  ASK_USER_GOAL_AUTO_REPLY,
  ASK_USER_PENDING_PLACEHOLDER,
  createAskUserTool,
  isAskUserPending,
  type AskUserResolver,
} from "./ask-user.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";

function responseOf(chunks: LLMStreamChunk[]): LLMResponse {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
}

class ScriptedLLM implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  private turns: LLMStreamChunk[][];
  private i = 0;
  constructor(turns: LLMStreamChunk[][]) {
    this.turns = turns;
  }
  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "scripted-llm" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const turn = this.turns[this.i++] ?? [{ type: "done", finishReason: "stop" } as LLMStreamChunk];
    return responseOf(turn);
  }
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe("ask_user tool", () => {
  it("synchronous resolver: question → reply round-trips as a tool result", async () => {
    let seenQuestion = "";
    let seenCallId = "";
    const resolver: AskUserResolver = async (q, ctx) => {
      seenQuestion = q;
      seenCallId = ctx.callId;
      return "between 1 and 10";
    };

    const llm = new ScriptedLLM([
      // Round 1: model asks for clarification.
      [
        { type: "tool-call", id: "ask_1", name: "ask_user", argsDelta: '{"question":"What range?"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      // Round 2: model uses the reply.
      [
        { type: "text", delta: "Using range 1..10." },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    const session = new ChatSession({
      llm,
      model: "m",
      tools: [],
      builtinTools: { ask_user: { resolver } },
    });

    const events = await collect(session.send("pick a number"));
    const types = events.map((e) => e.type);
    // Synchronous resolver: no `ask_user` event is emitted because we
    // never bailed out of the loop (only the throw branch yields one).
    // The model just sees a normal tool-call → tool-result.
    expect(types).toEqual(["tool-call", "tool-result", "text", "done"]);

    // The resolver received the question text and the provider's tool-call id.
    expect(seenQuestion).toBe("What range?");
    expect(seenCallId).toBe("ask_1");

    // The tool result fed back to the model is the resolver's reply.
    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult.ok).toBe(true);
    expect(toolResult.content).toBe("between 1 and 10");

    // The model's second-turn request includes the tool message with the reply.
    expect(llm.requests).toHaveLength(2);
    const toolMsg = llm.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({
      role: "tool",
      content: "between 1 and 10",
      toolCallId: "ask_1",
    });
  });

  it("normalizes an empty / whitespace reply to '(no reply)'", async () => {
    const resolver: AskUserResolver = async () => "   ";
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "ask_1", name: "ask_user", argsDelta: '{"question":"hm?"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      tools: [],
      builtinTools: { ask_user: { resolver } },
    });
    const events = await collect(session.send("?"));
    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult.content).toBe("(no reply)");
  });

  it("rejects an empty question without calling the resolver", async () => {
    let resolverCalled = false;
    const resolver: AskUserResolver = async () => {
      resolverCalled = true;
      return "x";
    };
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "ask_1", name: "ask_user", argsDelta: '{"question":""}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      tools: [],
      builtinTools: { ask_user: { resolver } },
    });
    const events = await collect(session.send("?"));
    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult.ok).toBe(false);
    expect(toolResult.content).toMatch(/non-empty/);
    expect(resolverCalled).toBe(false);
  });

  it("serve-style resolver: AskUserPending propagates, placeholder is pushed, ask_user event is emitted", async () => {
    const resolver: AskUserResolver = async (question, { callId }) => {
      throw new AskUserPending({ question, callId });
    };

    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "ask_1", name: "ask_user", argsDelta: '{"question":"What env?"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
    ]);

    const session = new ChatSession({
      llm,
      model: "m",
      tools: [],
      builtinTools: { ask_user: { resolver } },
    });

    const events: ChatEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const ev of session.send("build the project")) {
        events.push(ev);
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(isAskUserPending(thrown)).toBe(true);
    expect((thrown as AskUserPending).question).toBe("What env?");
    expect((thrown as AskUserPending).callId).toBe("ask_1");

    // The session yielded the ask_user event before throwing.
    const askEv = events.find((e) => e.type === "ask_user") as Extract<
      ChatEvent,
      { type: "ask_user" }
    >;
    expect(askEv).toBeDefined();
    expect(askEv.id).toBe("ask_1");
    expect(askEv.question).toBe("What env?");

    // Critical: history must include a placeholder tool message keyed by
    // the failing call's id so the next provider call validates.
    const history = session.history();
    const placeholder = history.find(
      (m) => m.role === "tool" && m.toolCallId === "ask_1",
    );
    expect(placeholder).toBeDefined();
    expect(placeholder?.content).toBe(ASK_USER_PENDING_PLACEHOLDER);

    // Only ONE chat() call: the second round never ran because we bailed.
    expect(llm.requests).toHaveLength(1);
  });

  it("resume() continues the round after the placeholder is patched", async () => {
    const resolver: AskUserResolver = async (question, { callId }) => {
      throw new AskUserPending({ question, callId });
    };

    const llm = new ScriptedLLM([
      // Round 1: ask.
      [
        { type: "tool-call", id: "ask_1", name: "ask_user", argsDelta: '{"question":"yes or no?"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      // Round 2 (after resume): model uses the patched reply.
      [
        { type: "text", delta: "Got it, proceeding with yes." },
        { type: "done", finishReason: "stop" },
      ],
    ]);

    const session = new ChatSession({
      llm,
      model: "m",
      tools: [],
      builtinTools: { ask_user: { resolver } },
    });

    let caught: unknown = null;
    try {
      for await (const _ of session.send("ambiguous")) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    expect(isAskUserPending(caught)).toBe(true);

    // Patch the placeholder in history (mirrors what the serve answer
    // endpoint does on the wire).
    const history = session.history();
    let patched = 0;
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (
        m.role === "tool" &&
        m.toolCallId === "ask_1" &&
        m.content === ASK_USER_PENDING_PLACEHOLDER
      ) {
        history[i] = { ...m, content: "yes" };
        patched++;
      }
    }
    expect(patched).toBe(1);
    session.replaceHistory(history);

    // Resume — should NOT push a new user message, should continue the loop.
    const resumeEvents = await collect(session.resume());
    expect(resumeEvents.map((e) => e.type)).toEqual(["text", "done"]);
    const text = resumeEvents.find((e) => e.type === "text") as Extract<
      ChatEvent,
      { type: "text" }
    >;
    expect(text.delta).toBe("Got it, proceeding with yes.");

    // The provider received the patched tool message — confirming resume
    // didn't reset history.
    expect(llm.requests).toHaveLength(2);
    const resumeToolMsg = llm.requests[1].messages.find(
      (m) => m.role === "tool" && m.toolCallId === "ask_1",
    );
    expect(resumeToolMsg?.content).toBe("yes");

    // History tail is the assistant's resumed answer, not a duplicate user.
    const userCount = session.history().filter((m) => m.role === "user").length;
    expect(userCount).toBe(1); // only the original "ambiguous"
  });

  it("placeholder is pushed for SIBLING calls in the same batch when ask_user bails mid-batch", async () => {
    // The model emits two tool calls in one turn: ask_user then a sibling
    // call. When ask_user throws AskUserPending, the session MUST push a
    // tool message for the sibling too — provider validation otherwise
    // rejects the unanswered tool_call id on the next chat() call.
    const resolver: AskUserResolver = async (q, { callId }) => {
      throw new AskUserPending({ question: q, callId });
    };
    let bashCalled = false;
    const bashTool = {
      name: "bash",
      description: "shell",
      parameters: { type: "object", properties: {} },
      async execute() {
        bashCalled = true;
        return { ok: true, content: "ran" };
      },
    } as const;

    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "ask_1", name: "ask_user", argsDelta: '{"question":"?"}' },
        { type: "tool-call", id: "bash_1", name: "bash", argsDelta: "{}" },
        { type: "done", finishReason: "tool_calls" },
      ],
    ]);

    const session = new ChatSession({
      llm,
      model: "m",
      tools: [bashTool],
      builtinTools: { ask_user: { resolver } },
    });

    let caught: unknown = null;
    try {
      for await (const _ of session.send("do two things")) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    expect(isAskUserPending(caught)).toBe(true);

    // The sibling tool MUST NOT have been executed (we bailed first).
    expect(bashCalled).toBe(false);

    // BUT history must have a tool message for it anyway, paired with
    // the assistant's tool_call id, so provider validation is happy.
    const history = session.history();
    const siblingTool = history.find(
      (m) => m.role === "tool" && m.toolCallId === "bash_1",
    );
    expect(siblingTool).toBeDefined();
    expect(siblingTool?.content).toMatch(/skipped.*prior ask_user pending/);
  });

  it("goal-mode auto-reply constant is the canned 'no human' string", () => {
    expect(ASK_USER_GOAL_AUTO_REPLY).toMatch(/no human available/);
    expect(ASK_USER_GOAL_AUTO_REPLY).toMatch(/proceed/);
  });

  it("goal-mode resolver returns the canned reply and the round continues", async () => {
    // Simulates how the goal runner wires the tool: resolver returns the
    // canned constant synchronously, so the model unblocks instead of
    // hanging on a paused round.
    const resolver: AskUserResolver = async () => ASK_USER_GOAL_AUTO_REPLY;
    const llm = new ScriptedLLM([
      [
        { type: "tool-call", id: "ask_1", name: "ask_user", argsDelta: '{"question":"clarify?"}' },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        { type: "text", delta: "Proceeding with assumption: X." },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      model: "m",
      tools: [],
      builtinTools: { ask_user: { resolver } },
    });
    const events = await collect(session.send("vague goal"));
    expect(events.at(-1)?.type).toBe("done");
    const toolResult = events.find((e) => e.type === "tool-result") as Extract<
      ChatEvent,
      { type: "tool-result" }
    >;
    expect(toolResult.content).toBe(ASK_USER_GOAL_AUTO_REPLY);
  });

  it("isAskUserPending detects cross-bundle instances by name", () => {
    // Simulates the dual-package hazard: an AskUserPending built from a
    // different module copy won't pass `instanceof`, but the name check
    // catches it. (Build a plain object that just sets name + props.)
    const fake = Object.assign(new Error("ask_user pending: hi"), {
      name: "AskUserPending",
      question: "hi",
      callId: "x",
    });
    expect(isAskUserPending(fake)).toBe(true);

    // Sanity: arbitrary errors don't match.
    expect(isAskUserPending(new Error("nope"))).toBe(false);
    expect(isAskUserPending("oops")).toBe(false);
    expect(isAskUserPending(null)).toBe(false);
  });

  it("does NOT register the tool when builtinTools.ask_user is omitted", () => {
    const llm = new ScriptedLLM([[{ type: "done", finishReason: "stop" }]]);
    const session = new ChatSession({ llm, model: "m", tools: [] });
    // No public listTools() — but send() round 1 with no tools advertised
    // is the externally observable consequence. We just confirm the
    // session constructs without throwing and runs a no-op turn.
    return collect(session.send("hi")).then((events) => {
      expect(events.at(-1)?.type).toBe("done");
      expect(llm.requests[0].tools ?? []).toEqual([]);
    });
  });
});
