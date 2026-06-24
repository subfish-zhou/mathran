/**
 * Tests for compact-prompt — TODO-2 §9.1 / C4.
 *
 * Covers the structural shape of the 9-section prompt, the system
 * prompt content, the transcript renderer (tool tagging + tool-call
 * inclusion), and the truncate helper's head/tail behavior.
 */

import { describe, it, expect } from "vitest";
import type { LLMMessage } from "../../providers/llm.js";
import {
  build9SectionPrompt,
  renderMiddleAsTranscript,
  summarizationSystemPrompt,
  truncate,
} from "./compact-prompt.js";

const user = (text: string): LLMMessage => ({ role: "user", content: text });
const asst = (text: string, calls?: Array<{ id: string; name: string; arguments: string }>): LLMMessage =>
  ({ role: "assistant", content: text, ...(calls ? { toolCalls: calls } : {}) });
const tool = (text: string, name = "read_file"): LLMMessage =>
  ({ role: "tool", content: text, toolCallId: "call_x", name });

describe("summarizationSystemPrompt", () => {
  it("instructs the model to output only the summary, no preamble", () => {
    const p = summarizationSystemPrompt();
    expect(p).toMatch(/Output ONLY/i);
    expect(p).toMatch(/no preamble/i);
    expect(p).toContain("## 1. Primary Request and Intent");
  });
});

describe("build9SectionPrompt", () => {
  it("contains all 9 section headings in order", () => {
    const p = build9SectionPrompt([user("hi"), asst("hello")]);
    const headings = [
      "## 1. Primary Request and Intent",
      "## 2. Key Technical Concepts",
      "## 3. Files and Code Sections",
      "## 4. Errors and Fixes",
      "## 5. Problem Solving",
      "## 6. All User Messages (verbatim)",
      "## 7. Pending Tasks",
      "## 8. Current Work",
      "## 9. Optional Next Step",
    ];
    let lastIdx = -1;
    for (const h of headings) {
      const idx = p.indexOf(h);
      expect(idx).toBeGreaterThan(lastIdx); // present + in order
      lastIdx = idx;
    }
  });

  it("emphasizes the verbatim rule for section 6", () => {
    const p = build9SectionPrompt([user("hi")]);
    expect(p).toMatch(/verbatim/i);
    expect(p).toMatch(/Do NOT paraphrase/i);
  });

  it("includes the BEGIN/END history markers around the transcript", () => {
    const p = build9SectionPrompt([user("hi"), asst("hello")]);
    expect(p).toContain("--- BEGIN CONVERSATION HISTORY ---");
    expect(p).toContain("--- END CONVERSATION HISTORY ---");
    const begin = p.indexOf("--- BEGIN CONVERSATION HISTORY ---");
    const end = p.indexOf("--- END CONVERSATION HISTORY ---");
    expect(end).toBeGreaterThan(begin);
    // transcript renders between the markers
    expect(p.slice(begin, end)).toContain("[USER]");
    expect(p.slice(begin, end)).toContain("[ASSISTANT]");
  });

  it("ends with an instruction to start with section 1", () => {
    const p = build9SectionPrompt([user("hi")]);
    expect(p.trimEnd().endsWith('starting with "## 1. Primary Request and Intent".')).toBe(true);
  });

  it("works on an empty middle chunk (degenerate case)", () => {
    const p = build9SectionPrompt([]);
    // still well-formed; transcript is empty between markers
    expect(p).toContain("--- BEGIN CONVERSATION HISTORY ---");
    expect(p).toContain("--- END CONVERSATION HISTORY ---");
  });
});

describe("renderMiddleAsTranscript", () => {
  it("tags messages by role and includes tool name for tool messages", () => {
    const out = renderMiddleAsTranscript([
      user("hello"),
      asst("hi"),
      tool("file contents here", "read_file"),
    ]);
    expect(out).toContain("[USER]");
    expect(out).toContain("hello");
    expect(out).toContain("[ASSISTANT]");
    expect(out).toContain("[TOOL read_file]");
    expect(out).toContain("file contents here");
  });

  it("renders assistant tool_calls below the assistant body", () => {
    const out = renderMiddleAsTranscript([
      asst("calling bash now", [
        { id: "1", name: "bash", arguments: '{"cmd":"ls -la"}' },
      ]),
    ]);
    expect(out).toContain("[ASSISTANT]");
    expect(out).toContain("calling bash now");
    expect(out).toContain('→ bash({"cmd":"ls -la"})');
  });

  it("works without any tool_calls or tool messages (plain back-and-forth)", () => {
    const out = renderMiddleAsTranscript([user("ping"), asst("pong")]);
    expect(out).toBe("[USER]\nping\n\n[ASSISTANT]\npong");
  });

  it("truncates very long message bodies in-place", () => {
    const huge = "x".repeat(3000);
    const out = renderMiddleAsTranscript([asst(huge)]);
    expect(out.length).toBeLessThan(huge.length); // truncated
    expect(out).toMatch(/\[truncated \d+ chars\]/);
  });
});

describe("truncate", () => {
  it("returns the original string when shorter than max", () => {
    expect(truncate("hello", 100)).toBe("hello");
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates with head/tail kept and a marker in the middle", () => {
    const input = "a".repeat(100) + "b".repeat(100);
    const out = truncate(input, 100);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toMatch(/\[truncated 100 chars\]/);
    expect(out.startsWith("a")).toBe(true); // head preserved
    expect(out.endsWith("b")).toBe(true); // tail preserved
  });

  it("keeps roughly 70% head, 30% tail", () => {
    const input = "h".repeat(700) + "t".repeat(300);
    const out = truncate(input, 200);
    const headPart = out.split("\n...")[0];
    expect(headPart.length).toBeGreaterThanOrEqual(130); // ~70% of 200
    expect(headPart.length).toBeLessThanOrEqual(150);
    // tail kept (last char of tail-part is 't')
    expect(out.endsWith("t")).toBe(true);
  });
});
