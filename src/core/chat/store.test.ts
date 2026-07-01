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

  it("writes a Markdown transcript next to the jsonl on flush (GAP #13)", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    const scope: ChatScope = {
      kind: "effort",
      projectSlug: "twin-primes",
      effortSlug: "sieve",
    };
    await send(store, scope, "abc123", "is 3 a twin prime?");

    const transcript = path.join(
      workspace,
      "projects",
      "twin-primes",
      "efforts",
      "sieve",
      "chat",
      "transcripts",
      "abc123.md",
    );
    const md = await fs.readFile(transcript, "utf-8");
    expect(md).toContain("# is 3 a twin prime?");
    expect(md).toContain("**Scope:** effort / twin-primes / sieve");
    expect(md).toContain("## user");
    expect(md).toContain("is 3 a twin prime?");
    expect(md).toContain("## assistant");
    expect(md).toContain("ack:is 3 a twin prime?");
  });

  it("transcript is rewritten end-to-end on every flush", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    const scope: ChatScope = { kind: "global" };
    await send(store, scope, "c1", "first turn");
    await send(store, scope, "c1", "second turn");

    const md = await fs.readFile(
      path.join(workspace, ".mathran", "global-chat", "transcripts", "c1.md"),
      "utf-8",
    );
    expect(md).toContain("first turn");
    expect(md).toContain("second turn");
    expect(md).toContain("ack:first turn");
    expect(md).toContain("ack:second turn");
  });

  // 2026-07-01 — setTitle rename API
  describe("setTitle (2026-07-01)", () => {
    it("renames an existing conversation", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hello");
      const res = await store.setTitle({ kind: "global" }, "c1", "My Custom Title");
      expect(res).toEqual({ ok: true });
      const convs = await store.listConversations({ kind: "global" });
      const found = convs.find((c) => c.id === "c1");
      expect(found?.title).toBe("My Custom Title");
    });

    it("trims whitespace from the new title", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hello");
      await store.setTitle({ kind: "global" }, "c1", "   Spaces Around   ");
      const convs = await store.listConversations({ kind: "global" });
      expect(convs.find((c) => c.id === "c1")?.title).toBe("Spaces Around");
    });

    it("rejects empty titles", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hello");
      const res = await store.setTitle({ kind: "global" }, "c1", "   ");
      expect(res).toEqual({ ok: false, reason: "invalid" });
    });

    it("rejects overly long titles (>200 chars)", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hello");
      const res = await store.setTitle({ kind: "global" }, "c1", "x".repeat(201));
      expect(res).toEqual({ ok: false, reason: "invalid" });
    });

    it("returns not-found for missing conversation", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      const res = await store.setTitle({ kind: "global" }, "nope", "New Title");
      expect(res).toEqual({ ok: false, reason: "not-found" });
    });

    it("rename persists across a fresh store instance", async () => {
      const a = new ScopedChatSessionStore(workspace, makeFactory());
      await send(a, { kind: "global" }, "c1", "hello");
      await a.setTitle({ kind: "global" }, "c1", "Persisted Title");
      // Fresh instance — must see the renamed title.
      const b = new ScopedChatSessionStore(workspace, makeFactory());
      const convs = await b.listConversations({ kind: "global" });
      expect(convs.find((c) => c.id === "c1")?.title).toBe("Persisted Title");
    });

    it("subsequent flush does NOT overwrite the user's chosen title", async () => {
      // Verifies the existing 'existing?.title ?? …' precedence in
      // flushConversationHistory: once user renames, further LLM turns
      // keep the user's chosen title (not the auto-derived one).
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hello");
      await store.setTitle({ kind: "global" }, "c1", "User Chose This");
      // Add more messages — internally triggers another flush.
      await send(store, { kind: "global" }, "c1", "another turn");
      const convs = await store.listConversations({ kind: "global" });
      expect(convs.find((c) => c.id === "c1")?.title).toBe("User Chose This");
    });
  });

  // 2026-07-01 (D) — editAssistantMessageFromEnd for render-fix persistence
  describe("editAssistantMessageFromEnd (2026-07-01)", () => {
    it("rewrites the last assistant message on disk", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hi");
      const res = await store.editAssistantMessageFromEnd(
        { kind: "global" }, "c1", 1, "REWRITTEN",
      );
      expect(res).toEqual({ ok: true });
      const history = await store.readHistory({ kind: "global" }, "c1");
      const last = history![history!.length - 1];
      expect(last.role).toBe("assistant");
      expect(last.content).toBe("REWRITTEN");
    });

    it("evicts the in-memory cache so next getOrCreate re-reads disk", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hi");
      await store.editAssistantMessageFromEnd(
        { kind: "global" }, "c1", 1, "PATCHED VERSION",
      );
      // Fresh getOrCreate: should see PATCHED VERSION, not "ack:hi".
      const session = await store.getOrCreate({ kind: "global" }, "c1", undefined);
      const last = session.history()[session.history().length - 1];
      expect(last.content).toBe("PATCHED VERSION");
    });

    it("rejects editing a user message", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hi");
      // The 2nd-from-end message is the user prompt "hi".
      const res = await store.editAssistantMessageFromEnd(
        { kind: "global" }, "c1", 2, "shouldn't work",
      );
      expect(res).toEqual({ ok: false, reason: "not-assistant" });
    });

    it("returns not-found for missing conversation", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      const res = await store.editAssistantMessageFromEnd(
        { kind: "global" }, "nope", 1, "text",
      );
      expect(res).toEqual({ ok: false, reason: "not-found" });
    });

    it("returns no-message when offset is past history end", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hi");
      const res = await store.editAssistantMessageFromEnd(
        { kind: "global" }, "c1", 100, "text",
      );
      expect(res).toEqual({ ok: false, reason: "no-message" });
    });

    it("rejects invalid inputs", async () => {
      const store = new ScopedChatSessionStore(workspace, makeFactory());
      await send(store, { kind: "global" }, "c1", "hi");
      expect(await store.editAssistantMessageFromEnd({ kind: "global" }, "c1", 1, "")).toEqual({
        ok: false, reason: "invalid",
      });
      expect(await store.editAssistantMessageFromEnd({ kind: "global" }, "c1", 0, "text")).toEqual({
        ok: false, reason: "invalid",
      });
    });

    it("edit persists across a fresh store instance", async () => {
      const a = new ScopedChatSessionStore(workspace, makeFactory());
      await send(a, { kind: "global" }, "c1", "hi");
      await a.editAssistantMessageFromEnd({ kind: "global" }, "c1", 1, "PERSISTED");
      const b = new ScopedChatSessionStore(workspace, makeFactory());
      const history = await b.readHistory({ kind: "global" }, "c1");
      const last = history![history!.length - 1];
      expect(last.content).toBe("PERSISTED");
    });
  });
});

