/**
 * Unit tests for `ScopedChatSessionStore` (T1-C).
 *
 * We use a scripted-LLM `ChatSession` so we never hit a real provider, and
 * exercise:
 *   - scope-disjoint storage (global / project / effort)
 *   - lazy re-hydration: a fresh store reads a previous run's jsonl
 *   - LRU eviction (process-side; the on-disk file remains)
 *   - drop wipes both cache + disk + index
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  ScopedChatSessionStore,
  scopeDir,
  scopeKey,
  type ChatScope,
  type ScopedChatSessionFactory,
} from "./store.js";
import { ChatSession } from "./session.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/llm.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-chat-test-"));
});

/** Scripted LLM that replies "ack:<msg>" deterministically. */
function scriptedLlm(): LLMProvider {
  return {
    async describe() {
      return { name: "scripted" };
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const reply = `ack:${last?.content ?? ""}`;
      return {
        async *stream() {
          yield { type: "text", delta: reply };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

const makeFactory = (): ScopedChatSessionFactory =>
  ({ model }) =>
    new ChatSession({ llm: scriptedLlm(), model: model ?? "scripted", systemPrompt: "SYS" });

async function send(store: ScopedChatSessionStore, scope: ChatScope, cid: string, msg: string): Promise<void> {
  const session = await store.getOrCreate(scope, cid, undefined);
  for await (const _ of session.send(msg)) {
    /* drain */
  }
  await store.flush(scope, cid);
}

describe("scopeDir + scopeKey", () => {
  it("global → .mathran/global-chat", () => {
    expect(scopeDir("/ws", { kind: "global" })).toBe(path.join("/ws", ".mathran", "global-chat"));
    expect(scopeKey({ kind: "global" })).toBe("global");
  });
  it("project → projects/<slug>/chat", () => {
    expect(scopeDir("/ws", { kind: "project", projectSlug: "p" })).toBe(
      path.join("/ws", "projects", "p", "chat"),
    );
    expect(scopeKey({ kind: "project", projectSlug: "p" })).toBe("project:p");
  });
  it("effort → projects/<slug>/efforts/<eff>/chat", () => {
    expect(scopeDir("/ws", { kind: "effort", projectSlug: "p", effortSlug: "e" })).toBe(
      path.join("/ws", "projects", "p", "efforts", "e", "chat"),
    );
    expect(scopeKey({ kind: "effort", projectSlug: "p", effortSlug: "e" })).toBe("effort:p/e");
  });
  it("project scope without slug throws", () => {
    expect(() => scopeDir("/ws", { kind: "project" })).toThrow();
  });
});

describe("ScopedChatSessionStore", () => {
  it("persists messages to disk after flush", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    await send(store, { kind: "global" }, "c1", "hello");
    const file = path.join(workspace, ".mathran", "global-chat", "c1.jsonl");
    const onDisk = await fs.readFile(file, "utf-8");
    expect(onDisk).toContain("hello");
    expect(onDisk).toContain("ack:hello");
  });

  it("lazy-rehydrates from disk on a fresh store instance", async () => {
    // First instance writes
    const a = new ScopedChatSessionStore(workspace, makeFactory());
    await send(a, { kind: "global" }, "c1", "round-1");

    // Fresh instance — nothing in memory, but disk has the conversation.
    const b = new ScopedChatSessionStore(workspace, makeFactory());
    const conversations = await b.listConversations({ kind: "global" });
    expect(conversations.map((c) => c.id)).toContain("c1");

    // Second turn: history should include round-1 since we rehydrated.
    const session = await b.getOrCreate({ kind: "global" }, "c1", undefined);
    expect(session.history().some((m) => m.content === "round-1")).toBe(true);

    await send(b, { kind: "global" }, "c1", "round-2");
    const final = await b.readHistory({ kind: "global" }, "c1");
    const userMessages = final!.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(2);
  });

  it("keeps scope storage independent (global / project / effort)", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    await send(store, { kind: "global" }, "x", "g-msg");
    await send(store, { kind: "project", projectSlug: "p" }, "x", "p-msg");
    await send(store, { kind: "effort", projectSlug: "p", effortSlug: "e" }, "x", "e-msg");

    const g = await store.readHistory({ kind: "global" }, "x");
    const p = await store.readHistory({ kind: "project", projectSlug: "p" }, "x");
    const e = await store.readHistory({ kind: "effort", projectSlug: "p", effortSlug: "e" }, "x");

    expect(g!.some((m) => m.content === "g-msg")).toBe(true);
    expect(p!.some((m) => m.content === "p-msg")).toBe(true);
    expect(e!.some((m) => m.content === "e-msg")).toBe(true);
    // Cross-scope leaks would show up here:
    expect(g!.some((m) => m.content === "p-msg")).toBe(false);
    expect(p!.some((m) => m.content === "g-msg")).toBe(false);
    expect(e!.some((m) => m.content === "p-msg")).toBe(false);
  });

  it("drop removes cache + disk file + index entry", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    await send(store, { kind: "global" }, "doomed", "bye");
    const file = path.join(workspace, ".mathran", "global-chat", "doomed.jsonl");
    expect(await fs.stat(file)).toBeTruthy();

    expect(await store.drop({ kind: "global" }, "doomed")).toBe(true);
    await expect(fs.stat(file)).rejects.toThrow();
    expect(await store.readHistory({ kind: "global" }, "doomed")).toBeNull();
    const list = await store.listConversations({ kind: "global" });
    expect(list.map((c) => c.id)).not.toContain("doomed");
  });

  it("evicts LRU when maxEntries is exceeded (disk file survives)", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory(), 2);
    await send(store, { kind: "global" }, "a", "a");
    await send(store, { kind: "global" }, "b", "b");
    await send(store, { kind: "global" }, "c", "c"); // evicts "a" from cache

    // All three still on disk and listable.
    const list = await store.listConversations({ kind: "global" });
    expect(list.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    // Re-reading "a" works (rehydrated from disk).
    const reHist = await store.readHistory({ kind: "global" }, "a");
    expect(reHist!.some((m) => m.content === "a")).toBe(true);
  });

  it("first user message becomes the conversation title in the index", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    await send(store, { kind: "global" }, "c1", "What is twin primes?");
    const list = await store.listConversations({ kind: "global" });
    expect(list[0].title).toBe("What is twin primes?");
  });
});
