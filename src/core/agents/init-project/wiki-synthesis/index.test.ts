import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { synthesizeWiki, wikiDir, wikiIndexFile } from "./index.js";
import { threePagePlan, emptySpine, fiveEffortDocs, eightPaperReads } from "./fixtures.js";
import type { SpineLLM } from "../spine/llm.js";

const problem = { title: "Goldbach", formalStatement: "every even n>2 is p+q", mathStatus: "open" };

let projectDir: string;
beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-wikisyn-"));
});
afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

function baseInput() {
  return {
    plan: threePagePlan(),
    spine: emptySpine(),
    reads: eightPaperReads(),
    effortDocuments: fiveEffortDocs(),
    problem,
    projectDir,
  };
}

describe("synthesizeWiki (fs integration)", () => {
  it("writes one .md per plan page plus _index.md and reports counts", async () => {
    const llm: SpineLLM = async () =>
      "## Section\n\nThe bound is $1/3$ per @ws:effort-1#thm-1 and @paper-read:paper-1#mainResult-1.";
    const res = await synthesizeWiki(baseInput(), { llm });

    expect(res.pagesWritten).toBe(3);
    expect(res.indexPath).toBe(wikiIndexFile(projectDir));

    const files = (await fs.readdir(wikiDir(projectDir))).sort();
    expect(files).toEqual(["_index.md", "bibliography.md", "circle-method.md", "overview.md"]);

    const overview = await fs.readFile(path.join(wikiDir(projectDir), "overview.md"), "utf-8");
    expect(overview).toContain("slug: overview");
    expect(overview).toContain("@ws:effort-1#thm-1");
  });

  it("generates pages sequentially, injecting prior-page summaries into later prompts", async () => {
    const seenPriorCounts: number[] = [];
    // The prompt lists previously-written summaries under this header; count how
    // many "[[slug]] (Title" summary lines appear in that block per call.
    const llm: SpineLLM = async (prompt) => {
      const block = prompt.split("## Pages already written")[1]?.split("## Cited efforts")[0] ?? "";
      const count = (block.match(/- \[\[/g) ?? []).length;
      seenPriorCounts.push(count);
      return "## S\n\nClaim @ws:effort-1#a and @paper-read:paper-1#mainResult-1.";
    };
    await synthesizeWiki(baseInput(), { llm });
    // page 1 sees 0 priors, page 2 sees 1, page 3 sees 2 → strictly increasing
    expect(seenPriorCounts).toEqual([0, 1, 2]);
  });

  it("produces cross-references between pages (via [[slug]] and @ws anchors)", async () => {
    const llm: SpineLLM = async (prompt) => {
      const slug = /slug: (\S+)/.exec(prompt.split("THIS PAGE")[1] ?? "")?.[1] ?? "x";
      // Each page links to overview and cites an effort.
      return `## ${slug}\n\nSee [[overview]] for context. The bound holds per @ws:effort-1#thm-1.`;
    };
    await synthesizeWiki(baseInput(), { llm });
    const circle = await fs.readFile(path.join(wikiDir(projectDir), "circle-method.md"), "utf-8");
    expect(circle).toContain("[[overview]]");
    expect(circle).toContain("@ws:effort-1#thm-1");

    const index = await fs.readFile(wikiIndexFile(projectDir), "utf-8");
    expect(index).toContain("[next →]");
    expect(index).toContain("(./circle-method.md)");
  });

  it("falls back to plan.pages order when pageOrder is empty", async () => {
    const plan = threePagePlan();
    plan.pageOrder = [];
    const llm: SpineLLM = async () => "## S\n\nClaim @ws:effort-1#a.";
    const res = await synthesizeWiki({ ...baseInput(), plan }, { llm });
    expect(res.pagesWritten).toBe(3);
  });

  it("runs the writer-reviewer loop per page when a reviewer model is supplied", async () => {
    const writerLlm: SpineLLM = async (prompt) => {
      // The rewriter prompt is distinguishable from the page-writer prompt.
      if (prompt.includes("You are the writer revising")) {
        return "## Rewritten\n\nClearer now @ws:effort-1#thm-1 and @paper-read:paper-1#mainResult-1.";
      }
      return "## Draft\n\nClaim @ws:effort-1#thm-1 and @paper-read:paper-1#mainResult-1.";
    };

    const reviewedSlugs: string[] = [];
    const reviewerLlm: SpineLLM = async (prompt) => {
      const slug = /DOCUMENT TITLE ──\n(.+)/.exec(prompt)?.[1] ?? "";
      // Reject the very first page once to force a rewrite; approve everything else.
      const firstReject = reviewedSlugs.length === 0;
      reviewedSlugs.push(slug);
      if (firstReject) {
        return JSON.stringify({
          verdict: "rewrite_requested",
          overallReaderExperience: "Confusing.",
          issues: [{ location: "p1", severity: "blocks-understanding", kind: "vague", what_you_experienced: "x", what_would_help: "y" }],
          verdict_reasoning: "needs work",
        });
      }
      return JSON.stringify({ verdict: "approve", overallReaderExperience: "Good.", issues: [], verdict_reasoning: "ok" });
    };

    const res = await synthesizeWiki(baseInput(), {
      llm: writerLlm,
      reviewerLlm,
      writerModel: "openai/gpt-5.5",
      reviewerModel: "anthropic/opus-4.8",
    });
    expect(res.pagesWritten).toBe(3);

    // The first page's persisted content reflects the rewrite.
    const order = threePagePlan().pageOrder;
    const firstPage = await fs.readFile(path.join(wikiDir(projectDir), `${order[0]}.md`), "utf-8");
    expect(firstPage).toContain("Rewritten");
    // every page was reviewed at least once
    expect(reviewedSlugs.length).toBeGreaterThanOrEqual(3);
  });

  it("skips the review loop when no reviewer model is supplied (page content unchanged)", async () => {
    const llm: SpineLLM = async () => "## Draft\n\nClaim @ws:effort-1#thm-1.";
    const res = await synthesizeWiki(baseInput(), { llm });
    expect(res.pagesWritten).toBe(3);
    expect(res.pages[0]!.content).toContain("Draft");
  });

  it("5.2: appends a Prev/Next + Related-pages nav footer to every page", async () => {
    // threePagePlan() has pageOrder: ["overview", "circle-method", "bibliography"]
    // and overview.relatedPageSlugs includes "circle-method".
    const llm: SpineLLM = async () =>
      "## S\n\nBody @ws:effort-1#thm-1 and @paper-read:paper-1#mainResult-1.";
    await synthesizeWiki(baseInput(), { llm });

    const overview = await fs.readFile(path.join(wikiDir(projectDir), "overview.md"), "utf-8");
    const circle = await fs.readFile(path.join(wikiDir(projectDir), "circle-method.md"), "utf-8");
    const biblio = await fs.readFile(path.join(wikiDir(projectDir), "bibliography.md"), "utf-8");

    // Continue-reading section exists on every page.
    expect(overview).toContain("## Continue reading");
    expect(circle).toContain("## Continue reading");
    expect(biblio).toContain("## Continue reading");

    // First page: only Next, no Previous.
    expect(overview).not.toContain("← Previous:");
    expect(overview).toContain("Next: [Title circle-method](circle-method.md) →");
    // Middle page: BOTH Prev and Next.
    expect(circle).toContain("← Previous: [Title overview](overview.md)");
    expect(circle).toContain("Next: [Title bibliography](bibliography.md) →");
    // Last page: only Previous, no Next.
    expect(biblio).toContain("← Previous: [Title circle-method](circle-method.md)");
    expect(biblio).not.toContain("Next: ");
  });
});