describe("ScopedChatSessionStore atomic flush (T3)", () => {
  it("flushSession writes the exact serialization atomically", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    await send(store, { kind: "global" }, "c1", "hello");

    const file = path.join(workspace, ".mathran", "global-chat", "c1.jsonl");
    const onDisk = await fs.readFile(file, "utf-8");

    const history = await store.readHistory({ kind: "global" }, "c1");
    const expected = history!.map((m) => JSON.stringify(m)).join("\n") + "\n";
    expect(onDisk).toBe(expected);

    // No stray temp files were left behind.
    const dirEntries = await fs.readdir(path.join(workspace, ".mathran", "global-chat"));
    expect(dirEntries.some((e) => e.includes(".tmp."))).toBe(false);
  });

  it("preserves previous file content when the write fails mid-flush", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    await send(store, { kind: "global" }, "c1", "first turn");

    const gdir = path.join(workspace, ".mathran", "global-chat");
    const file = path.join(gdir, "c1.jsonl");
    const before = await fs.readFile(file, "utf-8");

    // Queue a second turn, then make the chat dir read-only so the atomic
    // temp-file write fails and the rename never happens.
    const session = await store.getOrCreate({ kind: "global" }, "c1", undefined);
    for await (const _ of session.send("second turn")) {
      /* drain */
    }

    await fs.chmod(gdir, 0o555);
    try {
      await expect(store.flush({ kind: "global" }, "c1")).rejects.toThrow();
    } finally {
      await fs.chmod(gdir, 0o755);
    }

    // The original content survives — rename did not happen.
    const after = await fs.readFile(file, "utf-8");
    expect(after).toBe(before);

    const dirEntries = await fs.readdir(gdir);
    expect(dirEntries.some((e) => e.includes(".tmp."))).toBe(false);
  });
});

