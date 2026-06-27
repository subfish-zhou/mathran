import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  buildNodeTags,
  buildThreadTags,
  shouldGenerateNodeEffort,
  shouldProcessNodeInFullInit,
  generateEffortsFromSpine,
} from "./effort-from-spine.js";
import type { SpineLLM } from "./llm.js";
import { ingestPaper, associatePaperToProject } from "../../../paper-graph/index.js";
import type { NarrativeSpine, SpineNode, SpineThread } from "./types.js";

function node(overrides: Partial<SpineNode>): SpineNode {
  return {
    id: "node-1",
    type: "milestone",
    title: "Tao (2017): finite checking for the Lonely Runner Conjecture",
    year: 2017,
    authors: ["T. Tao"],
    statement: "A finite-checking reduction for integer speeds in the lonely runner problem.",
    significance: "This connects lower bounds with bounded speed computational verification.",
    proofIdea: "Compress speed sets to bounded representatives.",
    paperIds: [],
    effortIds: [],
    depth: "major",
    ...overrides,
  };
}

describe("spine effort generation helpers", () => {
  it("keeps dead-end and open-direction nodes even when marked incremental", () => {
    expect(shouldProcessNodeInFullInit(node({ type: "dead_end", depth: "incremental" }))).toBe(true);
    expect(shouldProcessNodeInFullInit(node({ type: "open_direction", depth: "incremental" }))).toBe(true);
    expect(shouldProcessNodeInFullInit(node({ type: "refinement", depth: "incremental" }))).toBe(false);
  });

  it("generates efforts for spine node classes that should be first-class workspace objects", () => {
    expect(shouldGenerateNodeEffort(node({ type: "dead_end" }))).toBe(true);
    expect(shouldGenerateNodeEffort(node({ type: "open_direction" }))).toBe(true);
    expect(shouldGenerateNodeEffort(node({ type: "foundation" }))).toBe(false);
  });

  it("builds mathematical topic tags instead of author tags", () => {
    const tags = buildNodeTags(node({}), { name: "Finite reduction and computational verification" });
    expect(tags).toContain("lonely-runner");
    expect(tags).toContain("finite-checking");
    expect(tags).not.toContain("T. Tao");
  });

  it("builds topic tags for thread survey efforts without status-only tags", () => {
    const thread: SpineThread = {
      id: "thread-1",
      name: "Shifted lonely runner and geometric variants",
      description: "Studies covering radii, shifted variants, and zonotopal geometry.",
      nodeIds: [],
      status: "dead_end",
      barrier: "Counterexamples block the shifted conjecture.",
    };
    const tags = buildThreadTags(thread);
    expect(tags).toContain("shifted-variant");
    expect(tags).toContain("covering-radius");
    expect(tags).not.toContain("dead_end");
  });
});

// ── fs integration ──────────────────────────────────────────────────────────

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-"));
  projectDir = path.join(workspace, "projects", "lr");
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function smallSpine(paperId: string): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    globalThesis: "thesis",
    eras: [{ name: "Modern", startYear: 2000, endYear: 2030, summary: "", nodeIds: ["tao-2017"] }],
    nodes: [
      node({ id: "tao-2017", title: "Tao (2017): finite checking", paperIds: [paperId] }),
      node({ id: "barrier-1", type: "barrier", title: "Bound growth barrier", paperIds: [], depth: "major" }),
    ],
    edges: [{ from: "tao-2017", to: "barrier-1", type: "reveals_barrier", context: "method limit" }],
    threads: [{ id: "finite", name: "Finite checking", description: "Bounded computation.", nodeIds: ["tao-2017"], status: "active" }],
    openQuestions: [],
  };
}

describe("generateEffortsFromSpine (fs integration)", () => {
  it("writes thread + node efforts to <project>/efforts/<id>/ and maps edges", async () => {
    const pid = await ingestPaper(workspace, { title: "Tao finite", authors: ["Tao"], year: 2017, arxivId: "1701.00009" });
    await associatePaperToProject(projectDir, pid!, { discoveredBy: "seed" });

    const llm: SpineLLM = async () => "## Survey\n\nDetailed technical content here.";
    const events: string[] = [];
    const result = await generateEffortsFromSpine(
      { spine: smallSpine(pid!), projectDir, workspace, problemTitle: "Lonely Runner", useEffortSynthesis: false },
      llm,
      (e) => events.push(e.type),
    );

    // 1 thread + 2 nodes (milestone + barrier) = 3 efforts
    expect(result.efforts.length).toBe(3);
    expect(result.efforts.some((e) => e.type === "REFERENCE")).toBe(true);
    expect(result.efforts.some((e) => e.type === "REDUCTION")).toBe(true); // barrier
    expect(events).toContain("effort_created");

    // edge tao-2017 -> barrier-1 maps to a relation between the two node efforts
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    expect(result.edges[0]!.source).toBe("spine");

    // fs: each effort wrote a document.md with frontmatter + the
    // P2-B scaffold. The LLM "Detailed technical content" is no longer
    // copied into document.md (P2-B: doc body is user's work log, not
    // a generated summary). Verify the new scaffold instead.
    for (const e of result.efforts) {
      const doc = await fs.readFile(path.join(projectDir, "efforts", e.id, "document.md"), "utf-8");
      expect(doc).toContain(`id: ${e.id}`);
      expect(doc).toContain("[Auto-generated scaffold by mathran init agent");
      expect(doc).toContain("## Work log");
      // P2-A: the effort dir now has the full layout
      for (const sub of ["references", "notes", "scratch", "files"]) {
        const stat = await fs.stat(path.join(projectDir, "efforts", e.id, sub));
        expect(stat.isDirectory()).toBe(true);
      }
    }
  });

  it("scaffolds effort dirs even when LLM call would have errored (P2-B no longer calls LLM for the doc)", async () => {
    const pid = await ingestPaper(workspace, { title: "P", authors: ["A"], year: 2010, arxivId: "1001.00001" });
    await associatePaperToProject(projectDir, pid!, { discoveredBy: "seed" });
    // P2-B: we never actually invoke `llm` for the doc anymore, so a
    // throwing LLM is irrelevant — included here as a regression
    // guard that we ARE NOT secretly still calling it.
    let llmCalls = 0;
    const llm: SpineLLM = async () => {
      llmCalls += 1;
      throw new Error("llm should not be called for effort docs");
    };
    const result = await generateEffortsFromSpine(
      { spine: smallSpine(pid!), projectDir, workspace, problemTitle: "LR", useEffortSynthesis: false },
      llm,
    );
    expect(result.efforts.length).toBe(3);
    expect(llmCalls).toBe(0);
    const threadEffort = result.efforts.find((e) => e.type === "REFERENCE")!;
    expect(threadEffort.document).toContain("Survey of");
  });
});
