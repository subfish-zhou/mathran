import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { buildSpine, readSpine } from "./builder.js";
import type { SpineLLM } from "./llm.js";
import { ingestPaper, associatePaperToProject } from "../../../paper-graph/index.js";

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-spine-"));
  projectDir = path.join(workspace, "projects", "lonely-runner");
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/** Fake spine LLM: routes node-extraction vs structure-assembly by prompt content. */
function fakeLlm(): SpineLLM {
  return async (prompt) => {
    if (prompt.includes("extracting key mathematical contributions")) {
      return JSON.stringify({
        nodes: [
          {
            id: "dirichlet-1842",
            type: "foundation",
            title: "Dirichlet (1842): simultaneous approximation",
            year: 1842,
            authors: ["Dirichlet"],
            statement: "For reals there exist good rational approximations.",
            significance: "Foundational pigeonhole bound for the lonely runner.",
            paper_ids: ["__P0__"],
            depth: "foundational",
            suggested_edges: [],
          },
          {
            id: "tao-2017",
            type: "milestone",
            title: "Tao (2017): finite checking",
            year: 2017,
            authors: ["Tao"],
            statement: "A finite-checking reduction for integer speeds.",
            significance: "Reduces the conjecture to a bounded computation.",
            paper_ids: ["__P1__"],
            depth: "major",
            suggested_edges: [{ target: "dirichlet-1842", type: "applies_technique", context: "builds on pigeonhole" }],
          },
        ],
      });
    }
    // structure assembly
    return JSON.stringify({
      global_thesis: "The lonely runner conjecture sits between geometry and number theory.",
      eras: [
        { name: "Classical (1800-2000)", start_year: 1800, end_year: 2000, summary: "Foundations.", node_ids: ["dirichlet-1842"] },
        { name: "Modern (2000-)", start_year: 2000, end_year: 2030, summary: "Computational era.", node_ids: ["tao-2017"] },
      ],
      edges: [{ from: "dirichlet-1842", to: "tao-2017", type: "enables", context: "foundation enables reduction" }],
      threads: [
        { id: "finite-checking", name: "Finite checking", description: "Bounded computation.", node_ids: ["tao-2017"], status: "active" },
      ],
      open_questions: [
        { title: "Full LRC", statement: "Every n speeds yield a lonely moment.", related_node_ids: ["tao-2017"], barrier: "Bounds grow.", partial_progress: "Verified small n." },
      ],
    });
  };
}

describe("buildSpine (fs integration)", () => {
  it("builds, validates and persists a spine to .mathran/spine/spine.json", async () => {
    const p0 = await ingestPaper(workspace, { title: "Dirichlet paper", authors: ["Dirichlet"], year: 1842, arxivId: "0000.00000" });
    const p1 = await ingestPaper(workspace, { title: "Tao finite checking", authors: ["Tao"], year: 2017, arxivId: "1701.00001" });
    expect(p0 && p1).toBeTruthy();
    await associatePaperToProject(projectDir, p0!, { discoveredBy: "seed" });
    await associatePaperToProject(projectDir, p1!, { discoveredBy: "crawl" });

    // Map placeholder ids in the fake reply to the real node ids.
    const llm: SpineLLM = async (prompt) => {
      const base = await fakeLlm()(prompt);
      return base.replace("__P0__", p0!).replace("__P1__", p1!);
    };

    const events: string[] = [];
    const spine = await buildSpine(
      {
        projectDir,
        workspace,
        paperIds: [p0!, p1!],
        mode: "full",
        problem: { title: "Lonely Runner", formalStatement: "...", description: "...", tags: ["geometry"] },
      },
      llm,
      (e) => events.push(e.type),
    );

    expect(spine.nodes).toHaveLength(2);
    expect(spine.nodes.map((n) => n.id).sort()).toEqual(["dirichlet-1842", "tao-2017"]);
    expect(spine.edges.length).toBeGreaterThanOrEqual(1);
    expect(spine.threads).toHaveLength(1);
    expect(spine.openQuestions).toHaveLength(1);
    expect(spine.globalThesis).toContain("lonely runner");
    // every node lands in an era after validation
    const eraNodeIds = new Set(spine.eras.flatMap((e) => e.nodeIds));
    expect(eraNodeIds.has("dirichlet-1842")).toBe(true);
    expect(eraNodeIds.has("tao-2017")).toBe(true);
    // paperIds filtered to valid set
    expect(spine.nodes.every((n) => n.paperIds.every((id) => [p0, p1].includes(id)))).toBe(true);

    expect(events).toContain("spine_assembled");

    const persisted = await readSpine(projectDir);
    expect(persisted?.nodes).toHaveLength(2);
  });

  it("returns an empty spine when no candidates are extracted", async () => {
    const emptyLlm: SpineLLM = async () => "no json here";
    const spine = await buildSpine(
      {
        projectDir,
        workspace,
        paperIds: [],
        mode: "full",
        problem: { title: "Empty", formalStatement: "", description: "", tags: [] },
      },
      emptyLlm,
    );
    expect(spine.nodes).toHaveLength(0);
    const persisted = await readSpine(projectDir);
    expect(persisted).not.toBeNull();
  });
});