/**
 * Eviction race tests (v0.3 §20).
 *
 * The bug fixed by Task 20 is that `evictLRU` / `evictExpired` used to delete
 * cache entries synchronously, dropping the most recent turn before its
 * pending flush hit disk. Tests here drive the race deterministically by:
 *   - using a tiny `maxEntries` to force LRU on every insert,
 *   - using a tiny `ttlMs` to force bulk TTL eviction,
 *   - reaching into the eviction path via the `_forceEvictForTesting` helper
 *     for parallel-key cases.
 *
 * The store delegates flushing to the module-level `flushConversationHistory`
 * helper, so we verify ordering by reading the .jsonl back: if eviction
 * raced ahead of the flush, the most recent in-memory turn would be missing
 * from disk after the eviction returns.
 */
describe("ScopedChatSessionStore eviction race (v0.3 §20)", () => {
  it("awaits pending flush before deleting the cache entry (LRU)", async () => {
    // maxEntries=1 → every fresh insert evicts the previous one.
    const store = new ScopedChatSessionStore(workspace, makeFactory(), 1);
    await send(store, { kind: "global" }, "a", "a-msg");

    const file = path.join(workspace, ".mathran", "global-chat", "a.jsonl");
    expect(await fs.readFile(file, "utf-8")).toContain("a-msg");

    // Append a turn directly to the in-memory session WITHOUT flushing, so
    // there's a real "pending writes" delta the eviction must persist.
    const sessA = await store.getOrCreate({ kind: "global" }, "a", undefined);
    for await (const _ of sessA.send("a-msg-2")) {
      /* drain */
    }
    // In-memory has 'a-msg-2' but disk does not yet — confirm the gap.
    const beforeEvict = await fs.readFile(file, "utf-8");
    expect(beforeEvict).not.toContain("a-msg-2");

    // Force LRU eviction by inserting a second session.
    await send(store, { kind: "global" }, "b", "b-msg");

    // After eviction returns, 'a' must already be on disk in full. If the
    // old buggy path ran (delete first, never flush), 'a-msg-2' would be
    // permanently lost.
    const afterEvict = await fs.readFile(file, "utf-8");
    expect(afterEvict).toContain("a-msg");
    expect(afterEvict).toContain("a-msg-2");
  });

  it("de-dupes concurrent evictions of the same key", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory(), 8);
    await send(store, { kind: "global" }, "k1", "hello");

    // Append an unflushed turn so eviction has work to do.
    const sess = await store.getOrCreate({ kind: "global" }, "k1", undefined);
    for await (const _ of sess.send("second")) {
      /* drain */
    }

    // Two concurrent evictors of the same key. The lock should serialize
    // them; the second observes the entry already gone and returns cleanly
    // without throwing or double-flushing.
    await Promise.all([
      store._forceEvictForTesting({ kind: "global" }, "k1"),
      store._forceEvictForTesting({ kind: "global" }, "k1"),
    ]);

    // Disk has both turns intact.
    const onDisk = await fs.readFile(
      path.join(workspace, ".mathran", "global-chat", "k1.jsonl"),
      "utf-8",
    );
    expect(onDisk).toContain("hello");
    expect(onDisk).toContain("second");

    // Cache entry is gone — a re-read must rehydrate from disk.
    const re = await store.readHistory({ kind: "global" }, "k1");
    expect(re!.some((m) => m.content === "second")).toBe(true);
  });

  it("different keys evict in parallel — the per-session lock is not global", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory(), 8);
    const scopeA: ChatScope = { kind: "global" };
    const scopeB: ChatScope = { kind: "project", projectSlug: "p" };

    await send(store, scopeA, "a", "a-1");
    await send(store, scopeB, "b", "b-1");

    // Stage unflushed turns on both.
    const sa = await store.getOrCreate(scopeA, "a", undefined);
    for await (const _ of sa.send("a-2")) {
      /* drain */
    }
    const sb = await store.getOrCreate(scopeB, "b", undefined);
    for await (const _ of sb.send("b-2")) {
      /* drain */
    }

    // Run two evictions in parallel. The per-key lock means they don't
    // serialize; both must succeed and both files must contain their final
    // turns.
    const t0 = Date.now();
    await Promise.all([
      store._forceEvictForTesting(scopeA, "a"),
      store._forceEvictForTesting(scopeB, "b"),
    ]);
    const elapsed = Date.now() - t0;

    const aOnDisk = await fs.readFile(
      path.join(workspace, ".mathran", "global-chat", "a.jsonl"),
      "utf-8",
    );
    const bOnDisk = await fs.readFile(
      path.join(workspace, "projects", "p", "chat", "b.jsonl"),
      "utf-8",
    );
    expect(aOnDisk).toContain("a-2");
    expect(bOnDisk).toContain("b-2");

    // Sanity bound: two small flushes shouldn't take seconds wall-clock.
    expect(elapsed).toBeLessThan(2000);
  });

  it("bulk TTL eviction flushes every expired session before deleting", async () => {
    // ttlMs=1 → every entry is stale on the next eviction pass.
    const store = new ScopedChatSessionStore(workspace, makeFactory(), 64, 1);
    const scope: ChatScope = { kind: "global" };

    for (const cid of ["x1", "x2", "x3"]) {
      await send(store, scope, cid, `${cid}-first`);
      const s = await store.getOrCreate(scope, cid, undefined);
      for await (const _ of s.send(`${cid}-second`)) {
        /* drain */
      }
    }

    // Wait past the TTL window so the next getOrCreate triggers bulk evict.
    await new Promise((res) => setTimeout(res, 5));

    // Inserting a fresh key drives `evictExpired` over all three stale ones.
    await send(store, scope, "trigger", "go");

    // Every previously-staged session must be on disk in full — no key was
    // dropped before its pending flush.
    for (const cid of ["x1", "x2", "x3"]) {
      const onDisk = await fs.readFile(
        path.join(workspace, ".mathran", "global-chat", `${cid}.jsonl`),
        "utf-8",
      );
      expect(onDisk).toContain(`${cid}-first`);
      expect(onDisk).toContain(`${cid}-second`);
    }
  });
});

