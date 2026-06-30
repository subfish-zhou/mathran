/**
 * Checkpoint rewind — 5 mode tests (2026-06-30 sprint-3 续 follow-up).
 *
 * Covers the new `RestoreMode` extension to `/rewind`:
 *   - code-only            (default, files only — same as legacy)
 *   - conversation-only    (jsonl truncate only, files untouched)
 *   - code-and-conversation (both)
 *   - summarize-from-here  (keep pre-cut, summarise post-cut)
 *   - summarize-up-to-here (keep post-cut, summarise pre-cut, preserve leading system prompts)
 *
 * The summarize modes use the injected `Summarizer` so tests stay
 * deterministic — we don't call a real LLM.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  runRewind,
  type ConversationHistoryAdapter,
  type MinimalMessage,
  type Summarizer,
} from "../rewind.js";
import { writeCheckpoint } from "../store.js";
import type { Checkpoint } from "../schema.js";

let ws: string;
const CONV = "conv-modes";

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-modes-"));
});
afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

async function read(p: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(ws, p), "utf-8");
  } catch {
    return null;
  }
}

/** Build a minimal in-memory history adapter (no disk) for the mode tests. */
function makeInMemoryAdapter(initial: MinimalMessage[]): {
  adapter: ConversationHistoryAdapter;
  current: () => MinimalMessage[];
} {
  let state = [...initial];
  return {
    adapter: {
      async read() {
        return state.slice();
      },
      async write(messages) {
        state = [...messages];
      },
    },
    current: () => state.slice(),
  };
}

/** Stub summariser that produces a stable, asserted-against string. */
const tagSummarizer: Summarizer = (messages, ctx) =>
  `[SUMMARY ${ctx.side} of ${messages.length} msg]`;

/** Plant a checkpoint that captured `msgCount` messages worth of "before" state. */
async function plantCheckpoint(
  fileBefore: string,
  fileAfter: string,
  msgCount: number,
): Promise<Checkpoint> {
  await fs.writeFile(path.join(ws, "foo.ts"), fileAfter);
  const cp: Checkpoint = {
    id: "checkpoint-1-aaaaaaaa",
    conversationId: CONV,
    toolCallId: "c1",
    toolName: "edit_file",
    affectedPaths: ["foo.ts"],
    files: [
      {
        path: "foo.ts",
        before: { kind: "text", content: fileBefore },
        after: { kind: "text", content: fileAfter },
      },
    ],
    timestamp: 1,
    description: "edit_file foo.ts",
    messageCountBefore: msgCount,
  };
  await writeCheckpoint(ws, cp);
  return cp;
}

