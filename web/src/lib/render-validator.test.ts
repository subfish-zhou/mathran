/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { validateRender, buildRetryPrompt, MAX_PROBLEMS } from "./render-validator";
import { ensureMarkdownConfigured } from "./markdown";

// preprocessMath runs internally; ensure the marked config side-effect fired.
ensureMarkdownConfigured();

describe("validateRender — clean inputs", () => {
  it("returns [] for empty / whitespace", () => {
    expect(validateRender("")).toEqual([]);
    expect(validateRender("   \n  ")).toEqual([]);
  });

  it("returns [] for plain prose", () => {
    expect(validateRender("Hello world. This is prose.")).toEqual([]);
  });

  it("returns [] for valid inline math", () => {
    expect(validateRender("The formula $a + b = c$ is fine.")).toEqual([]);
  });

  it("returns [] for valid display math with $$", () => {
    expect(validateRender("See:\n\n$$\n\\int_0^1 x \\, dx = 1/2\n$$\n\nEnd.")).toEqual([]);
  });

  it("returns [] for valid display math with \\[…\\]", () => {
    expect(validateRender("See:\n\n\\[\n\\sum_{i=1}^n i = n(n+1)/2\n\\]\n\nEnd.")).toEqual([]);
  });

  it("returns [] for valid \\(…\\) inline math", () => {
    expect(validateRender("Note that \\(a^2 + b^2 = c^2\\) is Pythagoras.")).toEqual([]);
  });

  it("returns [] for tikzcd — routed to server render", () => {
    // A well-formed tikzcd env is left for extractTikzEnvs / node-tikzjax;
    // validator must not flag it as broken math.
    expect(
      validateRender("\\[\n\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\n\\]"),
    ).toEqual([]);
    // Bare (no \[…\]) tikzcd — same.
    expect(
      validateRender("Diagram:\n\n\\begin{tikzcd} X \\arrow[r] & Y \\end{tikzcd}\n\nEnd."),
    ).toEqual([]);
  });

  it("returns [] for KaTeX-supported envs (pmatrix, cases, aligned)", () => {
    for (const src of [
      "$$\n\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}\n$$",
      "$$\n\\begin{cases} 1 & x > 0 \\\\ -1 & x < 0 \\end{cases}\n$$",
      "$$\n\\begin{aligned} a &= b + c \\\\ &= d \\end{aligned}\n$$",
    ]) {
      expect(validateRender(src)).toEqual([]);
    }
  });

  it("returns [] when math is inside a fenced code block", () => {
    // ```latex ... \[bad\] ... ``` — user explicitly asked for code
    // rendering, don't flag as broken.
    const src = "See the source:\n\n```latex\n\\[ \\bad{x} \\]\n```\n\nEnd.";
    expect(validateRender(src)).toEqual([]);
  });

  it("returns [] when math is inside inline code", () => {
    expect(validateRender("Escape: `$\\bad{x}$` is code.")).toEqual([]);
  });
});

