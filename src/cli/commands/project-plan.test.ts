import { describe, expect, it } from "vitest";

import { renderPlanBox, seedsToArg, confirmProceed } from "./project-plan.js";
import type { PlanAgentResult } from "../../core/agents/plan/index.js";

describe("renderPlanBox", () => {
  it("renders a SINGLE result with seeds", () => {
    const result: PlanAgentResult = {
      status: "single",
      references: [],
      problem: {
        title: "Binary Goldbach Conjecture",
        formalStatement: "Every even n > 2 is a sum of two primes.",
        description: "Posed 1742.",
        background: "Chen proved (1+2) in 1966.",
        tags: ["Analytic Number Theory", "Sieve Theory"],
        mscCodes: ["11P32"],
        mathStatus: "OPEN",
      },
      suggestedSeeds: [
        {
          arxivId: "2606.05224",
          title: "Theorem (1+1.9) on Goldbach",
          authors: ["Li", "Liu"],
          why: "recent landmark",
          topicalFit: 0.9,
          recencyScore: 0.95,
        },
      ],
    };
    const box = renderPlanBox(result);
    expect(box).toContain("Status: SINGLE problem");
    expect(box).toContain("Binary Goldbach Conjecture");
    expect(box).toContain("11P32");
    expect(box).toContain("arXiv:2606.05224");
    expect(box.startsWith("╭")).toBe(true);
    expect(box.trimEnd().endsWith("╯")).toBe(true);
  });

  it("renders a MULTIPLE result", () => {
    const box = renderPlanBox({
      status: "multiple",
      references: [],
      candidates: [
        { title: "Strong Goldbach", description: "even = p+p" },
        { title: "Weak Goldbach", description: "odd = p+p+p" },
      ],
    });
    expect(box).toContain("MULTIPLE candidates");
    expect(box).toContain("Strong Goldbach");
  });

  it("renders an INSUFFICIENT result", () => {
    const box = renderPlanBox({
      status: "insufficient",
      references: [],
      suggestions: ["Pick a specific sub-problem."],
    });
    expect(box).toContain("INSUFFICIENT");
    expect(box).toContain("Pick a specific sub-problem.");
  });
});

describe("seedsToArg", () => {
  it("joins arxiv ids with commas", () => {
    expect(
      seedsToArg([
        { arxivId: "1", title: "a", authors: [], why: "", topicalFit: 0, recencyScore: 0 },
        { arxivId: "2", title: "b", authors: [], why: "", topicalFit: 0, recencyScore: 0 },
      ]),
    ).toBe("1,2");
  });
  it("handles undefined", () => {
    expect(seedsToArg(undefined)).toBe("");
  });
});

describe("confirmProceed", () => {
  it("defaults to yes when stdin is not a TTY", async () => {
    const orig = process.stdin.isTTY;
    // Force non-TTY for the duration of this assertion.
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(confirmProceed("? ")).resolves.toBe("yes");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  });
});
