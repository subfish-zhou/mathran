/**
 * Tests for chat-export.ts (adapted from mathub).
 *
 * Focus on the parts we actually consume in mathran:
 *  - buildConversationMarkdown: simple roundtrip + empty case
 *  - slugifyFilename: CJK preservation + special chars
 *  - protectSpans/buildConversationLatex: math + code stays verbatim through
 *    the LaTeX pipeline (this is the entire reason we wanted this helper —
 *    mathran chats are math-heavy and pdflatex-style escaping would mangle
 *    every \frac in the transcript).
 */
import { describe, expect, it } from "vitest";
import {
  buildConversationMarkdown,
  buildConversationLatex,
  slugifyFilename,
  type ExportTimelineItem,
} from "./chat-export.js";

const ts = new Date("2026-06-19T20:00:00.000Z");

describe("buildConversationMarkdown", () => {
  it("renders a single turn with roles + headings", () => {
    const items: ExportTimelineItem[] = [
      { role: "user", content: "Hi", createdAt: ts },
      { role: "assistant", content: "Hello!", createdAt: ts },
    ];
    const md = buildConversationMarkdown("Chat", items, ts);
    expect(md).toContain("# Chat");
    expect(md).toContain("_Exported from mathran");
    expect(md).toContain("### 🧑 You");
    expect(md).toContain("### 🤖 mathran");
    expect(md).toContain("Hi");
    expect(md).toContain("Hello!");
  });

  it("handles an empty conversation", () => {
    const md = buildConversationMarkdown("Empty", [], ts);
    expect(md).toContain("# Empty");
    expect(md).toContain("(empty conversation)");
  });

  it("falls back to a default title when missing", () => {
    const md = buildConversationMarkdown("", [], ts);
    expect(md).toContain("# Conversation");
  });
});

describe("slugifyFilename", () => {
  it("collapses spaces and ASCII punctuation", () => {
    expect(slugifyFilename("Hello, World!  Foo")).toBe("Hello-World-Foo");
  });

  it("keeps CJK characters", () => {
    expect(slugifyFilename("数学讨论 chat")).toBe("数学讨论-chat");
    expect(slugifyFilename("数论与代数")).toBe("数论与代数");
  });

  it("trims leading/trailing separators and caps length at 60", () => {
    const long = slugifyFilename("a".repeat(120));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(slugifyFilename("___hello___")).toBe("hello");
  });

  it("falls back to 'conversation' for an all-punct input", () => {
    expect(slugifyFilename("!!!")).toBe("conversation");
    expect(slugifyFilename("")).toBe("conversation");
  });
});

describe("buildConversationLatex (math + CJK fidelity)", () => {
  it("emits a compilable XeLaTeX preamble with xeCJK", () => {
    const tex = buildConversationLatex("Test", [], ts);
    expect(tex).toContain("% !TEX program = xelatex");
    expect(tex).toContain("\\usepackage{xeCJK}");
    expect(tex).toContain("\\documentclass[11pt]{article}");
    expect(tex).toContain("\\title{Test}");
    expect(tex).toContain("\\begin{document}");
    expect(tex).toContain("\\emph{(empty conversation)}");
  });

  it("preserves inline math verbatim (no \\textbackslash on \\frac)", () => {
    const items: ExportTimelineItem[] = [
      {
        role: "assistant",
        content: "Pythagoras: $a^2 + b^2 = c^2$ and $\\frac{1}{2}$.",
        createdAt: ts,
      },
    ];
    const tex = buildConversationLatex("Math", items, ts);
    expect(tex).toContain("$a^2 + b^2 = c^2$");
    expect(tex).toContain("$\\frac{1}{2}$");
    expect(tex).not.toContain("\\textbackslash{}frac");
  });

  it("preserves display math \\[ ... \\] verbatim", () => {
    const items: ExportTimelineItem[] = [
      {
        role: "assistant",
        content: "Definition:\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
        createdAt: ts,
      },
    ];
    const tex = buildConversationLatex("Math2", items, ts);
    expect(tex).toContain("\\[\\int_0^1 x^2\\,dx = \\frac{1}{3}\\]");
  });

  it("escapes prose but not math when they appear in the same line", () => {
    const items: ExportTimelineItem[] = [
      {
        role: "user",
        content: "Cost is 50% and energy E = $mc^2$.",
        createdAt: ts,
      },
    ];
    const tex = buildConversationLatex("Mixed", items, ts);
    // Prose `%` got escaped, math `mc^2` did not.
    expect(tex).toContain("50\\%");
    expect(tex).toContain("$mc^2$");
  });

  it("converts headings + bullet lists outside math", () => {
    const items: ExportTimelineItem[] = [
      {
        role: "assistant",
        content: "## Goldbach\n\n- even integer $n>2$\n- conjecture",
        createdAt: ts,
      },
    ];
    const tex = buildConversationLatex("Goldbach", items, ts);
    expect(tex).toContain("\\subsection*{Goldbach}");
    expect(tex).toContain("\\begin{itemize}");
    expect(tex).toContain("\\item even integer $n>2$");
    expect(tex).toContain("\\end{itemize}");
  });

  it("renders fenced code as lstlisting verbatim", () => {
    const items: ExportTimelineItem[] = [
      {
        role: "assistant",
        content: "```lean\ntheorem foo : 1 + 1 = 2 := rfl\n```",
        createdAt: ts,
      },
    ];
    const tex = buildConversationLatex("Code", items, ts);
    expect(tex).toContain("\\begin{lstlisting}");
    expect(tex).toContain("theorem foo : 1 + 1 = 2 := rfl");
    expect(tex).toContain("\\end{lstlisting}");
    // No prose escaping inside code.
    expect(tex).not.toContain("\\textbackslash{}");
  });
});
