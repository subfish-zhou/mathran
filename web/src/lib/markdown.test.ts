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

  it("converts \\[...\\] → block $$...$$ with surrounding blank lines", () => {
    // 2026-06-29 wiki bug fix: 块级 `$$` 必须独占段落，否则
    // marked-katex-extension 的 block 规则识别不到。preprocessMath
    // 现在为 `\[...\]` 输出 `\n\n$$\n<body trim>\n$$\n\n`。
    expect(preprocessMath("disp \\[a+b\\] ok")).toBe("disp \n\n$$\na+b\n$$\n\n ok");
  });

  it("wraps bare \\begin{}…\\end{} in block $$ pairs with surrounding blank lines", () => {
    // 同 \[...\]：环境必须独占段落。
    const out = preprocessMath("env: \\begin{equation} F = ma \\end{equation} end");
    expect(out).toBe("env: \n\n$$\n\\begin{equation} F = ma \\end{equation}\n$$\n\n end");
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
    // 块级 fix 后输出 `\n\n$$\n<body trim>\n$$\n\n`；
    // 3+ 个连续 \n 会被 collapse 成 \n\n，所以输入两边的换行被压平。
    const src = "before\n\\[\n  a^2 + b^2 = c^2\n\\]\nafter";
    expect(preprocessMath(src)).toBe("before\n\n$$\na^2 + b^2 = c^2\n$$\n\nafter");
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

describe("code block syntax highlighting (highlight.js)", () => {
  it("wraps fenced code in .code-block-wrapper with a Copy button", () => {
    const html = marked.parse("```python\nx = 1\n```") as string;
    expect(html).toMatch(/class="code-block-wrapper"/);
    expect(html).toMatch(/class="code-copy-btn"/);
    expect(html).toMatch(/data-code=/);
  });

  it("emits a language label for a known language", () => {
    const html = marked.parse("```python\nx = 1\n```") as string;
    expect(html).toMatch(/class="code-lang-label">python</);
  });

  it("applies hljs token spans to highlighted source", () => {
    const html = marked.parse("```python\ndef f():\n    return 1\n```") as string;
    // highlight.js wraps keywords/identifiers in `hljs-*` spans.
    expect(html).toMatch(/class="hljs/);
    expect(html).toMatch(/hljs-/);
  });

  it("falls back to highlightAuto for an unknown language (still wrapped)", () => {
    const html = marked.parse("```\nsome plain text\n```") as string;
    expect(html).toMatch(/class="code-block-wrapper"/);
    // No lang → no label span, but the block is still wrapped + copyable.
    expect(html).not.toMatch(/class="code-lang-label"/);
    expect(html).toMatch(/class="code-copy-btn"/);
  });

  it("HTML-escapes code so a snippet can't inject markup", () => {
    const html = marked.parse("```html\n<script>alert(1)</script>\n```") as string;
    // The raw tag must be escaped in the rendered output, not live HTML.
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toMatch(/&lt;script&gt;|&lt;script/);
  });
});
