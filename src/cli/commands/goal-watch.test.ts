/**
 * Unit tests for the `mathran goal watch` event renderer (UX gap D).
 *
 * These are pure-function tests on `renderEvent` / `renderHeader` / `oneLine` —
 * no live server, no SSE, no daemon. They pin the wire-to-line mapping so the
 * CLI tail stays stable as event shapes evolve.
 */
import { describe, it, expect } from "vitest";

import { renderEvent, renderHeader, oneLine, type Style } from "./goal-watch.js";

const plain: Style = { color: false };
const colored: Style = { color: true };

/** Strip ANSI so we can assert on text content regardless of color. */
function strip(s: string | null): string | null {
  if (s == null) return s;
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderEvent — core lifecycle frames", () => {
  it("iteration-start", () => {
    expect(renderEvent("iteration-start", { type: "iteration-start", iteration: 3 }, plain)).toBe(
      "▶ iter 3 start",
    );
  });

  it("iteration-end with progress + completed flag", () => {
    const out = renderEvent(
      "iteration-end",
      {
        type: "iteration-end",
        iteration: 2,
        progress: { assistantTurns: 4, toolCalls: 7, toolResults: 7, textChunks: 1 },
        result: { completed: true },
      },
      plain,
    );
    expect(out).toBe("■ iter 2 end (rounds=4 tools=7) ✓");
  });

  it("iteration-end without progress defaults counts to 0", () => {
    const out = renderEvent("iteration-end", { type: "iteration-end", iteration: 1, result: {} }, plain);
    expect(out).toBe("■ iter 1 end (rounds=0 tools=0)");
  });

  it("round-start with maxRounds", () => {
    expect(renderEvent("round-start", { type: "round-start", round: 2, maxRounds: 10 }, plain)).toBe(
      "🔄 round 2/10",
    );
  });

  it("round-start without maxRounds", () => {
    expect(renderEvent("round-start", { type: "round-start", round: 5 }, plain)).toBe("🔄 round 5");
  });
});

describe("renderEvent — compaction + budget", () => {
  it("compaction reports tokens saved", () => {
    const out = renderEvent(
      "compaction",
      { type: "compaction", originalTokens: 9000, newTokens: 3500, droppedRoundCount: 6 },
      plain,
    );
    expect(out).toBe("🧹 compacted (saved=5500)");
  });

  it("compaction falls back to droppedRoundCount when token math is non-positive", () => {
    const out = renderEvent(
      "compaction",
      { type: "compaction", originalTokens: 0, newTokens: 0, droppedRoundCount: 4 },
      plain,
    );
    expect(out).toBe("🧹 compacted (saved=4)");
  });

  it("budget-continuation shows pct + count", () => {
    const out = renderEvent(
      "budget-continuation",
      { type: "budget-continuation", pct: 72, continuationCount: 2 },
      plain,
    );
    expect(out).toBe("💰 continued (pct=72) #2");
  });
});

describe("renderEvent — tool calls + terminal tools", () => {
  it("mark_done renders complete check", () => {
    expect(strip(renderEvent("tool-call", { type: "tool-call", name: "mark_done", args: "{}" }, plain))).toBe(
      "✓ complete",
    );
  });

  it("give_up renders cross", () => {
    expect(strip(renderEvent("tool-call", { type: "tool-call", name: "give_up", args: "{}" }, plain))).toBe(
      "✗ give up",
    );
  });

  it("generic tool-call shows name + truncated args", () => {
    const out = renderEvent(
      "tool-call",
      { type: "tool-call", name: "bash", args: '{"cmd":"ls -la"}' },
      plain,
    );
    expect(out).toBe('· bash({"cmd":"ls -la"})');
  });

  it("tool-result ok shows arrow", () => {
    const out = renderEvent(
      "tool-result",
      { type: "tool-result", name: "read_file", ok: true, content: "hello world" },
      plain,
    );
    expect(out).toBe("· read_file → hello world");
  });

  it("tool-result failure shows cross", () => {
    const out = strip(
      renderEvent(
        "tool-result",
        { type: "tool-result", name: "bash", ok: false, content: "command not found" },
        plain,
      ),
    );
    expect(out).toBe("· bash ✗ command not found");
  });
});

