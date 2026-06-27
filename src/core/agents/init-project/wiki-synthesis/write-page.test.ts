import { describe, expect, it } from "vitest";

import {
  writeWikiPage,
  extractWorkspaceRefs,
  extractPaperReadRefs,
  countCitationAnchors,
} from "./write-page.js";
import { buildWikiPageWritePrompt } from "./prompts.js";
import { threePagePlan, emptySpine, fiveEffortDocs, eightPaperReads } from "./fixtures.js";
import type { SpineLLM } from "../spine/llm.js";

const problem = { title: "Goldbach", formalStatement: "every even n>2 is p+q", mathStatus: "open" };

function baseInput(pageIndex: number) {
  return {
    plan: threePagePlan(),
    pageIndex,
    spine: emptySpine(),
    reads: eightPaperReads(),
    effortDocuments: fiveEffortDocs(),
    previouslyWrittenPageSummaries: [],
    problem,
  };
}

describe("citation-anchor helpers", () => {
  it("extracts @ws ids (with and without #anchor)", () => {
    expect(extractWorkspaceRefs("see @ws:foo-bar#sec-1 and @ws:baz here")).toEqual(["foo-bar", "baz"]);
  });

  it("extracts @paper-read ids", () => {
    expect(extractPaperReadRefs("from @paper-read:1234.5678#mainResult-2 we get")).toEqual(["1234.5678"]);
  });

  it("counts all citation anchors", () => {
    const c = "x @ws:e1#a y @ws:e2 z @paper-read:p1#mainResult-1";
    expect(countCitationAnchors(c)).toBe(3);
  });
});

describe("buildWikiPageWritePrompt", () => {
  it("includes page spec, sibling plan, cited efforts and reads, and citation rules", () => {
    const plan = threePagePlan();
    const prompt = buildWikiPageWritePrompt({
      plan,
      page: plan.pages[1]!, // circle-method
      spine: emptySpine(),
      reads: eightPaperReads(),
      effortDocuments: fiveEffortDocs(),
      previouslyWrittenPageSummaries: [{ slug: "overview", title: "Title overview", summary: "intro summary" }],
      problem,
    });
    // page spec
    expect(prompt).toContain("slug: circle-method");
    expect(prompt).toContain("circle-method Section A");
    // siblings (plan summary lists all three)
    expect(prompt).toContain("[[overview]]");
    expect(prompt).toContain("[[bibliography]]");
    // previously written summary injected
    expect(prompt).toContain("intro summary");
    // cited effort document content
    expect(prompt).toContain("### @ws:effort-3");
    expect(prompt).toContain("B_3");
    // cited paper-read anchors offered
    expect(prompt).toContain("@paper-read:paper-3#mainResult-1");
    // hard citation rule present
    expect(prompt).toContain("@ws:<effort-id>#<anchor>");
    expect(prompt).toContain("@paper-read:<paper-id>#mainResult-N");
  });

  it("truncates effort documents when combined size exceeds the budget", () => {
    const huge = new Map<string, string>([
      ["effort-3", "A".repeat(40_000)],
      ["effort-4", "B".repeat(40_000)],
    ]);
    const plan = threePagePlan();
    const prompt = buildWikiPageWritePrompt({
      plan,
      page: plan.pages[1]!,
      spine: emptySpine(),
      reads: [],
      effortDocuments: huge,
      previouslyWrittenPageSummaries: [],
      problem,
    });
    expect(prompt).toContain("(truncated)");
  });
});

describe("writeWikiPage", () => {
  it("returns slug/title from the plan and extracts workspace refs", async () => {
    const llm: SpineLLM = async () =>
      "## Overview\n\nThe bound is $1/2$ per @ws:effort-1#thm-1 and @paper-read:paper-2#mainResult-1.";
    const res = await writeWikiPage(baseInput(0), { llm });
    expect(res.slug).toBe("overview");
    expect(res.title).toBe("Title overview");
    expect(res.workspaceRefs).toContain("effort-1");
    expect(res.content).not.toContain("NEEDS-CITATIONS");
  });

  it("stamps a review banner when the page has no citation anchors", async () => {
    const llm: SpineLLM = async () => "## Overview\n\nThis page improved the bound but cites nothing.";
    const res = await writeWikiPage(baseInput(0), { llm });
    expect(res.content).toContain("NEEDS-CITATIONS");
  });

  it("strips a wrapping markdown code fence", async () => {
    const llm: SpineLLM = async () => "```markdown\n## H\n\nBody @ws:effort-1#a.\n```";
    const res = await writeWikiPage(baseInput(0), { llm });
    expect(res.content.startsWith("## H")).toBe(true);
  });

  it("returns a placeholder (does not throw) when the LLM fails", async () => {
    const llm: SpineLLM = async () => {
      throw new Error("boom");
    };
    const res = await writeWikiPage(baseInput(0), { llm });
    expect(res.content).toContain("GENERATION-FAILED");
    expect(res.workspaceRefs).toEqual([]);
  });

  it("throws on an out-of-range pageIndex", async () => {
    const llm: SpineLLM = async () => "x";
    await expect(writeWikiPage(baseInput(99), { llm })).rejects.toThrow(/out of range/);
  });
});
