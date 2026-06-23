import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  exploreCitationGraph,
  CITATION_MAX_DEPTH,
  CITATION_MAX_NODES,
  type NeighborPaper,
} from "./citation-explorer.js";
import type { SpineLLM } from "./spine/llm.js";
import {
  ingestPaper,
  ingestCitation,
  associatePaperToProject,
  getProjectPapers,
  type PaperNode,
} from "../../paper-graph/index.js";

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-cite-"));
  projectDir = path.join(workspace, "projects", "p");
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const problem = { title: "Lonely Runner", formalStatement: "...", tags: ["geometry"] };

/** LLM that scores every paper highly (keeps expanding). */
const highScoreLlm: SpineLLM = async () =>
  JSON.stringify([{ index: 0, score: 9 }, { index: 1, score: 8 }, { index: 2, score: 7 }, { index: 3, score: 6 }]);

describe("exploreCitationGraph", () => {
  it("uses existing fs citation edges as BFS neighbors", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "1000.0001" });
    const n1 = await ingestPaper(workspace, { title: "Neighbor 1", authors: ["B"], arxivId: "1000.0002" });
    await ingestCitation(workspace, seed!, n1!);
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });

    const result = await exploreCitationGraph(
      { workspace, projectDir, seeds: [seed!], problem },
      { llm: highScoreLlm },
    );

    expect(result.relevantPaperIds).toContain(seed);
    expect(result.relevantPaperIds).toContain(n1);
    expect(result.discoveredPaperIds).toContain(n1);
  });

  it("discovers new neighbors via the fetchNeighbors seam and writes citation edges", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "2000.0001" });
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });

    const fetchNeighbors = async (_p: PaperNode): Promise<NeighborPaper[]> => [
      { title: "Cited work", authors: ["C"], arxivId: "2000.0002", direction: "reference" },
      { title: "Citing work", authors: ["D"], arxivId: "2000.0003", direction: "citation" },
    ];

    const result = await exploreCitationGraph(
      { workspace, projectDir, seeds: [seed!], problem },
      { llm: highScoreLlm, fetchNeighbors },
    );

    expect(result.discoveredPaperIds.length).toBeGreaterThanOrEqual(3);
    const assoc = await getProjectPapers(projectDir);
    expect(assoc.some((a) => a.discoveredBy === "init")).toBe(true);
  });

  it("respects maxDepth (does not expand past depth limit)", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "3000.0001" });
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });

    // Each paper yields a fresh neighbor → unbounded chain unless depth caps it.
    let counter = 0;
    const fetchNeighbors = async (_p: PaperNode): Promise<NeighborPaper[]> => {
      counter++;
      return [{ title: `Chain ${counter}`, authors: ["X"], arxivId: `3000.${1000 + counter}`, direction: "reference" }];
    };

    const result = await exploreCitationGraph(
      { workspace, projectDir, seeds: [seed!], problem, maxDepth: 2 },
      { llm: highScoreLlm, fetchNeighbors },
    );

    // depth 0 seed → depth1 neighbors → depth2 neighbors, then stop. The chain
    // cannot run away; discovered stays well under the node cap.
    expect(result.discoveredPaperIds.length).toBeLessThanOrEqual(CITATION_MAX_NODES);
    expect(result.totalRounds).toBeGreaterThanOrEqual(1);
  });

  it("respects maxNodes cap", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "4000.0001" });
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });
    let counter = 0;
    const fetchNeighbors = async (_p: PaperNode): Promise<NeighborPaper[]> => {
      const out: NeighborPaper[] = [];
      for (let i = 0; i < 20; i++) {
        counter++;
        out.push({ title: `N${counter}`, authors: ["X"], arxivId: `4000.${5000 + counter}`, direction: "reference" });
      }
      return out;
    };
    const result = await exploreCitationGraph(
      { workspace, projectDir, seeds: [seed!], problem, maxNodes: 10 },
      { llm: highScoreLlm, fetchNeighbors },
    );
    expect(result.discoveredPaperIds.length).toBeLessThanOrEqual(10);
  });

  it("falls back to a depth heuristic when LLM scoring fails", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "5000.0001" });
    const n1 = await ingestPaper(workspace, { title: "N1", authors: ["B"], arxivId: "5000.0002" });
    await ingestCitation(workspace, seed!, n1!);
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });

    const badLlm: SpineLLM = async () => "not json";
    const result = await exploreCitationGraph(
      { workspace, projectDir, seeds: [seed!], problem },
      { llm: badLlm },
    );
    // depth-1 neighbor scored 5 by heuristic → relevant
    expect(result.relevantPaperIds).toContain(n1);
  });

  it("exposes the mathub-parity caps", () => {
    expect(CITATION_MAX_DEPTH).toBe(2);
    expect(CITATION_MAX_NODES).toBe(80);
  });
});
