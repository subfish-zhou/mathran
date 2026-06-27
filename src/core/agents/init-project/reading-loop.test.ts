/**
 * Reading-loop tests (Task 18).
 *
 * The 3-pass reader is injected as a stub (`deps.readPaper`) so these tests
 * exercise the loop's queueing / convergence / harvest / survey logic directly,
 * against a real temp workspace (so getPaper/ingestPaper behave for real) but
 * with no network and no real LLM.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { ingestPaper, getPaper } from "../../paper-graph/index.js";
import type { PaperNode, PaperRead, PaperReadOutgoingCitation } from "../../paper-graph/types.js";
import type { SpineLLM } from "./spine/llm.js";
import {
  runReadingLoop,
  CONVERGENCE_K_DEFAULT,
  SOFT_CIRCUIT_BREAKER_PAPERS,
  type ReadingLoopConfig,
  type ReadingLoopDeps,
  type PriorArtCorpus,
} from "./reading-loop.js";

let workspace: string;
let projectDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readloop-"));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readloop-proj-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

const noLLM: SpineLLM = async () => "{}";

function baseConfig(over: Partial<ReadingLoopConfig> = {}): ReadingLoopConfig {
  return {
    workspace,
    projectDir,
    problem: { title: "Test problem", formalStatement: "", tags: ["nt"], slug: "test" },
    seedPaperIds: [],
    priorArt: null,
    llm: noLLM,
    modelName: "test-model",
    promptVersion: "test-v1",
    ...over,
  };
}

/** Build a PaperRead for the stubbed reader. */
function makeRead(
  node: PaperNode,
  opts: {
    novel?: string;
    cites?: PaperReadOutgoingCitation[];
    verdict?: "trusted" | "warn" | "rejected" | "skipped";
    decision?: "study" | "skim_sufficient" | "discard";
    isSurvey?: boolean;
    withBody?: boolean;
  } = {},
): PaperRead {
  const now = "2026-01-01T00:00:00.000Z";
  const withBody = opts.withBody ?? true;
  return {
    paperId: node.id,
    arxivId: node.arxivId,
    sourceKind: "tex",
    sourceBytes: 1000,
    truncated: false,
    skim: {
      oneLineSummary: node.title,
      mainContribution: "",
      sectionOutline: [],
      decision: opts.decision ?? "study",
      decisionReason: "",
    },
    read: withBody
      ? {
          mainResults: [],
          proofStrategy: "strategy",
          keyTechniques: [],
          technicalDependencies: [],
          novelContributions: opts.novel ?? "novel result here",
          standardMaterial: "",
          hardSteps: [],
          role: "milestone",
        }
      : undefined,
    audit: opts.verdict
      ? { verdict: opts.verdict, flags: [], pass: "fine", checkedAt: now }
      : undefined,
    outgoingCitations: opts.cites ?? [],
    isSurvey: opts.isSurvey ?? node.isSurvey,
    modelUsed: "test-model",
    promptVersion: "test-v1",
    passesCompleted: ["skim", "read"],
    totalLlmCalls: 2,
    totalTokensIn: 0,
    totalTokensOut: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function ingest(over: Partial<PaperNode> & { arxivId: string; title: string }): Promise<string> {
  const id = await ingestPaper(workspace, {
    title: over.title,
    authors: over.authors ?? ["A. Author"],
    year: over.year,
    abstract: over.abstract ?? "abs",
    arxivId: over.arxivId,
    isSurvey: over.isSurvey,
  });
  if (!id) throw new Error("ingest failed");
  return id;
}

function arxivCite(arxivId: string, importance: PaperReadOutgoingCitation["importanceToThisPaper"] = "essential"): PaperReadOutgoingCitation {
  return { citedArxivId: arxivId, citedTitle: `Paper ${arxivId}`, contextInThisPaper: `cites ${arxivId}`, importanceToThisPaper: importance };
}

describe("runReadingLoop", () => {
  it("(a) terminates 'natural' after K consecutive empty-novelty reads", async () => {
    const seedId = await ingest({ arxivId: "seed-a", title: "Seed A" });
    // Seed is novel and harvests four empty-novelty candidates.
    const cites = ["ca1", "ca2", "ca3", "ca4"].map((id) => arxivCite(id));

    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        if (node.arxivId === "seed-a") return makeRead(node, { novel: "genuinely novel", cites });
        return makeRead(node, { novel: "" }); // empty novelty
      },
    };

    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);
    expect(result.convergence.reason).toBe("natural");
    expect(result.convergence.consecutiveEmptyRounds).toBe(CONVERGENCE_K_DEFAULT);
    expect(result.convergence.totalRoundsRun).toBe(4);
    expect(result.convergence.circuitBreakerTripped).toBe(false);
  });

  it("(b) terminates 'circuit_breaker' when novel papers keep flooding the queue", async () => {
    let counter = 0;
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        // Each read is novel and spawns two fresh arxiv candidates.
        const a = `cb-${counter++}`;
        const b = `cb-${counter++}`;
        return makeRead(node, { novel: "always novel", cites: [arxivCite(a), arxivCite(b)] });
      },
    };
    const seedId = await ingest({ arxivId: "seed-b", title: "Seed B" });
    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);
    expect(result.convergence.reason).toBe("circuit_breaker");
    expect(result.convergence.circuitBreakerTripped).toBe(true);
    expect(result.reads.length).toBe(SOFT_CIRCUIT_BREAKER_PAPERS);
  }, 60_000);

  it("(c) terminates 'queue_exhausted' when no candidate has any bibliography", async () => {
    const seedId = await ingest({ arxivId: "seed-c", title: "Seed C" });
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => makeRead(node, { novel: "novel", cites: [] }),
    };
    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);
    expect(result.convergence.reason).toBe("queue_exhausted");
    expect(result.reads.length).toBe(1);
    expect(result.convergence.totalRoundsRun).toBe(1);
  });

  it("(d) does NOT harvest the bibliography of a hard-deleted (rejected) paper", async () => {
    const seedId = await ingest({ arxivId: "seed-d", title: "Seed D (crank)" });
    const deps: ReadingLoopDeps = {
      readPaper: async (node) =>
        makeRead(node, { verdict: "rejected", cites: [arxivCite("should-not-appear")] }),
    };
    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);
    expect(result.rejectedPaperIds).toContain(seedId);
    expect(result.reads.length).toBe(0); // rejected read removed from results
    // The cited paper must NOT have been ingested as a queue candidate read.
    expect(result.reads.some((r) => r.arxivId === "should-not-appear")).toBe(false);
    expect(result.convergence.reason).toBe("queue_exhausted");
  });

  it("(e) reads a survey BEFORE a seed when both are queued at init", async () => {
    const surveyArxivId = await ingest({ arxivId: "survey-e", title: "Survey E", isSurvey: true });
    const seedId = await ingest({ arxivId: "seed-e", title: "Seed E" });

    const priorArt: PriorArtCorpus = {
      surveys: [
        { paperId: surveyArxivId, title: "Survey E", authors: ["S. Senior"], source: "arxiv", confidence: 0.5, why: "is a survey" },
      ],
      expositoryAnswers: [],
    };

    const order: string[] = [];
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        order.push(node.id);
        return makeRead(node, { novel: "novel", cites: [] });
      },
    };

    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId], priorArt }), deps);
    expect(order[0]).toBe(surveyArxivId);
    expect(order[1]).toBe(seedId);
    expect(result.reads[0].paperId).toBe(surveyArxivId);
  });

  it("(f) records unresolved citations when a title has no arxiv hit", async () => {
    const seedId = await ingest({ arxivId: "seed-f", title: "Seed F" });
    const deps: ReadingLoopDeps = {
      searchArxivByTitle: async () => [], // 0 hits
      readPaper: async (node) =>
        makeRead(node, {
          novel: "novel",
          cites: [
            { citedTitle: "Chen 1973", citedAuthors: ["J. Chen"], citedYear: 1973, contextInThisPaper: "Chen's theorem is essential", importanceToThisPaper: "essential" },
          ],
        }),
    };
    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);
    expect(result.unresolvedCitations).toHaveLength(1);
    const u = result.unresolvedCitations[0];
    expect(u.citedTitle).toBe("Chen 1973");
    expect(u.citedAuthors).toEqual(["J. Chen"]);
    expect(u.citedYear).toBe(1973);
    expect(u.whyImportant).toBe("Chen's theorem is essential");
    expect(u.attemptedResolutions).toEqual(["arxiv: 0 hits"]);
    expect(u.status).toBe("unresolved");
  });

  it("(g) runs survey distillation for high-confidence surveys and promotes key references", async () => {
    const surveyArxivId = await ingest({ arxivId: "survey-g", title: "Survey G", isSurvey: true });
    const priorArt: PriorArtCorpus = {
      surveys: [
        { paperId: surveyArxivId, title: "Survey G", authors: ["S. Senior"], source: "arxiv", confidence: 0.95, why: "high-confidence survey" },
      ],
      expositoryAnswers: [],
    };

    const distillationJSON = JSON.stringify({
      coveredSubAreas: ["minor arc estimates", "finite verification"],
      keyReferences: [
        { author: "Vinogradov", year: 1937, title: "On the three primes theorem", arxivId: "kr-1", whyTheSurveyHighlighted: "founding result" },
      ],
      surveyAuthorOpinion: "minor arcs are the bottleneck",
      surveyOutline: [{ heading: "Introduction", summary: "sets up the problem" }],
    });

    const llm: SpineLLM = async () => distillationJSON;

    const deps: ReadingLoopDeps = {
      readPaper: async (node) => makeRead(node, { novel: "novel", cites: [], isSurvey: node.isSurvey }),
    };

    const result = await runReadingLoop(baseConfig({ priorArt, llm }), deps);

    const surveyRead = result.reads.find((r) => r.paperId === surveyArxivId);
    expect(surveyRead?.surveyDistillation).toBeDefined();
    expect(surveyRead?.surveyDistillation?.coveredSubAreas).toContain("minor arc estimates");
    expect(surveyRead?.surveyDistillation?.keyReferences[0].title).toBe("On the three primes theorem");
    expect(surveyRead?.surveyDistillation?.surveyAuthorOpinion).toBe("minor arcs are the bottleneck");

    // The key reference (kr-1) must have been promoted to the queue and read.
    const krRead = result.reads.find((r) => r.arxivId === "kr-1");
    expect(krRead).toBeDefined();
    const krNode = await getPaper(workspace, "arxiv-kr-1");
    expect(krNode).not.toBeNull();
  });
});
