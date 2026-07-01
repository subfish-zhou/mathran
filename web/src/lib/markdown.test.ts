/**
 * v0.17 follow-up — math delimiter preprocess unit tests.
 *
 * The preprocess normalises LLM-flavoured LaTeX into the
 * `$...$` / `$$...$$` shape that `marked-katex-extension` accepts.
 */
import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { __preprocessMathForTest as preprocessMath, extractTikzEnvs, ensureMarkdownConfigured } from "./markdown";

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

describe("preprocessMath — blockquote-aware LaTeX (2026-07-01 alpha chat bug)", () => {
  it("strips leading '> ' from blockquote-wrapped \\[ ... \\] display math (Bug 1)", () => {
    // Reproduces alpha's c-2735c92c chat: LLM wraps a conjecture body
    // in a blockquote, and the math block sits INSIDE the blockquote
    // with a leading '> ' on every line. Old preprocessor kept the '>'
    // characters INSIDE the resulting $$...$$ block, so KaTeX saw
    // "> \ell..." and choked, rendering the whole conjecture as garbage.
    const input = [
      "> **Conjecture.**",
      "> Let \\(\\varphi\\) be a contraction, and",
      "> \\[",
      "> \\ell_{\\mathcal F}^{\\mathrm{vert}}(R)>r_{\\mathrm{vert}}.",
      "> \\]",
      "> Then \\(\\varphi\\) is a bundle.",
    ].join("\n");
    const out = preprocessMath(input);
    // The math body inside the produced $$...$$ MUST NOT contain any '>' prefix chars.
    const displayMatch = out.match(/\$\$\n([\s\S]*?)\n\$\$/);
    expect(displayMatch).not.toBeNull();
    const body = displayMatch![1];
    expect(body).not.toMatch(/^>/m); // no line starts with '>'
    expect(body).toContain("\\ell_{\\mathcal F}"); // real math survived
  });

  it("strips leading '> ' from blockquote-wrapped multi-line \\[ ... \\]", () => {
    // Same as above but the display body spans several lines with '> '
    // prefixes (the alpha bug's exact shape: exact sequence of foliations).
    const input = [
      "> \\[",
      "> 0\\to T_{X/Y}^{\\mathrm{tor}}",
      "> \\to \\mathcal F",
      "> \\to \\varphi^{-1}\\mathcal G",
      "> \\to 0.",
      "> \\]",
    ].join("\n");
    const out = preprocessMath(input);
    const displayMatch = out.match(/\$\$\n([\s\S]*?)\n\$\$/);
    expect(displayMatch).not.toBeNull();
    expect(displayMatch![1]).not.toMatch(/^>/m);
    expect(displayMatch![1]).toContain("0\\to T_{X/Y}");
    expect(displayMatch![1]).toContain("\\to 0");
  });

  it("preserves blockquote structure OUTSIDE the math block", () => {
    // The surrounding prose (still in blockquote) must remain a blockquote.
    const input = [
      "> before math",
      "> \\[",
      "> x=1",
      "> \\]",
      "> after math",
    ].join("\n");
    const out = preprocessMath(input);
    // 'before math' and 'after math' should keep their '>' prefixes so
    // marked still recognises them as blockquote lines.
    expect(out).toMatch(/^> before math/m);
    expect(out).toMatch(/^> after math/m);
  });
});

describe("preprocessMath — unsupported LaTeX envs (2026-07-01 alpha tikzcd bug)", () => {
  it("does NOT wrap tikzcd envs in $$…$$ (KaTeX can't render tikzcd — Bug 2)", () => {
    // Reproduces alpha's c-eb4a403e chat: LLM emitted a tikzcd diagram
    // inside \[...\]. KaTeX has no tikzcd support and its parse error
    // cascades — the SPA rendered the diagram as literal text AND ate
    // the following "More explicitly: 1. …" paragraph as leftover
    // math body. The fix: leave tikzcd (and other TikZ-family envs)
    // as-is so it renders as fenced code / prose, not broken math.
    const input = [
      "The resolution is",
      "",
      "\\[",
      "\\begin{tikzcd}",
      "W \\arrow[dr] & Y",
      "\\end{tikzcd}",
      "\\]",
      "",
      "More explicitly:",
      "",
      "1. First step",
    ].join("\n");
    const out = preprocessMath(input);
    // tikzcd content should NOT be wrapped in $$…$$ (it would break KaTeX).
    // Extract any $$...$$ blocks and confirm none contain 'tikzcd'.
    const mathBlocks = out.match(/\$\$[\s\S]*?\$\$/g) ?? [];
    for (const block of mathBlocks) {
      expect(block).not.toContain("tikzcd");
    }
    // "More explicitly:" must remain intact in the output.
    expect(out).toContain("More explicitly:");
    expect(out).toContain("1. First step");
  });

  it("also skips \\begin{tikzcd} when it appears bare (no \\[…\\] wrap)", () => {
    const input = [
      "See the diagram:",
      "",
      "\\begin{tikzcd}",
      "A \\arrow[r] & B",
      "\\end{tikzcd}",
      "",
      "Notice that A goes to B.",
    ].join("\n");
    const out = preprocessMath(input);
    const mathBlocks = out.match(/\$\$[\s\S]*?\$\$/g) ?? [];
    for (const block of mathBlocks) {
      expect(block).not.toContain("tikzcd");
    }
    expect(out).toContain("Notice that A goes to B.");
  });
});