describe("peekLiveHistory (v0.12.x — /usage live-stream meter)", () => {
  it("returns the in-memory history of a cached session without touching disk", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    await send(store, { kind: "global" }, "cmeter", "hello");

    const live = store.peekLiveHistory({ kind: "global" }, "cmeter");
    expect(live).not.toBeNull();
    expect(live!.length).toBeGreaterThanOrEqual(2); // user + assistant at minimum
    const userMessages = live!.filter((m) => m.role === "user");
    expect(userMessages.some((m) => m.content === "hello")).toBe(true);
  });

  it("returns null for an unknown (never-cached) session", () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    expect(store.peekLiveHistory({ kind: "global" }, "never-existed")).toBeNull();
  });

  it("returns null after the session is evicted (so /usage falls back to disk)", async () => {
    // maxEntries=1 forces immediate eviction when a second conversation arrives.
    const store = new ScopedChatSessionStore(workspace, makeFactory(), 1);
    await send(store, { kind: "global" }, "first", "hi-1");
    // Trigger LRU eviction of "first":
    await send(store, { kind: "global" }, "second", "hi-2");

    expect(store.peekLiveHistory({ kind: "global" }, "first")).toBeNull();
    // But disk fallback still works:
    const fromDisk = await store.readHistory({ kind: "global" }, "first");
    expect(fromDisk).not.toBeNull();
    expect(fromDisk!.some((m) => m.content === "hi-1")).toBe(true);
  });

  it("reflects live history BEFORE flush is called (the /usage during-SSE case)", async () => {
    const store = new ScopedChatSessionStore(workspace, makeFactory());
    const scope: ChatScope = { kind: "global" };
    const cid = "unflushed";

    // Drain the SSE stream but DO NOT call store.flush() — mimics the
    // window where the browser polls /usage mid-stream.
    const session = await store.getOrCreate(scope, cid, undefined);
    for await (const _ of session.send("midstream-msg")) {
      /* drain */
    }
    // Disk should still be empty (no flush yet):
    const disk = await store.readHistory(scope, cid);
    expect(disk).toBeNull();
    // But peekLiveHistory sees it:
    const live = store.peekLiveHistory(scope, cid);
    expect(live).not.toBeNull();
    expect(live!.some((m) => m.content === "midstream-msg")).toBe(true);
  });
});
