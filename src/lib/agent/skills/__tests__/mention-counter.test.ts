/**
 * Mention counter tests — spec/06-skills.md §4.8.
 *
 * 1. recordMention bumps in-memory count
 * 2. getCount immediately reflects
 * 3. setMentionFlushSink installs sink; flushPendingMentions calls it with deltas
 * 4. Sink rejection keeps deltas (best-effort retry)
 * 5. Snapshot returns hot-first, alpha-tiebreak ordering
 *
 * Ported: 2026-06-10 (commit 6a/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordMention,
  getCount,
  getLastUsedAt,
  snapshotMentionCounts,
  setMentionFlushSink,
  flushPendingMentions,
  _resetMentionCounterForTest,
  type MentionFlushSink,
} from "../mention-counter";

beforeEach(() => {
  _resetMentionCounterForTest();
});

describe("recordMention / getCount", () => {
  it("increments count and updates lastUsedAt", () => {
    expect(getCount("foo")).toBe(0);
    expect(getLastUsedAt("foo")).toBeUndefined();
    recordMention("foo");
    expect(getCount("foo")).toBe(1);
    expect(getLastUsedAt("foo")).toBeInstanceOf(Date);
    recordMention("foo");
    recordMention("foo");
    expect(getCount("foo")).toBe(3);
  });

  it("empty slug is a no-op", () => {
    recordMention("");
    expect(snapshotMentionCounts()).toHaveLength(0);
  });
});

describe("snapshotMentionCounts ordering", () => {
  it("returns hot-first then alpha tiebreak", () => {
    recordMention("zebra");
    recordMention("alpha");
    recordMention("alpha");
    recordMention("alpha");
    recordMention("mango");
    recordMention("mango");
    const snap = snapshotMentionCounts();
    expect(snap.map((s) => s.slug)).toEqual(["alpha", "mango", "zebra"]);
    expect(snap.map((s) => s.count)).toEqual([3, 2, 1]);
  });
});

describe("flushPendingMentions", () => {
  it("calls sink.flush with non-zero deltas and clears them", async () => {
    const captured: Array<Array<{ slug: string; deltaCount: number; lastUsedAt: Date }>> = [];
    const sink: MentionFlushSink = {
      async flush(updates) {
        captured.push(updates);
      },
    };
    setMentionFlushSink(sink);
    recordMention("a");
    recordMention("a");
    recordMention("b");
    await flushPendingMentions();
    expect(captured).toHaveLength(1);
    const sorted = captured[0]!.slice().sort((x, y) => x.slug.localeCompare(y.slug));
    expect(sorted).toEqual([
      expect.objectContaining({ slug: "a", deltaCount: 2 }),
      expect.objectContaining({ slug: "b", deltaCount: 1 }),
    ]);
    // Second flush with no new mentions → sink not called again.
    await flushPendingMentions();
    expect(captured).toHaveLength(1);
  });

  it("keeps deltas when sink rejects (best-effort retry)", async () => {
    let attempts = 0;
    const sink: MentionFlushSink = {
      async flush() {
        attempts += 1;
        if (attempts === 1) throw new Error("db down");
      },
    };
    setMentionFlushSink(sink);
    recordMention("retry-me");
    await flushPendingMentions();
    expect(attempts).toBe(1);
    // Delta still pending → next flush retries with same delta.
    await flushPendingMentions();
    expect(attempts).toBe(2);
  });

  it("no-op when no sink installed", async () => {
    recordMention("x");
    await flushPendingMentions();
    // No throw; count unchanged.
    expect(getCount("x")).toBe(1);
  });
});
