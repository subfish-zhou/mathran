/**
 * Tests for the 2026-06-30 plan-tracker bug fix — ChatSession injects a
 * transient TODO reminder before each LLM request and removes it
 * before recording the assistant turn so it doesn't bloat history.
 *
 * Bug context: prior to this fix, the LLM wrote a plan via `todo_write`
 * once and then forgot to update statuses across the rest of the
 * conversation (audited 2026-06-30 on alpha user: 1+ hour of subsequent
 * activity, plan stuck with one in_progress item).
 */

import { describe, it, expect } from "vitest";
import { ChatSession, type ChatEvent } from "./session.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  LLMMessage,
} from "../providers/llm.js";
import type { TodoList } from "./tools/todo-write.js";

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
  async describe() {
    return { name: "scripted" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    // Deep-snapshot the request so later mutations to `this.messages`
    // can't retroactively pollute what we assert on.
    this.requests.push({
      ...req,
      messages: req.messages.map((m) => ({ ...m })),
    });
    const turn = this.turns[this.i] ?? [{ type: "done", finishReason: "stop" }];
    this.i += 1;
    return responseOf(turn);
  }
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function listOf(
  items: Array<{ text: string; status: TodoList["items"][number]["status"] }>,
): TodoList {
  const now = new Date().toISOString();
  return {
    version: 1,
    updatedAt: now,
    items: items.map((it, i) => ({
      id: `id-${i}`,
      text: it.text,
      status: it.status,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

function findSystemReminder(req: LLMRequest): LLMMessage | undefined {
  return req.messages.find(
    (m) =>
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.includes("Current TODO list"),
  );
}

describe("ChatSession todoSnapshot injection (plan-tracker bug fix)", () => {
  it("injects a TODO reminder into the LLM request when the snapshot has live items", async () => {
    const list = listOf([
      { text: "step A", status: "in_progress" },
      { text: "step B", status: "pending" },
    ]);
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "ok" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      todoSnapshot: async () => list,
    });
    await collect(session.send("hello"));

    expect(llm.requests).toHaveLength(1);
    const reminder = findSystemReminder(llm.requests[0]);
    expect(reminder).toBeDefined();
    expect(String(reminder!.content)).toContain("step A");
    expect(String(reminder!.content)).toContain("step B");
    expect(String(reminder!.content)).toContain("[in_progress]");
  });

  it("does NOT inject a reminder when every todo is done", async () => {
    const list = listOf([
      { text: "done step", status: "done" },
    ]);
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "ok" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      todoSnapshot: async () => list,
    });
    await collect(session.send("hello"));
    expect(findSystemReminder(llm.requests[0])).toBeUndefined();
  });

  it("does NOT inject a reminder when the snapshot is null", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "ok" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      todoSnapshot: async () => null,
    });
    await collect(session.send("hello"));
    expect(findSystemReminder(llm.requests[0])).toBeUndefined();
  });

  it("does NOT persist the reminder into ChatSession history after the round", async () => {
    const list = listOf([{ text: "step A", status: "in_progress" }]);
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "ok" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      todoSnapshot: async () => list,
    });
    await collect(session.send("hello"));

    const persisted = session.history();
    // The persisted messages should be {user "hello"} + {assistant "ok"} only.
    // No leftover system reminder.
    const reminderInHistory = persisted.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("Current TODO list"),
    );
    expect(reminderInHistory).toBeUndefined();
  });

  it("re-injects a fresh snapshot on every round (no leak across multi-round turns)", async () => {
    // Two snapshots in sequence: first round sees `A` in_progress, second
    // round sees `A` done + `B` in_progress. We use a counter the snapshot
    // closure reads to simulate the model having updated the plan between
    // rounds.
    const states: TodoList[] = [
      listOf([
        { text: "A", status: "in_progress" },
        { text: "B", status: "pending" },
      ]),
      listOf([
        { text: "A", status: "done" },
        { text: "B", status: "in_progress" },
      ]),
    ];
    let snapIdx = 0;
    // First turn: assistant calls a tool, second turn: assistant just replies.
    // The tool round-trip forces a second LLM call within the same `send()`.
    const llm = new ScriptedLLM([
      [
        // Round 1 — call a dummy tool so the runner loops back for round 2.
        {
          type: "tool-call",
          id: "c1",
          name: "noop",
          argsDelta: "{}",
        },
        { type: "done", finishReason: "tool_calls" },
      ],
      [
        // Round 2 — plain text, finish.
        { type: "text", delta: "ok" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      todoSnapshot: async () => states[snapIdx++] ?? null,
      tools: [
        {
          name: "noop",
          description: "",
          parameters: { type: "object", properties: {} },
          riskClass: "read",
          readOnly: true,
          async execute() {
            return { ok: true, content: "noop" };
          },
        },
      ],
    });
    await collect(session.send("hello"));

    expect(llm.requests).toHaveLength(2);

    // Round 1 reminder mentions A in_progress.
    const r1 = findSystemReminder(llm.requests[0])!;
    expect(r1).toBeDefined();
    expect(String(r1.content)).toContain("[in_progress]");
    expect(String(r1.content)).toMatch(/\[in_progress\][^\n]*A/);

    // Round 2 reminder shows A done, B in_progress — i.e. the snapshot
    // was re-loaded for the second round. If we had leaked round 1's
    // reminder into history, round 2 would see TWO reminders; this
    // also asserts there's exactly one.
    const allRemindersR2 = llm.requests[1].messages.filter(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("Current TODO list"),
    );
    expect(allRemindersR2).toHaveLength(1);
    const r2text = String(allRemindersR2[0].content);
    expect(r2text).toContain("[done]");
    expect(r2text).toMatch(/\[done\][^\n]*A/);
    expect(r2text).toMatch(/\[in_progress\][^\n]*B/);
  });

  it("survives a throwing snapshot supplier (turn still completes)", async () => {
    const llm = new ScriptedLLM([
      [
        { type: "text", delta: "ok" },
        { type: "done", finishReason: "stop" },
      ],
    ]);
    const session = new ChatSession({
      llm,
      todoSnapshot: async () => {
        throw new Error("disk go boom");
      },
    });
    const events = await collect(session.send("hello"));
    // Turn finished normally.
    expect(events.some((e) => e.type === "done")).toBe(true);
    // No reminder injected.
    expect(findSystemReminder(llm.requests[0])).toBeUndefined();
  });
});
