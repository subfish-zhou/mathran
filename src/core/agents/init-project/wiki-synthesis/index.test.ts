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
});