describe("runRewind — 5 restore modes", () => {
  it("code-only (default) — file restored, conversation untouched", async () => {
    await plantCheckpoint("hello", "world", 4);
    const { adapter, current } = makeInMemoryAdapter([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2 (post-checkpoint)" },
    ]);
    const out = await runRewind(ws, CONV, "1", {
      historyAdapter: adapter,
      summarizer: tagSummarizer,
    });
    expect(out.kind).toBe("done");
    expect(await read("foo.ts")).toBe("hello");
    // conversation NOT mutated.
    expect(current()).toHaveLength(5);
  });

  it("conversation-only — files untouched, conversation truncated to messageCountBefore", async () => {
    await plantCheckpoint("hello", "world", 3);
    const { adapter, current } = makeInMemoryAdapter([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2 (post-checkpoint)" },
      { role: "assistant", content: "a2 (post-checkpoint)" },
    ]);
    const out = await runRewind(ws, CONV, "1 --mode conversation-only", {
      historyAdapter: adapter,
      summarizer: tagSummarizer,
    });
    expect(out.kind).toBe("done");
    // file NOT rolled back.
    expect(await read("foo.ts")).toBe("world");
    // conversation truncated to msgCountBefore = 3 (+ a single rewind marker).
    const after = current();
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after.length).toBeLessThanOrEqual(4);
    expect(after[0]).toMatchObject({ role: "system", content: "sys" });
    expect(after.find((m) => String(m.content).includes("u2 (post-checkpoint)"))).toBeUndefined();
  });

  it("code-and-conversation — both files AND jsonl rolled back", async () => {
    await plantCheckpoint("hello", "world", 3);
    const { adapter, current } = makeInMemoryAdapter([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2 (after)" },
      { role: "assistant", content: "a2 (after)" },
    ]);
    const out = await runRewind(ws, CONV, "1 --mode code-and-conversation", {
      historyAdapter: adapter,
      summarizer: tagSummarizer,
    });
    expect(out.kind).toBe("done");
    expect(await read("foo.ts")).toBe("hello");
    const after = current();
    expect(after.find((m) => String(m.content).includes("u2 (after)"))).toBeUndefined();
  });

  it("summarize-from-here — keeps pre-cut as-is, replaces post-cut with one summary system msg", async () => {
    await plantCheckpoint("hello", "world", 3);
    const { adapter, current } = makeInMemoryAdapter([
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2 (tail)" },
      { role: "assistant", content: "a2 (tail)" },
      { role: "user", content: "u3 (tail)" },
    ]);
    const out = await runRewind(ws, CONV, "1 --mode summarize-from-here", {
      historyAdapter: adapter,
      summarizer: tagSummarizer,
    });
    expect(out.kind).toBe("done");
    const after = current();
    // First 3 messages preserved verbatim.
    expect(after[0].content).toBe("sys");
    expect(after[1].content).toBe("u1");
    expect(after[2].content).toBe("a1");
    // After cut we expect a single system summary message.
    const tail = after.slice(3);
    expect(tail.some((m) => m.role === "system" && String(m.content).includes("[SUMMARY tail of 3 msg]"))).toBe(true);
    // None of the original tail messages survive verbatim.
    expect(tail.find((m) => String(m.content).includes("u2 (tail)"))).toBeUndefined();
  });

  it("summarize-up-to-here — preserves leading system prompts + tail; head between is summarised", async () => {
    await plantCheckpoint("hello", "world", 4);
    const { adapter, current } = makeInMemoryAdapter([
      { role: "system", content: "sys-prompt-A" },
      { role: "system", content: "sys-prompt-B" },
      { role: "user", content: "u-1 (head)" },
      { role: "assistant", content: "a-1 (head)" },
      { role: "user", content: "u-2 (tail-preserved)" },
      { role: "assistant", content: "a-2 (tail-preserved)" },
    ]);
    const out = await runRewind(ws, CONV, "1 --mode summarize-up-to-here", {
      historyAdapter: adapter,
      summarizer: tagSummarizer,
    });
    expect(out.kind).toBe("done");
    const after = current();
    // Leading system prompts preserved.
    expect(after[0].content).toBe("sys-prompt-A");
    expect(after[1].content).toBe("sys-prompt-B");
    // A summary system msg lands between the leading prompts and the preserved tail.
    expect(after.some((m) => m.role === "system" && String(m.content).includes("[SUMMARY head"))).toBe(true);
    // Tail (post-cut) preserved verbatim.
    expect(after.some((m) => String(m.content).includes("u-2 (tail-preserved)"))).toBe(true);
    expect(after.some((m) => String(m.content).includes("a-2 (tail-preserved)"))).toBe(true);
    // Head messages between system prompts and cut are NOT present verbatim.
    expect(after.find((m) => String(m.content).includes("u-1 (head)"))).toBeUndefined();
  });

  it("non-code-only mode without history adapter → degrades gracefully (conversation skipped)", async () => {
    await plantCheckpoint("hello", "world", 3);
    const out = await runRewind(ws, CONV, "1 --mode code-and-conversation");
    expect(out.kind).toBe("done");
    if (out.kind === "done") {
      // file still rolled back, conversation operation marked skipped.
      expect(out.result.mode).toBe("code-and-conversation");
      expect(out.result.conversation?.action).toBe("skipped");
    }
    expect(await read("foo.ts")).toBe("hello");
  });

  it("invalid --mode value → error text, no mutation", async () => {
    await plantCheckpoint("hello", "world", 3);
    const out = await runRewind(ws, CONV, "1 --mode bogus");
    expect(out.kind).toBe("text");
    // file untouched.
    expect(await read("foo.ts")).toBe("world");
  });
});
