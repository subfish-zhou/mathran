/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { applyPatches, type Patch } from "./render-patch";
import type { RenderProblem } from "./render-validator";

function mkProblem(overrides: Partial<RenderProblem> & { span: [number, number]; matched: string }): RenderProblem {
  return {
    kind: "katex-inline",
    body: overrides.matched,
    message: "err",
    ...overrides,
  } as RenderProblem;
}

describe("applyPatches", () => {
  it("returns unchanged text when no problems", () => {
    const result = applyPatches("hello world", [], []);
    expect(result.patched).toBe("hello world");
    expect(result.applied).toBe(0);
    expect(result.skippedIndices).toEqual([]);
  });

  it("returns unchanged text when problems have no matching patches", () => {
    const raw = "The formula $x$ is bad.";
    const problems = [mkProblem({ span: [12, 15], matched: "$x$" })];
    const result = applyPatches(raw, problems, []);
    expect(result.patched).toBe(raw);
    expect(result.applied).toBe(0);
    expect(result.skippedIndices).toEqual([0]);
  });

  it("applies a single patch by span-splicing", () => {
    const raw = "The formula $\\bad{x}$ is wrong.";
    const problems = [mkProblem({ span: [12, 21], matched: "$\\bad{x}$" })];
    const patches: Patch[] = [{ errorIndex: 0, replacement: "$x + 1$" }];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe("The formula $x + 1$ is wrong.");
    expect(result.applied).toBe(1);
    expect(result.skippedIndices).toEqual([]);
  });

  it("applies MULTIPLE patches in reverse span order (no shift)", () => {
    // Two bad formulas — apply both, verify spans didn't shift.
    const raw = "First $\\bad1$ and then $\\bad2$ done.";
    // Find spans by index (mimicking the validator)
    const s1 = raw.indexOf("$\\bad1$");
    const e1 = s1 + "$\\bad1$".length;
    const s2 = raw.indexOf("$\\bad2$");
    const e2 = s2 + "$\\bad2$".length;
    const problems = [
      mkProblem({ span: [s1, e1], matched: "$\\bad1$" }),
      mkProblem({ span: [s2, e2], matched: "$\\bad2$" }),
    ];
    const patches: Patch[] = [
      { errorIndex: 0, replacement: "$a$" },
      { errorIndex: 1, replacement: "$b$" },
    ];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe("First $a$ and then $b$ done.");
    expect(result.applied).toBe(2);
  });

  it("applies replacements of different lengths correctly (grows and shrinks)", () => {
    // First patch REPLACES a short span with a long one, second replaces
    // long with short — reverse-order apply must handle both.
    const raw = "A $x$ B $\\longThingHere$ C";
    const s1 = raw.indexOf("$x$");
    const e1 = s1 + "$x$".length;
    const s2 = raw.indexOf("$\\longThingHere$");
    const e2 = s2 + "$\\longThingHere$".length;
    const problems = [
      mkProblem({ span: [s1, e1], matched: "$x$" }),
      mkProblem({ span: [s2, e2], matched: "$\\longThingHere$" }),
    ];
    const patches: Patch[] = [
      { errorIndex: 0, replacement: "$\\alpha + \\beta$" }, // grows
      { errorIndex: 1, replacement: "$y$" },              // shrinks
    ];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe("A $\\alpha + \\beta$ B $y$ C");
    expect(result.applied).toBe(2);
  });

  it("skips patches for unknown errorIndex", () => {
    const raw = "$x$";
    const problems = [mkProblem({ span: [0, 3], matched: "$x$" })];
    const patches: Patch[] = [
      { errorIndex: 5, replacement: "should be ignored" },
      { errorIndex: -1, replacement: "should be ignored" },
    ];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe("$x$");
    expect(result.applied).toBe(0);
    expect(result.skippedIndices).toEqual([0]);
  });

  it("last-wins on duplicate errorIndex", () => {
    const raw = "$x$";
    const problems = [mkProblem({ span: [0, 3], matched: "$x$" })];
    const patches: Patch[] = [
      { errorIndex: 0, replacement: "$FIRST$" },
      { errorIndex: 0, replacement: "$SECOND$" },
    ];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe("$SECOND$");
    expect(result.applied).toBe(1);
  });

  it("skips a patch when the span no longer matches (drift)", () => {
    const raw = "$x$ different now $y$";
    // Problem claims span [0,3] is "$FOO$" — but at [0,3] we actually
    // have "$x$", so the patch must be skipped to avoid corruption.
    const problems = [mkProblem({ span: [0, 3], matched: "$FOO$" })];
    const patches: Patch[] = [{ errorIndex: 0, replacement: "$fixed$" }];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe(raw); // untouched
    expect(result.applied).toBe(0);
    expect(result.skippedIndices).toEqual([0]);
  });

  it("partial success: applies patches for some errors, skips others", () => {
    const raw = "$a$ $b$ $c$";
    const problems = [
      mkProblem({ span: [0, 3], matched: "$a$" }),
      mkProblem({ span: [4, 7], matched: "$b$" }),
      mkProblem({ span: [8, 11], matched: "$c$" }),
    ];
    // Only patch the middle one.
    const patches: Patch[] = [{ errorIndex: 1, replacement: "$B$" }];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe("$a$ $B$ $c$");
    expect(result.applied).toBe(1);
    expect(result.skippedIndices).toEqual([0, 2]);
  });

  it("handles empty replacement (deletes the matched text)", () => {
    const raw = "keep this $\\bad$ and this";
    const problems = [mkProblem({ span: [10, 16], matched: "$\\bad$" })];
    const patches: Patch[] = [{ errorIndex: 0, replacement: "" }];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe("keep this  and this");
    expect(result.applied).toBe(1);
  });

  it("handles multiline / tikz replacement", () => {
    const raw = "See:\n\n\\begin{xy}\nA\n\\end{xy}\n\nEnd.";
    const s = raw.indexOf("\\begin{xy}");
    const e = raw.indexOf("\\end{xy}") + "\\end{xy}".length;
    const problems = [mkProblem({ kind: "unrenderable-env", span: [s, e], matched: raw.slice(s, e) })];
    const patches: Patch[] = [
      { errorIndex: 0, replacement: "\\[\n\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\n\\]" },
    ];
    const result = applyPatches(raw, problems, patches);
    expect(result.patched).toBe(
      "See:\n\n\\[\n\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\n\\]\n\nEnd.",
    );
    expect(result.applied).toBe(1);
  });
});
