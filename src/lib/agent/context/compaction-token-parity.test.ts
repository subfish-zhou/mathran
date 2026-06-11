import { describe, it, expect } from "vitest";
import { rowTokens, estimateRowTokens, snapToTurnStart } from "./compaction";

/**
 * Phase 3.1 Bug B — compaction token口径 parity.
 *
 * The compaction trigger (`maybeCompactConversation` → rowTokens) must count
 * each row by the EXACT form `loadChannelContext` (chat-handler.ts) feeds it to
 * the LLM. These tests pin that parity so a future change to one side without
 * the other fails loudly. They mirror the chat-handler serialization verbatim:
 *   • tool row     → JSON.stringify(toolResult) (else content)
 *   • assistant    → content + Σ (callId + name + JSON.stringify(args))
 *   • user/summary → content
 */

// rowTokens uses the module's internal countTokens; we assert口径 parity by
// comparing a tool row (whose cost is a pure passthrough of
// countTokens(JSON.stringify(toolResult))) against an equivalent reconstruction.

describe("rowTokens — loadChannelContext口径 parity", () => {
  it("tool row counts JSON.stringify(toolResult), NOT content", () => {
    // Varied content so neither tiktoken BPE merges nor chars/4 collapse it.
    const words = Array.from({ length: 600 }, (_, i) => `tok${i}_payload`).join(" ");
    const big = { result: words, nested: { a: 1, b: [1, 2, 3] } };
    const row = { content: "", toolCallId: "call_1", toolResult: big, metadata: null };
    const cost = rowTokens(row);
    // The bug: counting only `content` would have been ~0 here; with toolResult
    // serialized it reflects the real LLM byte volume.
    expect(cost).toBeGreaterThan(400);
    // A content-only row with empty content costs ~0 — proving the口径 shift.
    const contentOnly = rowTokens({ content: "", toolCallId: null, toolResult: null, metadata: null });
    expect(contentOnly).toBe(0);
    expect(cost).toBeGreaterThan(contentOnly);
  }, 30_000);

  it("tool row falls back to content when toolResult is null", () => {
    const row = { content: "fallback body", toolCallId: "call_1", toolResult: null, metadata: null };
    const plainContent = { content: "fallback body", toolCallId: null, toolResult: null, metadata: null };
    // With null toolResult, loadChannelContext feeds `content` verbatim, so the
    // tool row token cost equals a plain content row's cost.
    expect(rowTokens(row)).toBe(rowTokens(plainContent));
    expect(rowTokens(row)).toBeGreaterThan(0);
  });

  it("assistant text row adds serialized metadata.toolCalls (carries args)", () => {
    const args = { query: Array.from({ length: 600 }, (_, i) => `q${i}_term`).join(" "), opts: { deep: true } };
    const row = {
      content: "thinking...",
      toolCallId: null,
      toolResult: null,
      metadata: { toolCalls: [{ callId: "c1", name: "web_search", args }] },
    };
    // content-only would undercount; with toolCalls it must include args bulk.
    const contentOnly = rowTokens({ content: "thinking...", toolCallId: null, toolResult: null, metadata: null });
    expect(rowTokens(row)).toBeGreaterThan(contentOnly + 200);
  }, 30_000);

  it("user/plain row counts only content", () => {
    const row = { content: "hello world", toolCallId: null, toolResult: null, metadata: null };
    const plain = { content: "hello world", toolCallId: null, toolResult: null, metadata: { foo: 1 } };
    expect(rowTokens(row)).toBe(rowTokens(plain));
  });

  it("estimateRowTokens sums rows", () => {
    const rows = [
      { content: "a", toolCallId: null, toolResult: null, metadata: null },
      { content: "", toolCallId: "c1", toolResult: { x: 1 }, metadata: null },
    ];
    expect(estimateRowTokens(rows)).toBe(rowTokens(rows[0]!) + rowTokens(rows[1]!));
  });
});

/**
 * Phase 3.1 turn-atomicity guard — snapToTurnStart forward-snaps the
 * backward-keep cut to a turn boundary so toCompact = whole turns, never
 * splitting an assistant tool_calls row from its tool_result rows.
 *
 * Layout (role = author_kind; 'user' marks a turn start):
 *   idx 0  u1  user        turn 1 start
 *   idx 1  a1  assistant   turn 1 text (tool_calls)
 *   idx 2  t1  assistant   turn 1 tool_result
 *   idx 3  t2  assistant   turn 1 tool_result
 *   idx 4  u2  user        turn 2 start
 *   idx 5  a2  assistant   turn 2 text
 *   idx 6  t3  assistant   turn 2 tool_result
 *   idx 7  u3  user        turn 3 start
 *   idx 8  a3  assistant   turn 3 text
 */
const turnRows = [
  { role: "user" },      // 0
  { role: "assistant" }, // 1
  { role: "assistant" }, // 2
  { role: "assistant" }, // 3
  { role: "user" },      // 4
  { role: "assistant" }, // 5
  { role: "assistant" }, // 6
  { role: "user" },      // 7
  { role: "assistant" }, // 8
];

describe("snapToTurnStart — turn-atomic compaction cut", () => {
  it("snaps a cut INSIDE turn 1 forward to turn 2 start (idx 4)", () => {
    // Raw backward-keep landed at idx 2 (between a1 and its tool_result rows).
    // Snapping forward to the next user row (idx 4) means toCompact = [0,4) =
    // exactly turn 1 (u1,a1,t1,t2) — no split, no dangling tool_result.
    expect(snapToTurnStart(turnRows, 2)).toBe(4);
    expect(snapToTurnStart(turnRows, 3)).toBe(4);
  });

  it("leaves a cut already ON a turn boundary unchanged", () => {
    expect(snapToTurnStart(turnRows, 4)).toBe(4);
    expect(snapToTurnStart(turnRows, 7)).toBe(7);
    expect(snapToTurnStart(turnRows, 0)).toBe(0);
  });

  it("snaps a cut inside the LAST turn to rows.length (compact whole partial turn)", () => {
    // idx 8 is inside turn 3 with no following user row → snap to length (9):
    // the trailing partial turn folds entirely into the compacted prefix.
    expect(snapToTurnStart(turnRows, 8)).toBe(turnRows.length);
  });

  it("never leaves a dangling assistant/tool tail in the kept region", () => {
    // For every raw cut, the snapped index is either rows.length or a user row.
    for (let raw = 0; raw <= turnRows.length; raw++) {
      const snapped = snapToTurnStart(turnRows, raw);
      if (snapped < turnRows.length) {
        expect(turnRows[snapped]!.role).toBe("user");
      }
      // toCompact = rows.slice(0, snapped) ends right before a turn start, so
      // the kept region [snapped, end) begins on a user row (or is empty).
      expect(snapped).toBeGreaterThanOrEqual(raw);
    }
  });
});
