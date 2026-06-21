/**
 * v0.17 follow-up — math delimiter preprocess unit tests.
 *
 * The preprocess normalises LLM-flavoured LaTeX into the
 * `$...$` / `$$...$$` shape that `marked-katex-extension` accepts.
 */
import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { __preprocessMathForTest as preprocessMath, ensureMarkdownConfigured } from "./markdown";

// Idempotently ensure the global config (the side-effect import already ran,
// but be explicit).
ensureMarkdownConfigured();

describe("preprocessMath", () => {
  it("converts \\(...\\) → $...$", () => {
    expect(preprocessMath("inline \\(a+b\\) ok")).toBe("inline $a+b$ ok");
  });

  it("converts \\[...\\] → $$...$$", () => {
    expect(preprocessMath("disp \\[a+b\\] ok")).toBe("disp $$a+b$$ ok");
  });

  it("wraps bare \\begin{}…\\end{} in $$ pairs", () => {
    const out = preprocessMath("env: \\begin{equation} F = ma \\end{equation} end");
    expect(out).toBe("env: $$\\begin{equation} F = ma \\end{equation}$$ end");
  });

  it("does NOT double-wrap an env already inside $$", () => {
    const src = "wrapped: $$\\begin{aligned} x &= 1 \\\\ y &= 2 \\end{aligned}$$ end";
    expect(preprocessMath(src)).toBe(src);
  });

  it("leaves $...$ and $$...$$ alone", () => {
    expect(preprocessMath("a $x^2$ b $$y^2$$ c")).toBe("a $x^2$ b $$y^2$$ c");
  });

  it("does not rewrite delimiters inside inline code spans", () => {
    const src = "literal `\\(not math\\)` here";
    expect(preprocessMath(src)).toBe(src);
  });

  it("does not rewrite delimiters inside fenced code blocks", () => {
    const src = "before\n```\n\\(literal\\)\n\\[literal\\]\n```\nafter";
    expect(preprocessMath(src)).toBe(src);
  });

  it("returns the input verbatim when no LLM delimiters appear", () => {
    expect(preprocessMath("plain text")).toBe("plain text");
    expect(preprocessMath("only $math$ here")).toBe("only $math$ here");
  });

  it("handles empty / non-string defensively", () => {
    expect(preprocessMath("")).toBe("");
    expect(preprocessMath(undefined as unknown as string)).toBe(undefined as unknown as string);
  });

  it("handles multi-line display blocks across newlines", () => {
    const src = "before\n\\[\n  a^2 + b^2 = c^2\n\\]\nafter";
    expect(preprocessMath(src)).toBe("before\n$$\n  a^2 + b^2 = c^2\n$$\nafter");
  });
});

describe("marked + KaTeX end-to-end", () => {
  it("renders $...$ inline", () => {
    const html = marked.parse("inline $x^2+y^2$ done") as string;
    expect(html).toMatch(/class="katex"/);
  });

  it("renders $$...$$ display", () => {
    const html = marked.parse("disp $$E=mc^2$$ done") as string;
    expect(html).toMatch(/class="katex-display"/);
  });

  it("renders \\(...\\) inline via preprocess", () => {
    const html = marked.parse("ll \\(a+b\\) end") as string;
    expect(html).toMatch(/class="katex"/);
    expect(html).not.toMatch(/\\\(a\+b\\\)/);
  });

  it("renders \\[...\\] display via preprocess", () => {
    const html = marked.parse("ll \\[a+b\\] end") as string;
    expect(html).toMatch(/class="katex-display"/);
  });

  it("renders bare \\begin{equation} via preprocess wrap", () => {
    const html = marked.parse("env \\begin{equation} F = ma \\end{equation} end") as string;
    expect(html).toMatch(/class="katex/);
  });

  it("preserves literal math syntax inside code fences", () => {
    const html = marked.parse("```\n\\(literal\\)\n```") as string;
    // The text inside the fence must survive (KaTeX must NOT have eaten it).
    expect(html).toMatch(/\\\(literal\\\)/);
  });
});
