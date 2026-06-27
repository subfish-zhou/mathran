import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  ingestPaper,
  ingestCitation,
  associatePaperToProject,
  ingestSeedPapersForProject,
  getPaper,
  listPapers,
  listCitations,
  getProjectPapers,
  writePaperRaw,
  paperGraphDir,
} from "./fs-store.js";

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-pg-"));
  projectDir = path.join(workspace, "projects", "twin-primes");
  await fs.mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("paper-graph fs ingest", () => {
  it("ingests a paper and writes a node file under .mathran/paper-graph/nodes", async () => {
    const id = await ingestPaper(workspace, {
      title: "Bounded gaps between primes",
      authors: ["Yitang Zhang"],
      year: 2014,
      arxivId: "1311.1234",
      abstract: "We prove bounded gaps.",
    });
    expect(id).toBe("arxiv-1311.1234");
    const nodePath = path.join(paperGraphDir(workspace), "nodes", "arxiv-1311.1234.json");
    const raw = await fs.readFile(nodePath, "utf-8");
    const node = JSON.parse(raw);
    expect(node.title).toBe("Bounded gaps between primes");
    expect(node.url).toBe("https://arxiv.org/abs/1311.1234");
    expect(node.isSurvey).toBe(false);
  });

  it("dedupes by arxivId via the index", async () => {
    const a = await ingestPaper(workspace, { title: "P", authors: [], arxivId: "2401.00001" });
    const b = await ingestPaper(workspace, { title: "P (dup)", authors: [], arxivId: "2401.00001" });
    expect(a).toBe(b);
    const papers = await listPapers(workspace);
    expect(papers.length).toBe(1);
  });

  it("dedupes by doi", async () => {
    const a = await ingestPaper(workspace, { title: "D", authors: [], doi: "10.1000/xyz" });
    const b = await ingestPaper(workspace, { title: "D2", authors: [], doi: "10.1000/xyz" });
    expect(a).toBe(b);
    expect(a).toBe("doi-10.1000_xyz");
  });

  it("generates a uuid id when no external id is present", async () => {
    const id = await ingestPaper(workspace, { title: "X", authors: [] });
    expect(id).toMatch(/^uuid-/);
  });

  it("reads a node back via getPaper", async () => {
    const id = await ingestPaper(workspace, { title: "R", authors: ["A"], arxivId: "1234.5678" });
    const node = await getPaper(workspace, id!);
    expect(node?.title).toBe("R");
    expect(node?.authors).toEqual(["A"]);
  });

  it("returns null for a missing node", async () => {
    expect(await getPaper(workspace, "arxiv-nope")).toBeNull();
  });

  it("round-trips PaperNode with rigor and quality fields", async () => {
    const id = await ingestPaper(workspace, {
      title: "Rigor target",
      authors: ["A"],
      arxivId: "2401.99999",
    });
    const node = await getPaper(workspace, id!);
    expect(node).not.toBeNull();
    const ok = await writePaperRaw(workspace, {
      ...node!,
      rigor: {
        verdict: "trusted",
        score: 8,
        flags: [],
        pass: "fine",
        checkedAt: new Date().toISOString(),
        sourceRead: "tex",
      },
      quality: "trusted",
      citationCount: 42,
    });
    expect(ok).toBe(true);
    const reloaded = await getPaper(workspace, id!);
    expect(reloaded?.rigor?.verdict).toBe("trusted");
    expect(reloaded?.rigor?.score).toBe(8);
    expect(reloaded?.rigor?.pass).toBe("fine");
    expect(reloaded?.rigor?.sourceRead).toBe("tex");
    expect(reloaded?.quality).toBe("trusted");
    expect(reloaded?.citationCount).toBe(42);
  });

  it("loads legacy PaperNode without rigor/quality fields", async () => {
    const dir = path.join(paperGraphDir(workspace), "nodes");
    await fs.mkdir(dir, { recursive: true });
    const legacy = {
      id: "arxiv-legacy.0001",
      title: "Legacy node",
      authors: ["L"],
      isSurvey: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, "arxiv-legacy.0001.json"), JSON.stringify(legacy, null, 2));
    const node = await getPaper(workspace, "arxiv-legacy.0001");
    expect(node?.title).toBe("Legacy node");
    expect(node?.rigor).toBeUndefined();
    expect(node?.quality).toBeUndefined();
    expect(node?.citationCount).toBeUndefined();
  });
});

describe("paper-graph citations", () => {
  it("appends citation edges to citations.jsonl", async () => {
    const a = await ingestPaper(workspace, { title: "A", authors: [], arxivId: "1.1" });
    const b = await ingestPaper(workspace, { title: "B", authors: [], arxivId: "2.2" });
    expect(await ingestCitation(workspace, a!, b!, "intro")).toBe(true);
    const cites = await listCitations(workspace);
    expect(cites.length).toBe(1);
    expect(cites[0]).toMatchObject({ citingPaperId: a, citedPaperId: b, context: "intro" });
  });

  it("rejects self-citations and empty ids", async () => {
    expect(await ingestCitation(workspace, "x", "x")).toBe(false);
    expect(await ingestCitation(workspace, "", "y")).toBe(false);
  });
});

describe("paper-graph project associations", () => {
  it("associates a paper with a project and persists to associations.jsonl", async () => {
    const id = await ingestPaper(workspace, { title: "S", authors: [], arxivId: "9.9" });
    const ok = await associatePaperToProject(projectDir, id!, { relevanceScore: 1.0, discoveredBy: "seed" });
    expect(ok).toBe(true);
    const assoc = await getProjectPapers(projectDir);
    expect(assoc.length).toBe(1);
    expect(assoc[0]).toMatchObject({ paperId: id, discoveredBy: "seed", depth: 0, isExplored: false });
  });

  it("is idempotent — does not double-associate the same paper", async () => {
    const id = await ingestPaper(workspace, { title: "S2", authors: [], arxivId: "8.8" });
    await associatePaperToProject(projectDir, id!);
    await associatePaperToProject(projectDir, id!);
    const assoc = await getProjectPapers(projectDir);
    expect(assoc.length).toBe(1);
  });

  it("ingests a batch of seed papers and associates them all", async () => {
    const res = await ingestSeedPapersForProject(
      workspace,
      projectDir,
      [
        { title: "P1", authors: ["A"], arxivId: "1000.0001" },
        { title: "P2", authors: ["B"], arxivId: "1000.0002" },
      ],
      { discoveredBy: "seed" },
    );
    expect(res.failed).toBe(0);
    expect(res.ingested.length).toBe(2);
    expect(res.results.every((r) => r.associated)).toBe(true);
    const assoc = await getProjectPapers(projectDir);
    expect(assoc.length).toBe(2);
  });

  it("returns empty result for an empty seed list", async () => {
    const res = await ingestSeedPapersForProject(workspace, projectDir, []);
    expect(res).toEqual({ ingested: [], failed: 0, results: [] });
  });
});