describe("extractTikzEnvs — server-side render placeholder (2026-07-01)", () => {
  it("lifts a bare \\begin{tikzcd}…\\end{tikzcd} into a placeholder div", () => {
    const input = [
      "See:",
      "",
      "\\begin{tikzcd}",
      "A \\arrow[r] & B",
      "\\end{tikzcd}",
      "",
      "Explanation.",
    ].join("\n");
    const out = extractTikzEnvs(input);
    expect(out).toContain(`<div class="tikz-placeholder"`);
    expect(out).toContain(`data-tikz-env="tikzcd"`);
    expect(out).toMatch(/data-tikz-src="[A-Za-z0-9+/=]+"/); // base64
    // Original tikzcd env no longer appears — it's now in the base64 blob.
    expect(out).not.toContain("\\begin{tikzcd}");
    // Surrounding prose intact.
    expect(out).toContain("See:");
    expect(out).toContain("Explanation.");
  });

  it("strips wrapping \\[ … \\] around a tikzcd env (alpha c-eb4a403e shape)", () => {
    // Exactly the shape alpha's chat produced: \[ tikzcd \]
    const input = [
      "The resolution is",
      "",
      "\\[",
      "\\begin{tikzcd}",
      "W \\arrow[dr] & Y",
      "\\end{tikzcd}",
      "\\]",
      "",
      "More explicitly:",
    ].join("\n");
    const out = extractTikzEnvs(input);
    // No \[ or \] should remain around the extracted env.
    expect(out).not.toContain("\\[");
    expect(out).not.toContain("\\]");
    expect(out).toContain(`<div class="tikz-placeholder"`);
    expect(out).toContain("More explicitly:");
  });

  it("strips wrapping $$ … $$ around a tikzcd env (D bug 2026-07-01)", () => {
    // The exact shape LLM returned as a fix patch that broke rendering:
    //   $$
    //   \begin{tikzcd} A \arrow[r] & B \end{tikzcd}
    //   $$
    // With the OLD code the $$…$$ wrap survived and swallowed the
    // placeholder <div>, feeding "<div class=..." into KaTeX. Now the
    // outer $$…$$ is stripped just like \[…\].
    const input = [
      "See diagram:",
      "",
      "$$",
      "\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}",
      "$$",
      "",
      "End.",
    ].join("\n");
    const out = extractTikzEnvs(input);
    // No $$ delimiters should remain around the extracted env.
    // (There may still be $$ elsewhere in a doc — we only care THIS
    // env's wrap is gone.) Since the whole input is one env only, no $$.
    expect(out).not.toMatch(/\$\$/);
    expect(out).toContain(`<div class="tikz-placeholder"`);
    expect(out).toContain("End.");
  });

  it("strips wrapping \\(…\\) inline delimiter (D bug 2026-07-01, subfish repro)", () => {
    // subfish's chat: LLM returned \(\begin{tikzcd}...\end{tikzcd}\) as a
    // fix patch. \( \) inline wrap wasn't being stripped, so after tikzcd
    // extraction the placeholder <div> sat inside \(…\) → KaTeX rendered
    // 'div class="tikz-placeholder" data-tikz-src=...' as italic math.
    const input = "\\(\\begin{tikzcd}A \\arrow[r] & B\\end{tikzcd}\\)";
    const out = extractTikzEnvs(input);
    expect(out).not.toMatch(/\\\(|\\\)/);
    expect(out).toContain(`<div class="tikz-placeholder"`);
    // And the entire tikz body should be gone from the plain text.
    expect(out).not.toContain("\\begin{tikzcd}");
  });

  it("strips wrapping $…$ inline delimiter around a tikzcd env", () => {
    const input = "$\\begin{tikzcd}A \\arrow[r] & B\\end{tikzcd}$";
    const out = extractTikzEnvs(input);
    // The single-$ pair should be gone (or at least not around the div).
    expect(out).toContain(`<div class="tikz-placeholder"`);
    // Check no `$…$` immediately wrapping the div.
    expect(out).not.toMatch(/\$[^$]*<div class="tikz-placeholder"/);
  });

  it("handles multiple tikzcd envs in one document", () => {
    const input = [
      "First:",
      "\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}",
      "",
      "Second:",
      "\\begin{tikzcd} X \\arrow[r] & Y \\end{tikzcd}",
    ].join("\n");
    const out = extractTikzEnvs(input);
    const placeholders = out.match(/class="tikz-placeholder"/g) ?? [];
    expect(placeholders).toHaveLength(2);
  });

  it("leaves NON-renderable envs (xy, dot2tex) alone", () => {
    const input = "See \\begin{xy} A \\end{xy} then \\begin{dot2tex} B \\end{dot2tex}";
    const out = extractTikzEnvs(input);
    // xy + dot2tex aren't in TIKZ_RENDERABLE_ENVS so extractor skips them
    expect(out).toContain("\\begin{xy}");
    expect(out).toContain("\\begin{dot2tex}");
    expect(out).not.toContain("tikz-placeholder");
  });

  it("also lifts tikzpicture, circuitikz, forest, chemfig", () => {
    for (const env of ["tikzpicture", "circuitikz", "forest", "chemfig"]) {
      const input = `\\begin{${env}} body \\end{${env}}`;
      const out = extractTikzEnvs(input);
      expect(out).toContain(`data-tikz-env="${env}"`);
      expect(out).not.toContain(`\\begin{${env}}`);
    }
  });

  it("base64 blob round-trips to original tikzcd source", () => {
    const original = "\\begin{tikzcd}\n  A \\arrow[r, \"f\"] & B\n\\end{tikzcd}";
    const out = extractTikzEnvs(original);
    const match = out.match(/data-tikz-src="([^"]+)"/);
    expect(match).not.toBeNull();
    const decoded = typeof atob === "function"
      ? decodeURIComponent(escape(atob(match![1])))
      : Buffer.from(match![1], "base64").toString("utf8");
    expect(decoded).toBe(original);
  });
});
