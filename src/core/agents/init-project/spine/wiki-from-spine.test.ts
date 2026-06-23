import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { generateWikiFromSpine, extractWorkspaceRefs } from "./wiki-from-spine.js";
import type { SpineLLM } from "./llm.js";
import type { NarrativeSpine, SpineNode, WorkspaceEffortOutput } from "./types.js";

function node(id: string, overrides: Partial<SpineNode> = {}): SpineNode {
  return {
    id,
    type: "milestone",
    title: `${id} (2010): a result`,
    year: 2010,
    authors: ["Author"],
    statement: "statement",
    significance: "significance",
    paperIds: [],
    effortIds: [],
    depth: "major",
    ...overrides,
  };
}

function spine(): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    globalThesis: "thesis",
    eras: [{ name: "Modern", startYear: 2000, endYear: 2030, summary: "s", nodeIds: ["n1"] }],
    nodes: [node("n1"), node("barrier-1", { type: "barrier" })],
    edges: [],
    threads: [{ id: "t1", name: "Thread one", description: "d", nodeIds: ["n1"], status: "active" }],
    openQuestions: [{ title: "Q", statement: "s", relatedNodeIds: ["n1"], barrier: "b", partialProgress: "p" }],
  };
}

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-wiki-"));
});
afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe("extractWorkspaceRefs", () => {
  it("extracts @ws ids", () => {
    expect(extractWorkspaceRefs("see @ws:foo-bar and @ws:baz here")).toEqual(["foo-bar", "baz"]);
  });
});

describe("generateWikiFromSpine (fs integration)", () => {
  it("writes all five default pages to <project>/wiki/*.md with frontmatter", async () => {
    const llm: SpineLLM = async () => "## Section\n\nReadable prose about the result.";
    const events: string[] = [];
    const pages = await generateWikiFromSpine(
      {
        spine: spine(),
        projectDir,
        problem: { title: "Lonely Runner", formalStatement: "...", description: "...", tags: ["geometry"] },
        paperIds: [],
      },
      llm,
      (e) => events.push(e.type),
    );

    expect(pages.map((p) => p.slug).sort()).toEqual(
      ["bibliography", "key-results", "open-problems", "overview", "techniques"],
    );
    // first page is root, rest children
    expect(pages[0]!.parentSlug).toBeUndefined();
    expect(pages[1]!.parentSlug).toBe(pages[0]!.slug);
    expect(events).toContain("wiki_page_complete");

    for (const p of pages) {
      const md = await fs.readFile(path.join(projectDir, "wiki", `${p.slug}.md`), "utf-8");
      expect(md).toContain(`slug: ${p.slug}`);
      expect(md).toContain("AI-GENERATED");
      expect(md).toContain("Readable prose");
    }
  });

  it("only regenerates the requested slugs", async () => {
    const llm: SpineLLM = async () => "## X\n\ncontent";
    const pages = await generateWikiFromSpine(
      {
        spine: spine(),
        projectDir,
        problem: { title: "LR", formalStatement: "", description: "", tags: [] },
        paperIds: [],
        onlySlugs: ["overview"],
      },
      llm,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.slug).toBe("overview");
  });

  it("strips invalid @ws refs but keeps valid effort ids", async () => {
    const efforts: WorkspaceEffortOutput[] = [
      {
        id: "thread-one",
        type: "REFERENCE",
        title: "Thread one",
        description: "",
        status: "REFERENCE",
        subject: "",
        sources: [],
        document: "",
        tags: [],
        difficultyEstimate: "MODERATE",
      },
    ];
    const llm: SpineLLM = async () => "See @ws:thread-one and @ws:Bogus2020 for details.";
    const pages = await generateWikiFromSpine(
      {
        spine: spine(),
        projectDir,
        problem: { title: "LR", formalStatement: "", description: "", tags: [] },
        paperIds: [],
        onlySlugs: ["overview"],
        workspaceEfforts: efforts,
      },
      llm,
    );
    expect(pages[0]!.content).toContain("@ws:thread-one");
    expect(pages[0]!.content).not.toContain("@ws:Bogus2020");
    expect(pages[0]!.workspaceRefs).toEqual(["thread-one"]);
  });

  it("placeholders a page when its LLM call fails (partial failure)", async () => {
    let calls = 0;
    const llm: SpineLLM = async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return "## ok\n\ncontent";
    };
    const pages = await generateWikiFromSpine(
      {
        spine: spine(),
        projectDir,
        problem: { title: "LR", formalStatement: "", description: "", tags: [] },
        paperIds: [],
      },
      llm,
    );
    expect(pages.some((p) => p.content.includes("GENERATION-FAILED"))).toBe(true);
  });
});
