/**
 * v0.17 mathub parity W9 — server-side contract tests for Live Steering.
 *
 * Live Steering lets the user POST a free-form `text` to
 * `POST <chatBase>/:cid/steer` (or `POST /api/goals/:id/steer`) while
 * an SSE stream is in flight. The runner consumes the queued text at
 * the next round boundary inside `ChatSession.runRounds`, injects it
 * as a synthetic `[Steer from user: …]` user message, and yields a
 * `{ type: "steer-received" }` SSE frame so the SPA can dismiss its
 * "queued" toast.
 *
 * The contract under test (per the task spec):
 *
 *   1. POST steer while a stream is in flight → 200 + queued; the
 *      runner reads + clears the pending text and emits one
 *      `steer-received` SSE frame whose `text` echoes the steer.
 *   2. POST steer with no in-flight stream → 409 (the steer would
 *      never be read).
 *   3. The `[Steer from user: …]` envelope is what the runner pushes
 *      into history.
 *
 * Design notes:
 *
 *   - `ChatSession.runRounds` only re-enters its main loop when the
 *     prior round emitted tool calls (no-tool = `done` after one
 *     round). To exercise the round-boundary probe deterministically,
 *     the fake LLM in this test emits exactly one tool call in its
 *     first invocation; the runner executes the tool (a no-op
 *     `echo` builtin we register on the session), comes back for
 *     round 2, and at the TOP of round 2 the probe fires.
 *
 *   - We POST the steer BETWEEN the round-1 tool result and the
 *     round-2 LLM call. Gating the second LLM invocation gives us a
 *     deterministic window: the gate is set right after the tool
 *     result lands and before round-2's `llm.chat()` runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer } from "./serve.js";
import { ChatSession, type ToolSpec } from "../core/chat/session.js";
import {
  clearAllForTests,
  consumePendingSteer,
  hasActiveStream,
  hasPendingSteer,
  markStreamActive,
  setPendingSteer,
} from "./steer-registry.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../core/providers/llm.js";

/**
 * Fake LLM that:
 *   - Round 0 (first chat call): emits one `tool_use` for a no-op
 *     `echo` tool, then `done` with `finishReason: "tool_calls"`.
 *   - Round 1+ (subsequent calls): waits on a per-call gate (so the
 *     test has a deterministic window to POST the steer), then
 *     emits a text reply and `done`.
 *
 * Each `chat()` call gets a fresh gate; the test releases it via
 * `release()`. `awaitGated()` resolves once the LLM has reached its
 * gate (i.e. round-2's `llm.chat()` is mid-stream).
 */
interface GatedLlm extends LLMProvider {
  release: () => void;
  awaitGated: () => Promise<void>;
  calls: number;
}

