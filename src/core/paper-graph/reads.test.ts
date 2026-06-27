import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  getPaperRead,
  writePaperRead,
  deletePaperRead,
  listPaperReads,
  hasFreshPaperRead,
} from "./reads.js";
import type { PaperRead } from "./types.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-reads-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function makeRead(paperId: string, overrides: Partial<PaperRead> = {}): PaperRead {
  const now = new Date().toISOString();
  return {
    paperId,
    arxivId: "1311.1234",
    doi: "10.1000/xyz",
    sourceKind: "tex",
    sourceBytes: 123456,
    sourcePath: ".mathran/arxiv-cache/1311.1234/main.tex",
    truncated: false,
    skim: {
      oneLineSummary: "Bounded gaps between primes.",
      mainContribution: "Establishes a finite bound on infinitely many prime gaps.",
      sectionOutline: [
        { level: 1, title: "Introduction" },
        { level: 2, title: "The GPY method" },
        { level: 3, title: "Type II sums" },
      ],
      decision: "study",
      decisionReason: "Foundational milestone for the project.",
    },
    read: {
      mainResults: [
        {
          label: "Theorem 1.1",
          statement: "\\liminf_{n} (p_{n+1} - p_n) < 7 \\times 10^7",
          whereInPaper: "§1, p. 2",
          noveltyVsPrior: "First unconditional finite bound.",
        },
      ],
      proofStrategy: "Sieve weights tuned via the GPY construction, bounded with Type I/II sums.",
      keyTechniques: [{ name: "large sieve", role: "Bounds Type II sums" }],
      technicalDependencies: [
        { claim: "Bombieri-Vinogradov", source: "Bombieri 1965", whereUsed: "Lemma 2.4" },
      ],
      novelContributions: "A smoothed admissible tuple argument.",
      standardMaterial: "Classical sieve theory.",
      hardSteps: ["The Type II sum estimate in §5."],
      role: "milestone",
    },
    audit: {
      verdict: "trusted",
      score: 9,
      flags: [],
      reason: "Peer-reviewed; widely cited.",
      pass: "fine",
      checkedAt: now,
      sourceRead: "tex",
    },
    outgoingCitations: [
      {
        citedTitle: "Primes in tuples I",
        citedAuthors: ["Goldston", "Pintz", "Yildirim"],
        citedYear: 2009,
        citedArxivId: "math/0508185",
        contextInThisPaper: "Foundational method extended here.",
        importanceToThisPaper: "essential",
      },
    ],
    isSurvey: false,
    surveyDistillation: {
      coveredSubAreas: ["minor arc estimates"],
      keyReferences: [
        {
          author: "Tao",
          year: 2012,
          title: "Every odd number is the sum of primes",
          arxivId: "1201.6656",
          whyTheSurveyHighlighted: "Demonstrates the circle method.",
        },
      ],
      surveyAuthorOpinion: "The author argues sieve theory has hit a barrier.",
      surveyOutline: [{ heading: "Background", summary: "History of prime gaps." }],
    },
    modelUsed: "anthropic/claude-sonnet-4",
    promptVersion: "v1",
    passesCompleted: ["skim", "read", "audit"],
    totalLlmCalls: 3,
    totalTokensIn: 12000,
    totalTokensOut: 3400,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("paper-graph PaperRead persistence", () => {
  it("round-trips PaperRead with full body and audit", async () => {
    const read = makeRead("arxiv-1311.1234");
    await writePaperRead(workspace, read);
    const reloaded = await getPaperRead(workspace, "arxiv-1311.1234");
    expect(reloaded).toEqual(read);
  });

  it("getPaperRead returns null when reads/<id>.json is absent", async () => {
    expect(await getPaperRead(workspace, "arxiv-missing")).toBeNull();
  });

  it("hasFreshPaperRead returns true on matching model+promptVersion, false otherwise", async () => {
    const read = makeRead("arxiv-1311.1234", { modelUsed: "m1", promptVersion: "v2" });
    await writePaperRead(workspace, read);
    expect(await hasFreshPaperRead(workspace, "arxiv-1311.1234", "m1", "v2")).toBe(true);
    expect(await hasFreshPaperRead(workspace, "arxiv-1311.1234", "m1", "v3")).toBe(false);
    expect(await hasFreshPaperRead(workspace, "arxiv-1311.1234", "m2", "v2")).toBe(false);
    expect(await hasFreshPaperRead(workspace, "arxiv-absent", "m1", "v2")).toBe(false);
  });

  it("deletePaperRead removes the file and is idempotent", async () => {
    await writePaperRead(workspace, makeRead("arxiv-del"));
    expect(await getPaperRead(workspace, "arxiv-del")).not.toBeNull();
    await deletePaperRead(workspace, "arxiv-del");
    expect(await getPaperRead(workspace, "arxiv-del")).toBeNull();
    // idempotent — deleting a non-existent read does not throw
    await deletePaperRead(workspace, "arxiv-del");
    await deletePaperRead(workspace, "arxiv-never-existed");
  });

  it("listPaperReads enumerates all paperIds with persisted reads", async () => {
    await writePaperRead(workspace, makeRead("arxiv-1"));
    await writePaperRead(workspace, makeRead("arxiv-2"));
    await writePaperRead(workspace, makeRead("doi-10.1000_z"));
    const ids = await listPaperReads(workspace);
    expect(ids.sort()).toEqual(["arxiv-1", "arxiv-2", "doi-10.1000_z"]);
  });

  it("listPaperReads returns empty array when reads/ does not exist", async () => {
    expect(await listPaperReads(workspace)).toEqual([]);
  });
});
