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
    verdict?: "trusted" | "warn" | "rejected" | "off_topic" | "skipped";
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
      // Stub Crossref to also return nothing so this test stays focused on the
      // "no resolver hit" path. A separate test exercises the Crossref-hit
      // path (`(f2) Crossref fallback ...`).
      searchCrossref: async () => [],
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
    expect(u.attemptedResolutions).toEqual(["arxiv: 0 hits", "crossref: 0 hits"]);
    expect(u.status).toBe("unresolved");
    expect(u.doi).toBeUndefined();
  });

  it("(f2) Crossref fallback resolves a DOI when arxiv misses (dogfood-run-d79c820c42b7 fix)", async () => {
    // Real-world flavor: harvest finds a `\\ref{lmm:Chen73}` reference; arxiv
    // doesn't index Chen 1973; Crossref returns the 1984 reprint DOI. Report
    // surfaces the DOI so the user can fetch the PDF from the venue instead
    // of staring at a blanket "unresolved".
    const seedId = await ingest({ arxivId: "seed-f2", title: "Seed F2" });
    let crossrefCalls = 0;
    const deps: ReadingLoopDeps = {
      searchArxivByTitle: async () => [],
      searchCrossref: async (q) => {
        crossrefCalls++;
        expect(q.title).toBe("Chen 1973");
        expect(q.author).toBe("J. Chen");
        return [
          {
            doi: "10.1142/9789812776600_0021",
            title: "On the representation of a large even integer as the sum of a prime and the product of at most two primes",
            authors: ["J. R. Chen"],
            year: 1984,
            venue: "World Scientific Selected Works",
            citationCount: 42,
          },
        ];
      },
      readPaper: async (node) =>
        makeRead(node, {
          novel: "novel",
          cites: [
            { citedTitle: "Chen 1973", citedAuthors: ["J. Chen"], citedYear: 1973, contextInThisPaper: "Chen's theorem", importanceToThisPaper: "essential" },
          ],
        }),
    };
    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);
    expect(crossrefCalls).toBe(1);
    expect(result.unresolvedCitations).toHaveLength(1);
    const u = result.unresolvedCitations[0];
    expect(u.doi).toBe("10.1142/9789812776600_0021");
    expect(u.venue).toBe("World Scientific Selected Works");
    // Crossref's authoritative authors/year overwrite the harvester's guess.
    expect(u.citedAuthors).toEqual(["J. R. Chen"]);
    expect(u.citedYear).toBe(1984);
    expect(u.attemptedResolutions).toEqual([
      "arxiv: 0 hits",
      "crossref: doi=10.1142/9789812776600_0021",
    ]);
  });

  it("(f3) Crossref error is recorded in attemptedResolutions, not thrown", async () => {
    const seedId = await ingest({ arxivId: "seed-f3", title: "Seed F3" });
    const deps: ReadingLoopDeps = {
      searchArxivByTitle: async () => [],
      searchCrossref: async () => {
        throw new Error("crossref 503");
      },
      readPaper: async (node) =>
        makeRead(node, {
          novel: "novel",
          cites: [
            { citedTitle: "Some classic", contextInThisPaper: "needed", importanceToThisPaper: "essential" },
          ],
        }),
    };
    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);
    expect(result.unresolvedCitations).toHaveLength(1);
    expect(result.unresolvedCitations[0]!.attemptedResolutions[1]).toContain("crossref: error");
    expect(result.unresolvedCitations[0]!.attemptedResolutions[1]).toContain("crossref 503");
    expect(result.unresolvedCitations[0]!.doi).toBeUndefined();
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

  it("(h) does NOT harvest the bibliography of an off-topic paper, and counts it as empty-novelty (harvest band)", async () => {
    // Two papers: a real seed that harvests a citation, and that harvested
    // citation will come back off_topic. We test the off_topic handling at
    // the HARVEST band — that's where the empty-novelty counter actually
    // matters (initial-band off_topic doesn't increment the counter per the
    // 2026-06-27 dogfood-run-11 fix; see reading-loop.ts L320 comment).
    const seedId = await ingest({ arxivId: "seed-h", title: "Seed H (on-topic, harvests one cite)" });
    let harvestCallCount = 0;
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        if (node.id === seedId) {
          return makeRead(node, { novel: "novel", cites: [arxivCite("phys-cited-by-seed")] });
        }
        // The HARVESTED paper is the off-topic one.
        harvestCallCount++;
        return makeRead(node, {
          verdict: "off_topic",
          novel: "would-be novel but irrelevant",
          cites: [arxivCite("phys-citation-should-not-appear")],
        });
      },
    };
    const result = await runReadingLoop(baseConfig({ seedPaperIds: [seedId] }), deps);

    // Both papers are read (seed + harvested citation), the harvest citation
    // is KEPT (off_topic ≠ rejected; not hard-deleted).
    expect(result.reads.length).toBe(2);
    expect(result.reads.some((r) => r.audit?.verdict === "off_topic")).toBe(true);
    expect(result.rejectedPaperIds.length).toBe(0);
    // The 3rd-hop phys-citation must NOT have been queued, ingested, or read.
    expect(result.reads.some((r) => r.arxivId === "phys-citation-should-not-appear")).toBe(false);
    const physNode = await getPaper(workspace, "arxiv-phys-citation-should-not-appear");
    expect(physNode).toBeNull();
    // The off-topic harvest-band round DID increment the counter; with no more
    // candidates the queue then exhausts.
    expect(result.convergence.consecutiveEmptyRounds).toBeGreaterThanOrEqual(1);
    expect(harvestCallCount).toBe(1);
  });

  it("(i) within the same priority band, reads the EARLIEST year first (chronological tiebreaker)", async () => {
    // Three user-supplied seeds, ingested in REVERSE chronological order.
    // The chronological tiebreaker (within PRIORITY_SEED) should still pop
    // Brun 1920 → Selberg 1950 → Chen 1973 so the reader sees the
    // methodological lineage in the order it actually unfolded.
    const chenId = await ingest({ arxivId: "chen-1973", title: "Chen", year: 1973 });
    const selbergId = await ingest({ arxivId: "selberg-1950", title: "Selberg", year: 1950 });
    const brunId = await ingest({ arxivId: "brun-1920", title: "Brun", year: 1920 });

    const order: string[] = [];
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        order.push(node.id);
        return makeRead(node, { novel: "novel", cites: [] });
      },
    };

    // Seeds intentionally listed in reverse-chronological order in the input.
    await runReadingLoop(baseConfig({ seedPaperIds: [chenId, selbergId, brunId] }), deps);
    expect(order).toEqual([brunId, selbergId, chenId]);
  });

  it("(j) consecutiveEmptyRounds counter does NOT increment for initial-band candidates (no premature termination)", async () => {
    // dogfood-run-11 regression: chronological tiebreaker pulled an abstract-only
    // canon (Montgomery 1975, 0 citations) ahead of a deep canon (Helfgott 2013).
    // 3 reads × 0 novel citations → premature `natural` convergence at K=3,
    // leaving 4 canon/seed candidates UNREAD in the queue. The fix: initial-band
    // pops (priority >= PRIORITY_SEED) reset the counter regardless of novelty,
    // because well-curated entries should always be consumed.
    const s1 = await ingest({ arxivId: "init-1", title: "Init 1" });
    const s2 = await ingest({ arxivId: "init-2", title: "Init 2" });
    const s3 = await ingest({ arxivId: "init-3", title: "Init 3" });
    const s4 = await ingest({ arxivId: "init-4", title: "Init 4" });
    const s5 = await ingest({ arxivId: "init-5", title: "Init 5" });

    const order: string[] = [];
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        order.push(node.id);
        // All 5 initial candidates produce zero novel citations (abstract-only style).
        return makeRead(node, { novel: "novel", cites: [] });
      },
    };

    const result = await runReadingLoop(baseConfig({ seedPaperIds: [s1, s2, s3, s4, s5] }), deps);

    // Pre-fix: only 3 would be read (consecutiveEmptyRounds hits K=3 after read 3
    // even though 2 seeds are still in the queue). Post-fix: all 5 must be read
    // because seed reads don't increment the counter.
    expect(order.length).toBe(5);
    expect(result.reads.length).toBe(5);
    // Exits via queue_exhausted, NOT natural, because the counter never tripped.
    expect(result.convergence.reason).toBe("queue_exhausted");
  });

  it("(k) every read paper is associated with the project (dogfood-run-d79c820c42b7 fix)", async () => {
    // Pre-fix: associatePaperToProject was only called by the legacy v1
    // arxiv-crawl path in agent.ts (not in v3). Run-d79c820c42b7 had 21 reads
    // + 33 ingested papers but only 3 entries in associations.jsonl (the 3
    // seeds, written by the separate seed-ingestion helper). Downstream UI /
    // `mathran project papers` / wiki bibliography would miss every paper
    // the loop actually read.
    const s1 = await ingest({ arxivId: "k-seed-1", title: "Seed 1" });
    const s2 = await ingest({ arxivId: "k-seed-2", title: "Seed 2" });
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => makeRead(node, { novel: "novel", cites: [] }),
    };
    await runReadingLoop(baseConfig({ seedPaperIds: [s1, s2] }), deps);

    // associations.jsonl should now contain BOTH seeds (and nothing else
    // since no harvest fired).
    const assocPath = path.join(projectDir, ".mathran", "papers", "associations.jsonl");
    const assocRaw = await fs.readFile(assocPath, "utf-8");
    const lines = assocRaw.trim().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const paperIds = lines.map((l) => JSON.parse(l).paperId);
    expect(paperIds).toContain(s1);
    expect(paperIds).toContain(s2);
    // discoveredBy taxonomy is informational; the key invariant is that
    // SOMETHING coherent went into the file, not a specific string.
    for (const l of lines) {
      const row = JSON.parse(l);
      expect(["seed", "survey-keyref", "harvest"]).toContain(row.discoveredBy);
    }
  });

  it("(l) [Layer 2] when a plan is supplied, the loop pops papers in plan order, NOT priority/year order", async () => {
    // Seed 3 papers chronologically AGAINST the order the plan wants. Without
    // the plan: queue picks earliest-year first (s1 → s2 → s3). With the
    // plan: pops in the LLM-supplied arc order (s3 → s1 → s2).
    const s1 = await ingest({ arxivId: "l-1900", title: "1900", year: 1900 });
    const s2 = await ingest({ arxivId: "l-1950", title: "1950", year: 1950 });
    const s3 = await ingest({ arxivId: "l-2020", title: "2020", year: 2020 });

    const order: string[] = [];
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        order.push(node.id);
        return makeRead(node, { novel: "novel", cites: [] });
      },
    };

    const { EMPTY_PLAN } = await import("./reading-plan/index.js");
    const plan = {
      ...EMPTY_PLAN,
      planVersion: 1,
      narrativeArcs: [{
        name: "Trace it backwards",
        rationale: "modern first then ancestry",
        steps: [
          { paperId: s3, purpose: "modern frontier" },
          { paperId: s1, purpose: "first foundations" },
          { paperId: s2, purpose: "filling the gap" },
        ],
      }],
      expectedTotalReads: 3,
      producedAt: "2026-06-28T00:00:00Z",
    };

    await runReadingLoop(baseConfig({ seedPaperIds: [s1, s2, s3], plan }), deps);
    expect(order).toEqual([s3, s1, s2]);
  });

  it("(m) [Layer 2] when the plan is exhausted, the loop falls back to the priority queue for remaining candidates", async () => {
    // 4 seeds, plan covers only 2 of them. Loop should read those 2 in plan
    // order, then fall through to year-asc priority for the other 2.
    const a = await ingest({ arxivId: "m-1910", title: "1910", year: 1910 });
    const b = await ingest({ arxivId: "m-1960", title: "1960", year: 1960 });
    const c = await ingest({ arxivId: "m-1990", title: "1990", year: 1990 });
    const d = await ingest({ arxivId: "m-2010", title: "2010", year: 2010 });

    const order: string[] = [];
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => {
        order.push(node.id);
        return makeRead(node, { novel: "novel", cites: [] });
      },
    };

    const { EMPTY_PLAN } = await import("./reading-plan/index.js");
    const plan = {
      ...EMPTY_PLAN,
      planVersion: 1,
      narrativeArcs: [{
        name: "Plan-covered slice",
        rationale: "",
        steps: [
          { paperId: d, purpose: "" },
          { paperId: b, purpose: "" },
        ],
      }],
      expectedTotalReads: 2,
      producedAt: "x",
    };

    await runReadingLoop(baseConfig({ seedPaperIds: [a, b, c, d], plan }), deps);
    // First two: plan order. Next two: priority-fallback (year-asc within band).
    expect(order.slice(0, 2)).toEqual([d, b]);
    expect(order.slice(2)).toEqual([a, c]);
  });

  it("(n) [Layer 2] replan callback is invoked at the configured cadence", async () => {
    const seeds = await Promise.all([1, 2, 3, 4, 5].map((i) =>
      ingest({ arxivId: `n-${i}`, title: `S${i}` }),
    ));
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => makeRead(node, { novel: "novel", cites: [] }),
    };

    const replanInvocations: Array<{ readCount: number; queueCount: number }> = [];
    const { EMPTY_PLAN } = await import("./reading-plan/index.js");
    let nextVersion = 2;
    await runReadingLoop(
      baseConfig({
        seedPaperIds: seeds,
        plan: { ...EMPTY_PLAN, planVersion: 1, producedAt: "x" },
        replanCadence: 2, // every 2 reads
        replan: async (args) => {
          replanInvocations.push({
            readCount: args.readPaperIds.length,
            queueCount: args.queuedPaperIds.length,
          });
          // Always return a NEW version so the loop adopts the (still-empty) plan.
          return { ...EMPTY_PLAN, planVersion: nextVersion++, producedAt: "x" };
        },
      }),
      deps,
    );
    // 5 reads at cadence=2 → callbacks after read 2 and read 4. (Read 5 doesn't
    // trigger another because readsSinceReplan is 1 at loop exit.)
    expect(replanInvocations.length).toBe(2);
    expect(replanInvocations[0].readCount).toBe(2);
    expect(replanInvocations[1].readCount).toBe(4);
  });

  it("(o) [Layer 2] when replan throws, the loop logs and carries the prior plan (no abort)", async () => {
    const seeds = await Promise.all([1, 2, 3].map((i) =>
      ingest({ arxivId: `o-${i}`, title: `S${i}` }),
    ));
    const deps: ReadingLoopDeps = {
      readPaper: async (node) => makeRead(node, { novel: "novel", cites: [] }),
    };
    const { EMPTY_PLAN } = await import("./reading-plan/index.js");
    let replanCalls = 0;
    const r = await runReadingLoop(
      baseConfig({
        seedPaperIds: seeds,
        plan: { ...EMPTY_PLAN, planVersion: 1, producedAt: "x" },
        replanCadence: 1,
        replan: async () => {
          replanCalls++;
          throw new Error("planner down");
        },
      }),
      deps,
    );
    // The loop runs to completion even though every replan throws.
    expect(r.reads.length).toBe(3);
    expect(replanCalls).toBeGreaterThanOrEqual(1);
  });
});