function gatedToolLlm(): GatedLlm {
  let calls = 0;
  let release: (() => void) | null = null;
  let gateReached: (() => void) | null = null;
  let gatedPromise: Promise<void> = new Promise<void>((r) => {
    gateReached = r;
  });

  const llm: GatedLlm = {
    calls: 0,
    release() {
      const r = release;
      release = null;
      if (r) r();
    },
    async awaitGated() {
      await gatedPromise;
      gatedPromise = new Promise<void>((r) => {
        gateReached = r;
      });
    },
    async describe() {
      return { name: "fake-steer-gated" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      const idx = calls;
      calls++;
      llm.calls = calls;
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          if (idx === 0) {
            // Round 0: emit a token so the stream is clearly open from
            // the SPA's perspective, signal the gate (so the test knows
            // the stream is mid-round), then suspend. The test POSTs
            // its steer in this window, then releases the gate. After
            // release we emit a tool call so the runner loops to round 1.
            yield { type: "text", delta: "round-0-preamble" };
            const reached = gateReached;
            gateReached = null;
            if (reached) reached();
            await new Promise<void>((r) => {
              release = r;
            });
            yield {
              type: "tool-call",
              id: "call_0",
              name: "echo",
              argsDelta: JSON.stringify({ text: "hi" }),
            };
            yield { type: "done", finishReason: "tool_calls" };
            return;
          }
          // Round 1+: emit text + done immediately. The probe ran BEFORE
          // this chat() was invoked (at the top of round 1, before
          // `llm.chat()`), so by the time we get here the steer is
          // already consumed and `steer-received` is already in the SSE
          // stream.
          yield { type: "text", delta: idx === 1 ? "round-1-text" : "extra" };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
  return llm;
}

/** A no-op echo tool for forcing a tool roundtrip in round 0. */
function makeEchoTool(): ToolSpec {
  return {
    name: "echo",
    description: "Echo input text back as a tool result.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
      const text = typeof args?.text === "string" ? args.text : "";
      return { ok: true, content: `echoed:${text}` };
    },
  };
}

describe("steer-registry (in-memory bookkeeping)", () => {
  beforeEach(() => clearAllForTests());

  it("setPendingSteer overwrites (last-write-wins) and consumePendingSteer clears", () => {
    expect(hasPendingSteer("c-1")).toBe(false);
    setPendingSteer("c-1", "first");
    setPendingSteer("c-1", "second");
    expect(hasPendingSteer("c-1")).toBe(true);
    expect(consumePendingSteer("c-1")).toBe("second");
    expect(consumePendingSteer("c-1")).toBeNull();
    expect(hasPendingSteer("c-1")).toBe(false);
  });

  it("empty / nullish text clears the slot rather than queueing", () => {
    setPendingSteer("c-2", "real");
    setPendingSteer("c-2", "");
    expect(hasPendingSteer("c-2")).toBe(false);
    setPendingSteer("c-2", "real");
    setPendingSteer("c-2", null);
    expect(hasPendingSteer("c-2")).toBe(false);
  });

  it("markStreamActive is ref-counted; final release clears pending", () => {
    const r1 = markStreamActive("c-3");
    const r2 = markStreamActive("c-3");
    setPendingSteer("c-3", "queued");
    expect(hasActiveStream("c-3")).toBe(true);
    r1();
    expect(hasActiveStream("c-3")).toBe(true);
    expect(hasPendingSteer("c-3")).toBe(true);
    r2();
    expect(hasActiveStream("c-3")).toBe(false);
    expect(hasPendingSteer("c-3")).toBe(false);
  });
});

describe("POST <chatBase>/:cid/steer — wire contract", () => {
  let workspace: string;
  let server: { url: string; close: () => Promise<void> };
  let base: string;
  let llm: GatedLlm;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-steer-"));
    llm = gatedToolLlm();
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      // Drive all chat scopes with our gated LLM. We pre-register the
      // `echo` tool so round 0's tool call resolves; subsequent rounds
      // see the same tool list.
      chatSessionFactory: ({ model }) =>
        new ChatSession({
          llm,
          model: model ?? "fake",
          tools: [makeEchoTool()],
        }),
    });
    base = server.url;
  });

  afterAll(async () => {
    await server.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearAllForTests();
    llm.calls = 0;
  });

  it("returns 409 when no in-flight stream is registered", async () => {
    const res = await fetch(`${base}/api/global-chat/c-does-not-exist/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "nudge" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/no in-flight/i);
  });

  it("rejects empty text with 400 even when stream is active", async () => {
    const release = markStreamActive("c-empty-text");
    try {
      const res = await fetch(`${base}/api/global-chat/c-empty-text/steer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      });
      expect(res.status).toBe(400);
    } finally {
      release();
    }
  });

  it("queued steer is consumed at next round-top, emits steer-received SSE frame", async () => {
    // Open the chat stream. Round 0 emits a token and gates; the test
    // captures the conversationId from the `session` frame, then POSTs
    // its steer. With the gate held, the steer is guaranteed to land
    // in the registry BEFORE the runner loops to round 1.
    const sendPromise = fetch(`${base}/api/global-chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "kick off" }),
    });
    const res = await sendPromise;
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let conversationId = "";
    while (!conversationId) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = buf.match(/event: session\ndata: ({[^\n]+})\n\n/);
      if (m) conversationId = JSON.parse(m[1]!).conversationId;
    }
    expect(conversationId).toMatch(/^c-/);

    // Wait for round-0 to reach its gate — the stream is now
    // demonstrably mid-flight (and the active-stream slot is
    // registered).
    await llm.awaitGated();
    expect(hasActiveStream(conversationId)).toBe(true);

    // POST the steer. The registry holds it; round 1 will consume it.
    const steerRes = await fetch(
      `${base}/api/global-chat/${encodeURIComponent(conversationId)}/steer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "focus on edge cases please" }),
      },
    );
    expect(steerRes.status).toBe(200);
    expect(await steerRes.json()).toMatchObject({ ok: true, queued: true, conversationId });
    expect(hasPendingSteer(conversationId)).toBe(true);

    // Release round-0's gate so the runner emits the tool call, runs
    // `echo`, loops to round 1, probes (yielding steer-received), and
    // calls round-1's `chat()` which now returns immediately.
    llm.release();

    // Drain remaining frames.
    let drained = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      drained += dec.decode(value, { stream: true });
    }
    const allFrames = buf + drained;
    const frames: Array<{ event: string; data: any }> = [];
    for (const block of allFrames.split("\n\n")) {
      if (!block.trim()) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      try {
        frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
      } catch {
        /* trailing */
      }
    }

    // Contract: exactly one `steer-received` frame, carrying the
    // text we POSTed.
    const steerFrames = frames.filter((f) => f.event === "steer-received");
    expect(steerFrames.length).toBe(1);
    expect(steerFrames[0]!.data).toMatchObject({
      type: "steer-received",
      text: "focus on edge cases please",
    });

    // Order: steer-received lands AFTER the round-0 tool-result and
    // BEFORE round-1's text deltas (the probe runs at round-1 top,
    // before `llm.chat()` for round 1).
    const toolResultIdx = frames.findIndex((f) => f.event === "tool-result");
    const steerIdx = frames.findIndex((f) => f.event === "steer-received");
    const round1TextIdx = frames.findIndex(
      (f) => f.event === "text" && f.data.delta === "round-1-text",
    );
    expect(toolResultIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeGreaterThan(toolResultIdx);
    if (round1TextIdx !== -1) {
      expect(steerIdx).toBeLessThan(round1TextIdx);
    }

    // Registry: consume-on-read drained the pending text; the
    // active-stream slot was released in the route's `finally`.
    expect(hasPendingSteer(conversationId)).toBe(false);
    expect(hasActiveStream(conversationId)).toBe(false);

    // History: the synthetic `[Steer from user: …]` user message is
    // persisted between round 0's assistant reply (the tool call)
    // and round 1's assistant reply.
    const histRes = await fetch(
      `${base}/api/global-chat/${encodeURIComponent(conversationId)}`,
    );
    expect(histRes.status).toBe(200);
    const histBody = await histRes.json();
    const allMsgs = histBody.history as Array<{ role: string; content: any }>;
    const steerMsg = allMsgs.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[Steer from user:"),
    );
    expect(steerMsg).toBeTruthy();
    expect(steerMsg!.content).toContain("focus on edge cases please");
  }, 30_000);
});
