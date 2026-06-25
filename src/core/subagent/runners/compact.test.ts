/**
 * Tests for the compact subagent runner (v0.2 §5).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  COMPACT_SUMMARY_PREFIX,
  compactRunner,
  computeCompacted,
  findKeepStartIndex,
} from "./compact.js";
import { SubagentRegistry } from "../registry.js";
import { SubagentScheduler } from "../scheduler.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../../providers/llm.js";

/** Build an LLMResponse that streams a single text chunk + done. */
function fakeSummarizer(summary: string): LLMProvider {
  return {
    async describe() {
      return { name: "fake-summarizer" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "text", delta: summary };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

/** Build N user/assistant rounds. */
function buildRounds(n: number, prefix = "round"): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ role: "user", content: `${prefix} ${i} question` });
    out.push({ role: "assistant", content: `${prefix} ${i} answer` });
  }
  return out;
}

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-compact-"));
});
afterEach(async () => {
  if (workspace && fssync.existsSync(workspace)) {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

describe("compact runner — findKeepStartIndex", () => {
  it("returns end of array when keepRounds is 0", () => {
    const msgs: LLMMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    expect(findKeepStartIndex(msgs, 0)).toBe(msgs.length);
  });

  it("falls back to firstNonSystem when fewer user msgs than keepRounds", () => {
    const msgs: LLMMessage[] = [
      { role: "system", content: "S" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    // Only 1 user message — asking for 5 means we keep the whole non-system tail.
    expect(findKeepStartIndex(msgs, 5)).toBe(1);
  });

  it("finds the K-th from the end correctly", () => {
    const msgs: LLMMessage[] = [
      { role: "system", content: "S" },
      ...buildRounds(10), // 10 user + 10 assistant
    ];
    // K=3 → keep last 3 user msgs. They are at indices 1+2*7=15, 17, 19.
    // The K-th from the end (the start of the kept tail) is the 8th user msg = index 15.
    expect(findKeepStartIndex(msgs, 3)).toBe(15);
  });
});

describe("compact runner — computeCompacted (no-op cases)", () => {
  it("returns noop when middle chunk is empty (history ≤ system + K rounds)", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "S" },
      ...buildRounds(3),
    ];
    const result = await computeCompacted({
      messages,
      keepRecentRounds: 5,
      llm: fakeSummarizer("(should not be called)"),
    });
    expect(result.noop).toBe(true);
    expect(result.droppedRoundCount).toBe(0);
    expect(result.newMessages.length).toBe(messages.length);
    expect(result.originalTokenCount).toBe(result.newTokenCount);
  });
});

describe("compact runner — computeCompacted (normal case)", () => {
  it("keeps system + K rounds and inserts a summary system message", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are mathran." },
      ...buildRounds(20),
    ];
    const summary = "Earlier the user and assistant discussed various round topics.";
    const result = await computeCompacted({
      messages,
      keepRecentRounds: 5,
      llm: fakeSummarizer(summary),
    });

    expect(result.noop).toBe(false);
    expect(result.droppedRoundCount).toBe(15);

    // Result should be: [system, summary-system, last 5 rounds = 10 msgs]
    expect(result.newMessages.length).toBe(2 + 5 * 2);
    expect(result.newMessages[0].role).toBe("system");
    expect(result.newMessages[0].content).toBe("You are mathran.");
    expect(result.newMessages[1].role).toBe("system");
    const compactSummary = result.newMessages[1].content;
    if (typeof compactSummary !== "string") throw new Error("expected string content");
    expect(compactSummary.startsWith(COMPACT_SUMMARY_PREFIX)).toBe(true);
    expect(compactSummary).toContain(summary);

    // Last user msg in the new history is the last user round.
    const lastUser = [...result.newMessages].reverse().find((m) => m.role === "user");
    expect(lastUser?.content).toBe("round 20 question");
  });

  it("originalTokenCount > newTokenCount after compaction", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "S" },
      ...buildRounds(30, "long-prefix-to-pad-the-history-out"),
    ];
    const result = await computeCompacted({
      messages,
      keepRecentRounds: 3,
      llm: fakeSummarizer("brief summary"),
    });
    expect(result.noop).toBe(false);
    expect(result.originalTokenCount).toBeGreaterThan(result.newTokenCount);
  });

  it("drops the reasoning field from kept tail messages (UX gap B)", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "S" },
      ...buildRounds(10),
    ];
    // Tag the assistant turns in the kept tail with reasoning. With
    // keepRecentRounds=2 the last 2 rounds (4 msgs) are kept verbatim.
    for (const m of messages) {
      if (m.role === "assistant") m.reasoning = "disposable chain-of-thought";
    }
    const result = await computeCompacted({
      messages,
      keepRecentRounds: 2,
      llm: fakeSummarizer("recap"),
    });
    expect(result.noop).toBe(false);
    // Reasoning is the first thing dropped: no kept message retains it.
    expect(result.newMessages.some((m) => m.reasoning !== undefined)).toBe(false);
    // The original input is untouched (run() must not mutate).
    expect(messages.some((m) => m.reasoning === "disposable chain-of-thought")).toBe(true);
  });
});

describe("compact runner — full runner via scheduler", () => {
  it("writes the compacted artifact and returns an artifactPath", async () => {
    const registry = new SubagentRegistry();
    registry.register(compactRunner);
    const sched = new SubagentScheduler({ workspace, registry, maxConcurrent: 1 });

    const messages: LLMMessage[] = [
      { role: "system", content: "S" },
      ...buildRounds(12),
    ];
    const result = await sched.dispatch({
      type: "compact",
      input: {
        messages,
        keepRecentRounds: 4,
        contextWindow: 100_000,
        // No `llm` injected → runner uses the deterministic fallback summary.
      },
    });
    expect(result.status).toBe("ok");
    expect(result.artifactPath).toBeTruthy();

    // Artifact exists on disk.
    const abs = path.join(workspace, result.artifactPath!);
    const raw = await fs.readFile(abs, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.noop).toBe(false);
    expect(parsed.droppedRoundCount).toBe(12 - 4);
    expect(parsed.newMessages.length).toBe(2 + 4 * 2);

    // Summary field is also embedded in the returned (capped) summary blob.
    const summaryObj = JSON.parse(result.summary);
    expect(summaryObj.droppedRoundCount).toBe(12 - 4);
    expect(summaryObj.contextWindow).toBe(100_000);
  });

  it("rejects malformed input", async () => {
    const registry = new SubagentRegistry();
    registry.register(compactRunner);
    const sched = new SubagentScheduler({ workspace, registry });

    const result = await sched.dispatch({
      type: "compact",
      input: { notMessages: true } as any,
    });
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("messages");
  });
});