describe("validateRender — broken inputs (with exact spans)", () => {
  it("flags a \\[…\\] display block with undefined control sequence", () => {
    const raw = "Before.\n\n\\[\n\\thisIsNotAKatexCommand{x}\n\\]\n\nAfter.";
    const problems = validateRender(raw);
    expect(problems.length).toBe(1);
    const p = problems[0]!;
    expect(p.kind).toBe("katex-display");
    // Verify the span points exactly at the \[…\] pattern.
    const at = raw.slice(p.span[0], p.span[1]);
    expect(at).toBe(p.matched);
    expect(at.startsWith("\\[")).toBe(true);
    expect(at.endsWith("\\]")).toBe(true);
    expect(p.body).toContain("thisIsNotAKatex");
    expect(p.message).toMatch(/undefined control sequence/i);
  });

  it("flags a $$…$$ display block", () => {
    const raw = "Try: $$\\brokenMacro{y}$$";
    const problems = validateRender(raw);
    expect(problems.length).toBe(1);
    const p = problems[0]!;
    expect(p.kind).toBe("katex-display");
    expect(raw.slice(p.span[0], p.span[1])).toBe(p.matched);
    expect(p.matched.startsWith("$$")).toBe(true);
    expect(p.matched.endsWith("$$")).toBe(true);
  });

  it("flags $…$ inline math", () => {
    const raw = "The value $\\mysteriousOp{a}$ is bad.";
    const problems = validateRender(raw);
    expect(problems.length).toBe(1);
    const p = problems[0]!;
    expect(p.kind).toBe("katex-inline");
    expect(raw.slice(p.span[0], p.span[1])).toBe(p.matched);
    expect(p.matched).toBe("$\\mysteriousOp{a}$");
  });

  it("flags \\(…\\) inline math", () => {
    const raw = "Note \\(\\evilFn{z}\\) is bad.";
    const problems = validateRender(raw);
    expect(problems.length).toBe(1);
    const p = problems[0]!;
    expect(p.kind).toBe("katex-inline");
    expect(raw.slice(p.span[0], p.span[1])).toBe(p.matched);
  });

  it("flags \\begin{xy}…\\end{xy} as unrenderable-env", () => {
    const raw = "See:\n\n\\begin{xy}\n<0mm,0mm>*+{A} =\"a\"\n\\end{xy}\n\nEnd.";
    const problems = validateRender(raw);
    expect(problems.length).toBeGreaterThanOrEqual(1);
    const p = problems.find((x) => x.kind === "unrenderable-env");
    expect(p).toBeDefined();
    expect(raw.slice(p!.span[0], p!.span[1])).toBe(p!.matched);
    expect(p!.matched.startsWith("\\begin{xy}")).toBe(true);
    expect(p!.matched.endsWith("\\end{xy}")).toBe(true);
    expect(p!.message).toContain("xy");
  });

  it("flags \\begin{dot2tex}", () => {
    const raw = "Graph:\n\n\\begin{dot2tex}\ngraph { A -- B }\n\\end{dot2tex}\n\nEnd.";
    const problems = validateRender(raw);
    const p = problems.find((x) => x.kind === "unrenderable-env");
    expect(p).toBeDefined();
    expect(p!.message).toContain("dot2tex");
  });

  it("flags multiple errors with distinct non-overlapping spans", () => {
    const raw = [
      "Good: $x = 1$",
      "Bad inline: $\\firstBad{y}$",
      "Good display:",
      "$$",
      "\\sum_i i",
      "$$",
      "Bad display:",
      "\\[",
      "\\secondBad{z}",
      "\\]",
    ].join("\n");
    const problems = validateRender(raw);
    expect(problems.length).toBe(2);
    // Sorted by span start
    expect(problems[0]!.span[0]).toBeLessThan(problems[1]!.span[0]);
    // Non-overlapping
    expect(problems[0]!.span[1]).toBeLessThanOrEqual(problems[1]!.span[0]);
    // Each span slices back to the correct matched string
    expect(raw.slice(problems[0]!.span[0], problems[0]!.span[1])).toBe(problems[0]!.matched);
    expect(raw.slice(problems[1]!.span[0], problems[1]!.span[1])).toBe(problems[1]!.matched);
  });

  it("caps problems at MAX_PROBLEMS", () => {
    // 30 bad inline formulas — capped to MAX_PROBLEMS (10).
    const many = Array.from({ length: 30 }, (_, i) => `$\\bad${i}{x}$`).join(" ");
    const problems = validateRender(many);
    expect(problems.length).toBeLessThanOrEqual(MAX_PROBLEMS);
  });

  it("does NOT flag math inside code fences", () => {
    // A fenced ```latex``` block explicitly asks for code display —
    // even broken math inside doesn't trigger a validator problem.
    const raw = "See source:\n\n```latex\n\\[ \\brokenCmd{x} \\]\n```\n\nEnd.";
    expect(validateRender(raw)).toEqual([]);
  });

  it("does NOT flag math inside inline code spans", () => {
    expect(validateRender("The literal string `$\\bad{x}$`.")).toEqual([]);
  });

  it("never throws even on garbage input", () => {
    expect(() => validateRender("$" + "\\".repeat(1000) + "$")).not.toThrow();
    expect(() => validateRender("$$\n\\end{unclosed\n$$")).not.toThrow();
    expect(() => validateRender("$\n$\n$\n$")).not.toThrow();
    expect(() => validateRender("\\begin{a}\\end{a}")).not.toThrow();
  });

  it("handles blockquoted math bodies (strips '> ' before parsing)", () => {
    // A LLM emitting math inside a blockquote — the live renderer strips
    // '> ' from each line, so the validator does the same when parsing.
    // (Well-formed math inside blockquote → no problems reported.)
    const raw = ["> \\[", "> a + b = c", "> \\]"].join("\n");
    expect(validateRender(raw)).toEqual([]);
    // Blockquoted BAD math → still flagged.
    const bad = ["> \\[", "> \\brokenCmd{x}", "> \\]"].join("\n");
    const problems = validateRender(bad);
    expect(problems.length).toBe(1);
    expect(problems[0]!.kind).toBe("katex-display");
    // Span still points at the raw \[…\] (including the '> ' prefixes)
    expect(raw.slice(problems[0]!.span[0], problems[0]!.span[1])).not.toBe(""); // just non-empty
  });
});

describe("buildRetryPrompt", () => {
  it("returns '' when no problems", () => {
    expect(buildRetryPrompt([])).toBe("");
  });

  it("formats each error with its index + matched source verbatim", () => {
    const prompt = buildRetryPrompt([
      {
        kind: "katex-display",
        span: [0, 20],
        matched: "$$ \\bad{x} $$",
        body: "\\bad{x}",
        message: "undefined control sequence \\bad",
      },
      {
        kind: "unrenderable-env",
        span: [30, 60],
        matched: "\\begin{xy} A \\end{xy}",
        body: "A",
        message: "xy is not renderable",
      },
    ]);
    expect(prompt).toContain("Error 0: display math");
    expect(prompt).toContain("Error 1: unrenderable environment");
    // Matched source is quoted verbatim in a fenced code block
    expect(prompt).toContain("$$ \\bad{x} $$");
    expect(prompt).toContain("\\begin{xy} A \\end{xy}");
    // Expects JSON reply format
    expect(prompt).toMatch(/errorIndex/);
    expect(prompt).toMatch(/replacement/);
    // Guidance covers tikzcd + latex fence advice
    expect(prompt).toContain("tikzcd");
    expect(prompt).toContain("code fences");
  });
});