describe("renderEvent — misc + truncation", () => {
  it("text delta collapses whitespace and is dimmed", () => {
    const out = renderEvent("text", { type: "text", delta: "  the   proof\n  proceeds " }, plain);
    expect(out).toBe("the proof proceeds");
  });

  it("empty text delta is dropped", () => {
    expect(renderEvent("text", { type: "text", delta: "   " }, plain)).toBeNull();
  });

  it("ask_user shows the question", () => {
    expect(strip(renderEvent("ask_user", { type: "ask_user", question: "Which lemma?" }, plain))).toBe(
      "❓ ask_user: Which lemma?",
    );
  });

  it("error frame", () => {
    expect(strip(renderEvent("error", { type: "error", message: "boom" }, plain))).toBe("‼ error: boom");
  });

  it("done is suppressed as noise", () => {
    expect(renderEvent("done", { type: "done", finishReason: "stop" }, plain)).toBeNull();
  });

  it("ping / snapshot frames render nothing", () => {
    expect(renderEvent("ping", { at: 1 }, plain)).toBeNull();
    expect(renderEvent("snapshot", { id: "x" }, plain)).toBeNull();
  });

  it("long tool args are truncated with an ellipsis", () => {
    const big = "x".repeat(500);
    const out = renderEvent("tool-call", { type: "tool-call", name: "t", args: big }, plain);
    expect(out!.length).toBeLessThan(120);
    expect(out!.endsWith("…)")).toBe(true);
  });
});

describe("renderEvent — terminal status frame", () => {
  it("complete is rendered (and colored when enabled)", () => {
    const plainOut = renderEvent("status", { status: "complete", endReason: "proved", terminal: true }, plain);
    expect(plainOut).toBe("● goal complete — proved");
    const colorOut = renderEvent("status", { status: "complete", terminal: true }, colored);
    expect(colorOut).toContain("\x1b[32m"); // green
    expect(strip(colorOut)).toBe("● goal complete");
  });

  it("failed status is colored red", () => {
    const out = renderEvent("status", { status: "failed", terminal: true }, colored);
    expect(out).toContain("\x1b[31m");
  });
});

describe("color gating", () => {
  it("no-color mode emits zero ANSI codes", () => {
    const out = renderEvent("iteration-start", { type: "iteration-start", iteration: 1 }, plain)!;
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  it("color mode wraps in escape codes", () => {
    const out = renderEvent("iteration-start", { type: "iteration-start", iteration: 1 }, colored)!;
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(true);
  });
});

describe("renderHeader", () => {
  it("includes objective, status, model, and progress", () => {
    const out = strip(
      renderHeader(
        {
          id: "abc123",
          objective: "Prove the lemma",
          status: "active",
          model: "copilot/gpt-5.5",
          iterationsRun: 3,
          assistantTurnsTotal: 9,
          toolCount: 12,
          tokensUsed: 4200,
          tokensMax: 10000,
          costUsd: 0.0345,
        },
        plain,
      ),
    )!;
    expect(out).toContain("Goal abc123");
    expect(out).toContain("objective: Prove the lemma");
    expect(out).toContain("status:    active");
    expect(out).toContain("model:     copilot/gpt-5.5");
    expect(out).toContain("iter=3 turns=9 tools=12 tokens=4200/10000");
    expect(out).toContain("$0.0345");
  });

  it("omits cost when null and tokensMax when null", () => {
    const out = strip(
      renderHeader(
        { id: "x", objective: "o", status: "active", model: "m", tokensUsed: 5, tokensMax: null, costUsd: null },
        plain,
      ),
    )!;
    expect(out).toContain("tokens=5");
    expect(out).not.toContain("$");
  });
});

describe("oneLine", () => {
  it("collapses whitespace", () => {
    expect(oneLine("a\n  b\t c")).toBe("a b c");
  });
  it("stringifies non-strings", () => {
    expect(oneLine({ a: 1 })).toBe('{"a":1}');
  });
  it("truncates with ellipsis", () => {
    expect(oneLine("abcdef", 4)).toBe("abc…");
  });
});
