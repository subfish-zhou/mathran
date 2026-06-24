/**
 * Tests for `cancelOrphanPendingAsk` (TODO-3).
 *
 * Symptom we're fixing: a chat round emits `ask_user`; the SPA persists
 * a `pendingAsk` annotation + a placeholder tool-message in history;
 * the user sends a new chat message instead of POSTing /answer-ask. The
 * cleanup helper patches the placeholder with a JSON cancellation
 * payload, clears the sidecar slot, and cancels any pending auto-
 * resolve timer. These tests exercise that contract directly without
 * standing up a real LLM provider.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  ScopedChatSessionStore,
  loadAnnotations,
  saveAnnotations,
  type ChatScope,
  type ScopedChatSessionFactory,
} from "../core/chat/store.js";
import { ChatSession } from "../core/chat/session.js";
import { ASK_USER_PENDING_PLACEHOLDER } from "../core/chat/index.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../core/providers/llm.js";
import type { LLMMessage } from "../core/providers/llm.js";

import { cancelOrphanPendingAsk } from "./serve.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "mathran-cancel-orphan-pendingask-"),
  );
});

/** Trivial scripted LLM (we never actually invoke it in these tests). */
function scriptedLlm(): LLMProvider {
  return {
    async describe() {
      return { name: "scripted" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream() {
          yield { type: "text", delta: "noop" };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

const factory: ScopedChatSessionFactory = ({ model }) =>
  new ChatSession({
    llm: scriptedLlm(),
    model: model ?? "scripted",
    systemPrompt: "SYS",
  });

const scope: ChatScope = { kind: "global" };

/**
 * Stuff a chat session's history with a stand-in `ask_user` round:
 * user → assistant w/ tool-call → tool placeholder. Same shape the real
 * `session.send` produces when it throws `AskUserPending`.
 */
function seedHistoryWithPendingAsk(
  session: ChatSession,
  callId: string,
): LLMMessage[] {
  const history: LLMMessage[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "please help me decide between A and B" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: callId,
          name: "ask_user",
          arguments: { question: "Pick A or B?", options: ["A", "B"] },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: callId,
      name: "ask_user",
      content: ASK_USER_PENDING_PLACEHOLDER,
    },
  ];
  session.replaceHistory(history);
  return history;
}

describe("cancelOrphanPendingAsk", () => {
  it("patches the placeholder + clears sidecar when a pendingAsk is present", async () => {
    const store = new ScopedChatSessionStore(workspace, factory);
    const conversationId = "c-orphan-1";
    const session = await store.getOrCreate(scope, conversationId, undefined);
    const callId = "call_orphan_test_1";
    seedHistoryWithPendingAsk(session, callId);

    // Write a pendingAsk sidecar slot the way the real ask_user handler does.
    // NOTE: loadAnnotations requires the top-level `byBubbleIdx` field to be
    // present before it parses any sibling slots (defensive shape gate); the
    // real save paths always include it, so do the same here.
    await saveAnnotations(workspace, scope, conversationId, {
      version: 1,
      byBubbleIdx: {},
      pendingAsk: {
        question: "Pick A or B?",
        callId,
        toolCallId: callId,
        ts: Date.now(),
        options: ["A", "B"],
      },
    });

    const reason = "user sent a new message instead of answering";
    const ok = await cancelOrphanPendingAsk({
      store,
      scope,
      conversationId,
      session,
      reason,
    });
    expect(ok).toBe(true);

    // Placeholder should now be a JSON cancellation payload.
    const history = session.history();
    const placeholderMsg = history.find(
      (m) => m.role === "tool" && m.toolCallId === callId,
    );
    expect(placeholderMsg).toBeDefined();
    expect(placeholderMsg!.content).not.toBe(ASK_USER_PENDING_PLACEHOLDER);
    const parsed = JSON.parse(placeholderMsg!.content as string);
    expect(parsed.cancelled).toBe(true);
    expect(parsed.reason).toBe(reason);
    expect(parsed.callId).toBe(callId);
    expect(typeof parsed.cancelledAt).toBe("string");

    // Sidecar should no longer carry a pendingAsk slot.
    const sidecar = await loadAnnotations(workspace, scope, conversationId);
    expect(sidecar.pendingAsk).toBeUndefined();
  });

  it("is a no-op when there is no pendingAsk slot", async () => {
    const store = new ScopedChatSessionStore(workspace, factory);
    const conversationId = "c-orphan-2";
    const session = await store.getOrCreate(scope, conversationId, undefined);
    // Plain history, no ask_user.
    session.replaceHistory([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    const ok = await cancelOrphanPendingAsk({
      store,
      scope,
      conversationId,
      session,
      reason: "x",
    });
    expect(ok).toBe(false);
  });

  it("clears the sidecar even when the placeholder is no longer in history", async () => {
    // Simulate a race: sidecar still has pendingAsk but the round was
    // truncated under us so the placeholder is gone. Helper must still
    // wipe the dangling sidecar slot.
    const store = new ScopedChatSessionStore(workspace, factory);
    const conversationId = "c-orphan-3";
    const session = await store.getOrCreate(scope, conversationId, undefined);
    session.replaceHistory([
      { role: "system", content: "SYS" },
      { role: "user", content: "no tool calls here" },
      { role: "assistant", content: "ok" },
    ]);

    const callId = "call_orphan_test_3";
    await saveAnnotations(workspace, scope, conversationId, {
      version: 1,
      byBubbleIdx: {},
      pendingAsk: {
        question: "stale?",
        callId,
        toolCallId: callId,
        ts: Date.now(),
      },
    });

    const ok = await cancelOrphanPendingAsk({
      store,
      scope,
      conversationId,
      session,
      reason: "rewound",
    });
    expect(ok).toBe(true);

    const sidecar = await loadAnnotations(workspace, scope, conversationId);
    expect(sidecar.pendingAsk).toBeUndefined();
  });

  it("matches on toolCallId — only the matching placeholder is patched", async () => {
    const store = new ScopedChatSessionStore(workspace, factory);
    const conversationId = "c-orphan-4";
    const session = await store.getOrCreate(scope, conversationId, undefined);

    // Two placeholders, only the second matches the sidecar's callId.
    const callA = "call_orphan_A";
    const callB = "call_orphan_B";
    session.replaceHistory([
      { role: "system", content: "SYS" },
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: callA, name: "ask_user", arguments: { question: "?A" } }],
      },
      {
        role: "tool",
        toolCallId: callA,
        name: "ask_user",
        content: "already answered: A1",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: callB, name: "ask_user", arguments: { question: "?B" } }],
      },
      {
        role: "tool",
        toolCallId: callB,
        name: "ask_user",
        content: ASK_USER_PENDING_PLACEHOLDER,
      },
    ]);

    await saveAnnotations(workspace, scope, conversationId, {
      version: 1,
      byBubbleIdx: {},
      pendingAsk: {
        question: "?B",
        callId: callB,
        toolCallId: callB,
        ts: Date.now(),
      },
    });

    const ok = await cancelOrphanPendingAsk({
      store,
      scope,
      conversationId,
      session,
      reason: "supersede",
    });
    expect(ok).toBe(true);

    const history = session.history();
    const slotA = history.find(
      (m) => m.role === "tool" && m.toolCallId === callA,
    );
    const slotB = history.find(
      (m) => m.role === "tool" && m.toolCallId === callB,
    );
    // Slot A is untouched (it's not the placeholder + not the pending callId).
    expect(slotA!.content).toBe("already answered: A1");
    // Slot B is the cancellation payload.
    expect(slotB!.content).not.toBe(ASK_USER_PENDING_PLACEHOLDER);
    const parsed = JSON.parse(slotB!.content as string);
    expect(parsed.cancelled).toBe(true);
    expect(parsed.callId).toBe(callB);
  });
});
