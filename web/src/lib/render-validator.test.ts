/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { validateRender, buildRetryPrompt } from "./render-validator";
import { ensureMarkdownConfigured } from "./markdown";

// Preprocess uses `preprocessMath` from markdown.ts — ensure the config
// side-effect ran so any KaTeX extension init is in place.
ensureMarkdownConfigured();

describe("validateRender — clean inputs (no errors)", () => {
  it("returns [] for empty / whitespace input", () => {
    expect(validateRender("")).toEqual([]);
    expect(validateRender("   \n  ")).toEqual([]);
  });

  it("returns [] for plain prose", () => {
    expect(validateRender("Hello world. This is a paragraph.")).toEqual([]);
  });

  it("returns [] for valid inline math", () => {
    expect(validateRender("The formula $a + b = c$ is trivial.")).toEqual([]);
  });

  it("returns [] for valid display math", () => {
    expect(
      validateRender(
        "Consider\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\nAnd we are done.",
      ),
    ).toEqual([]);
  });

  it("returns [] for a \\[…\\] block that preprocesses to $$…$$", () => {
    // preprocessMath rewrites \[…\] to $$…$$; the parser should still
    // succeed on the inner LaTeX.
    expect(
      validateRender("See:\n\n\\[\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n\\]\n\nQED."),
    ).toEqual([]);
  });

  it("returns [] for tikzcd (extracted to placeholder before scanning)", () => {
    // tikzcd is lifted to <div class=\"tikz-placeholder\"> in extractTikzEnvs,
    // so the scanner never sees it. Server-side render errors are surfaced
    // separately by /api/render/tikz.
    expect(
      validateRender(
        "Diagram:\n\n\\[\n\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\n\\]\n\nExplanation.",
      ),
    ).toEqual([]);
  });

  it("returns [] for KaTeX-supported envs (pmatrix, aligned, cases)", () => {
    const clean = String.raw`
$$
\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}
$$
`;
    expect(validateRender(clean)).toEqual([]);
  });
});

describe("validateRender — broken inputs (should surface problems)", () => {
  it("flags undefined control sequence in display math", () => {
    const bad = "See:\n\n$$\n\\thisIsNotAKatexCommand{x}\n$$\n\nEnd.";
    const problems = validateRender(bad);
    expect(problems.length).toBeGreaterThan(0);
    const p = problems[0]!;
    expect(p.kind).toBe("katex-display");
    expect(p.message).toMatch(/undefined control sequence|Undefined control sequence/i);
    expect(p.snippet).toContain("thisIsNotAKatex");
  });

  it("flags undefined control sequence in inline math", () => {
    const bad = "The value $\\mysteriousOp{a,b}$ is undefined.";
    const problems = validateRender(bad);
    expect(problems.length).toBeGreaterThan(0);
    const p = problems.find((x) => x.kind === "katex-inline");
    expect(p).toBeDefined();
    expect(p!.message).toMatch(/undefined control sequence/i);
  });

  it("flags \\begin{xy} as unrenderable-env (not in tikz whitelist)", () => {
    const bad = "See:\n\n\\begin{xy}\n<0mm,0mm>*+{A} =\"a\"\n\\end{xy}\n\nEnd.";
    const problems = validateRender(bad);
    const p = problems.find((x) => x.kind === "unrenderable-env");
    expect(p).toBeDefined();
    expect(p!.message).toContain("xy");
  });

  it("flags \\begin{dot2tex}", () => {
    const bad = "\\begin{dot2tex} graph { A -- B } \\end{dot2tex}";
    const problems = validateRender(bad);
    const p = problems.find((x) => x.kind === "unrenderable-env");
    expect(p).toBeDefined();
    expect(p!.message).toContain("dot2tex");
  });

  it("caps problems at MAX_PROBLEMS (10) even for a wall of bad math", () => {
    // 30 bad inline formulas — should be truncated to 10.
    const many = Array.from({ length: 30 }, (_, i) => `$\\bad${i}{x}$`).join(" ");
    const problems = validateRender(many);
    expect(problems.length).toBeLessThanOrEqual(10);
  });

  it("mixes good + bad math correctly (only bad returned)", () => {
    const mixed = [
      "Good: $a + b = c$",
      "Bad: $\\undefinedCmd{x}$",
      "",
      "Good display:",
      "",
      "$$",
      "\\int_0^1 dx = 1",
      "$$",
      "",
      "Bad display:",
      "",
      "$$",
      "\\anotherBad{y}",
      "$$",
    ].join("\n");
    const problems = validateRender(mixed);
    expect(problems.length).toBe(2);
    expect(problems.every((p) => p.snippet.includes("Bad") || p.snippet.includes("undefined") || p.snippet.includes("another"))).toBe(true);
  });

  it("never throws even on garbage input", () => {
    // Deliberately weird strings.
    expect(() => validateRender("$" + "\\".repeat(1000) + "$")).not.toThrow();
    expect(() => validateRender("$$\n\\end{unclosed\n$$")).not.toThrow();
    expect(() => validateRender("$\n$\n$\n$")).not.toThrow();
  });
});

describe("buildRetryPrompt", () => {
  it("returns '' when no problems", () => {
    expect(buildRetryPrompt([])).toBe("");
  });

  it("formats problems into a self-contained retry message", () => {
    const prompt = buildRetryPrompt([
      { kind: "katex-display", snippet: "\\bad{x}", message: "undefined control sequence \\bad" },
      { kind: "unrenderable-env", snippet: "\\begin{xy}", message: "xy is not renderable" },
    ]);
    expect(prompt).toContain("previous reply had render errors");
    expect(prompt).toContain("display math");
    expect(prompt).toContain("unsupported environment");
    expect(prompt).toContain("\\bad{x}");
    expect(prompt).toContain("\\begin{xy}");
    expect(prompt).toContain("KaTeX-supported");
    expect(prompt).toContain("tikzcd"); // guidance mentions the right escape
  });

  it("escapes backticks in snippets to avoid breaking the markdown code span", () => {
    // The snippet itself might contain backticks (LLM emits code in
    // math? edge case). Ensure they get transformed so the prompt stays
    // well-formed markdown.
    const prompt = buildRetryPrompt([
      { kind: "katex-inline", snippet: "a `code` b", message: "err" },
    ]);
    expect(prompt).toContain("a 'code' b"); // backtick → single quote
    expect(prompt).not.toMatch(/`a `code`/); // no un-terminated code span
  });
});
