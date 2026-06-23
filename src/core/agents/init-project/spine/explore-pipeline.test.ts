import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { explorePaperGraph } from "./explore-pipeline.js";
import type { SpineLLM } from "./llm.js";
import { ingestPaper, associatePaperToProject, listPapers, type PaperNode } from "../../../paper-graph/index.js";
import type { CrawledResource } from "../types.js";
import type { NeighborPaper } from "../citation-explorer.js";

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-explore-"));
  projectDir = path.join(workspace, "projects", "p");
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

const ARXIV: CrawledResource[] = [
  {
    id: "arxiv-9001.0001",
    title: "Keyword hit",
    authors: ["K"],
    year: 2020,
    sourceType: "arxiv",
    arxivId: "9001.0001",
    url: "https://arxiv.org/abs/9001.0001",
    abstract: "kw",
  },
];

const llm: SpineLLM = async () => JSON.stringify([{ index: 0, score: 9 }, { index: 1, score: 8 }]);

describe("explorePaperGraph (fs orchestrator)", () => {
  it("supplements seeds with keyword arXiv search and runs citation BFS", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "9000.0001" });
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });

    const seen: string[] = [];
    const result = await explorePaperGraph(
      {
        workspace,
        projectDir,
        seeds: [seed!],
        keywords: ["lonely runner"],
        mode: "deep",
        maxDepth: 2,
        maxPapers: 80,
        problem: { title: "LR", formalStatement: "...", tags: [] },
      },
      {
        llm,
        rateDelayMs: 0,
        searchArxiv: async (q) => {
          seen.push(q);
          return ARXIV;
        },
      },
    );

    expect(seen).toEqual(["lonely runner"]);
    const papers = await listPapers(workspace);
    expect(papers.map((p) => p.arxivId)).toContain("9001.0001");
    expect(result.discoveredPaperIds).toContain(seed);
  });

  it("honours the maxPapers cap via the citation explorer", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "9100.0001" });
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });
    let counter = 0;
    const fetchNeighbors = async (_p: PaperNode): Promise<NeighborPaper[]> => {
      const out: NeighborPaper[] = [];
      for (let i = 0; i < 15; i++) {
        counter++;
        out.push({ title: `N${counter}`, authors: ["X"], arxivId: `9100.${1000 + counter}`, direction: "reference" });
      }
      return out;
    };
    const result = await explorePaperGraph(
      {
        workspace,
        projectDir,
        seeds: [seed!],
        keywords: [],
        mode: "deep",
        maxDepth: 2,
        maxPapers: 12,
        problem: { title: "LR", formalStatement: "", tags: [] },
      },
      { llm, rateDelayMs: 0, fetchNeighbors },
    );
    expect(result.discoveredPaperIds.length).toBeLessThanOrEqual(12);
  });

  it("survives arXiv search failure (non-fatal)", async () => {
    const seed = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "9200.0001" });
    await associatePaperToProject(projectDir, seed!, { discoveredBy: "seed" });
    const result = await explorePaperGraph(
      {
        workspace,
        projectDir,
        seeds: [seed!],
        keywords: ["x"],
        mode: "deep",
        maxDepth: 2,
        maxPapers: 80,
        problem: { title: "LR", formalStatement: "", tags: [] },
      },
      {
        llm,
        rateDelayMs: 0,
        searchArxiv: async () => {
          throw new Error("arxiv down");
        },
      },
    );
    expect(result.relevantPaperIds).toContain(seed);
  });
});
