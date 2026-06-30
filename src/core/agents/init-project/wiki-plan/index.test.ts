import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  outlineWikiPages,
  persistWikiPlan,
  readWikiPlan,
  buildWikiOutlinePrompt,
  WIKI_OUTLINE_PROMPT_VERSION,
  type OutlineWikiInput,
  type WikiPlan,
} from "./index.js";
import type { SpineLLM } from "../spine/llm.js";
import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";
import type { PriorArtCorpus } from "../prior-art/index.js";

function makeSpine(): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-06-27T00:00:00.000Z",
    globalThesis: "Ternary Goldbach was settled by the circle method.",
    eras: [
      { name: "Classical", startYear: 1900, endYear: 2000, summary: "Vinogradov.", nodeIds: ["vino"] },
      { name: "Modern", startYear: 2000, endYear: 2020, summary: "Helfgott.", nodeIds: ["helfgott"] },
    ],
    nodes: [
      { id: "vino", type: "milestone", title: "Vinogradov 1937", statement: "S", significance: "s", paperIds: ["P0"], effortIds: [], depth: "major" },
      { id: "helfgott", type: "milestone", title: "Helfgott 2015", statement: "S", significance: "s", paperIds: ["P1"], effortIds: [], depth: "major" },
    ],
    edges: [],
    threads: [
      { id: "circle-method", name: "Circle method", description: "Major/minor arcs.", nodeIds: ["vino", "helfgott"], status: "converged" },
      { id: "finite-verification", name: "Finite verification", description: "Numerics.", nodeIds: ["helfgott"], status: "converged" },
    ],
    openQuestions: [],
  };
}

function makeReads(): PaperRead[] {
  const now = "2026-06-27T00:00:00.000Z";
  const mk = (id: string, role: PaperRead["read"] extends infer _ ? string : never): PaperRead => ({
    paperId: id,
    sourceKind: "tex",
    sourceBytes: 1,
    truncated: false,
    skim: { oneLineSummary: id, mainContribution: "x", sectionOutline: [], decision: "study", decisionReason: "r" },
    read: {
      mainResults: [{ label: "Thm", statement: "S", whereInPaper: "§1", noveltyVsPrior: "n" }],
      proofStrategy: "x",
      keyTechniques: [],
      technicalDependencies: [],
      novelContributions: "x",
      standardMaterial: "",
      hardSteps: [],
      role: role as PaperRead["read"] extends { role: infer R } ? R : never,
    },
    outgoingCitations: [],
    isSurvey: false,
    modelUsed: "test",
    promptVersion: "v1",
    passesCompleted: ["skim", "read"],
    totalLlmCalls: 1,
    totalTokensIn: 0,
    totalTokensOut: 0,
    createdAt: now,
    updatedAt: now,
  });
  return [mk("P0", "milestone"), mk("P1", "milestone")];
}

const baseInput = (): OutlineWikiInput => ({
  problem: {
    title: "Ternary Goldbach",
    formalStatement: "Every odd n > 5 is a sum of three primes.",
    description: "Solved by Helfgott.",
    tags: ["number-theory"],
    mathStatus: "SOLVED",
  },
  spine: makeSpine(),
  reads: makeReads(),
  priorArt: null,
});

function llmReturning(obj: unknown): SpineLLM {
  return vi.fn(async () => JSON.stringify(obj));
}

describe("outlineWikiPages", () => {
  it("passes through a well-formed LLM plan and enforces ordering invariants", async () => {
    const llm = llmReturning({
      globalThesis: "The circle method story.",
      totalPages: 4,
      pages: [
        { slug: "overview", title: "Overview", purpose: "intro", audience: "graduate-student-entering-field", estimatedLengthWords: 2000, coreSections: ["A", "B"], keyEffortsCited: ["vino"], keyPaperReadsCited: ["P0"], relatedPageSlugs: ["circle-method"], narrativeRole: "introduction" },
        { slug: "circle-method", title: "Circle Method", purpose: "p", audience: "specialist-refresher", estimatedLengthWords: 3000, coreSections: ["Major", "Minor"], keyEffortsCited: ["vino", "helfgott"], keyPaperReadsCited: ["P1"], relatedPageSlugs: [], narrativeRole: "deep dive" },
        { slug: "finite-verification", title: "Finite Verification", purpose: "p", audience: "expert-checking-status", estimatedLengthWords: 1500, coreSections: ["Numerics"], keyEffortsCited: ["helfgott"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "numerics" },
        { slug: "bibliography", title: "Bibliography", purpose: "refs", audience: "specialist-refresher", estimatedLengthWords: 800, coreSections: ["Refs"], keyEffortsCited: [], keyPaperReadsCited: ["P0", "P1"], relatedPageSlugs: [], narrativeRole: "references" },
      ],
      pageOrder: ["overview", "circle-method", "finite-verification", "bibliography"],
    });

    const plan = await outlineWikiPages(baseInput(), { llm });

    expect(plan.totalPages).toBe(4);
    expect(plan.pages).toHaveLength(4);
    expect(plan.pageOrder).toHaveLength(4);
    expect(plan.pageOrder[0]).toBe("overview");
    expect(plan.pageOrder.at(-1)).toBe("bibliography");
    // exactly one intro
    expect(plan.pages.filter((p) => p.audience === "graduate-student-entering-field")).toHaveLength(1);
    // pages.length === pageOrder.length, slugs unique & match
    expect(new Set(plan.pageOrder)).toEqual(new Set(plan.pages.map((p) => p.slug)));
  });

  it("synthesizes a missing intro and missing bibliography page", async () => {
    const llm = llmReturning({
      globalThesis: "t",
      pages: [
        { slug: "circle-method", title: "Circle Method", purpose: "p", audience: "specialist-refresher", estimatedLengthWords: 3000, coreSections: ["Major"], keyEffortsCited: ["vino"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "deep dive" },
        { slug: "finite-verification", title: "Finite Verification", purpose: "p", audience: "expert-checking-status", estimatedLengthWords: 1500, coreSections: ["Numerics"], keyEffortsCited: ["helfgott"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "numerics" },
      ],
      pageOrder: ["circle-method", "finite-verification"],
    });

    const plan = await outlineWikiPages(baseInput(), { llm });

    const intros = plan.pages.filter((p) => p.audience === "graduate-student-entering-field");
    expect(intros).toHaveLength(1);
    expect(plan.pageOrder[0]).toBe(intros[0]!.slug);
    expect(plan.pages.some((p) => p.slug === "bibliography")).toBe(true);
    expect(plan.pageOrder.at(-1)).toBe("bibliography");
  });

  it("clamps to MAX_PAGES while protecting intro and bibliography", async () => {
    const pages = [
      { slug: "overview", title: "Overview", purpose: "i", audience: "graduate-student-entering-field", estimatedLengthWords: 100, coreSections: [], keyEffortsCited: ["vino"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "introduction" },
      ...Array.from({ length: 14 }, (_, i) => ({
        slug: `attack-${i}`, title: `Attack ${i}`, purpose: "p", audience: "specialist-refresher", estimatedLengthWords: 1000 + i, coreSections: ["x"], keyEffortsCited: ["helfgott"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "attack",
      })),
      { slug: "bibliography", title: "Bibliography", purpose: "r", audience: "specialist-refresher", estimatedLengthWords: 50, coreSections: [], keyEffortsCited: [], keyPaperReadsCited: ["P0"], relatedPageSlugs: [], narrativeRole: "references" },
    ];
    const plan = await outlineWikiPages(baseInput(), { llm: llmReturning({ globalThesis: "t", pages, pageOrder: [] }) });

    expect(plan.totalPages).toBe(12);
    expect(plan.pages.some((p) => p.audience === "graduate-student-entering-field")).toBe(true);
    expect(plan.pages.some((p) => p.slug === "bibliography")).toBe(true);
    // highest estimatedLengthWords attacks survive (attack-13 has the most)
    expect(plan.pages.some((p) => p.slug === "attack-13")).toBe(true);
  });

  it("repairs orphan pages by citing spine nodes from the relevant thread", async () => {
    const llm = llmReturning({
      globalThesis: "t",
      pages: [
        { slug: "overview", title: "Overview", purpose: "i", audience: "graduate-student-entering-field", estimatedLengthWords: 2000, coreSections: ["A"], keyEffortsCited: ["vino"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "introduction" },
        { slug: "circle-method", title: "Circle Method", purpose: "p", audience: "specialist-refresher", estimatedLengthWords: 3000, coreSections: ["Major"], keyEffortsCited: [], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "Circle method" },
        { slug: "bibliography", title: "Bibliography", purpose: "r", audience: "specialist-refresher", estimatedLengthWords: 800, coreSections: ["Refs"], keyEffortsCited: [], keyPaperReadsCited: ["P0"], relatedPageSlugs: [], narrativeRole: "references" },
      ],
      pageOrder: ["overview", "circle-method", "bibliography"],
    });

    const plan = await outlineWikiPages(baseInput(), { llm });
    const cm = plan.pages.find((p) => p.slug === "circle-method")!;
    expect(cm.keyEffortsCited.length + cm.keyPaperReadsCited.length).toBeGreaterThan(0);
    // matched the "Circle method" thread → its node ids
    expect(cm.keyEffortsCited).toContain("vino");
  });

  it("pads up to MIN_PAGES when the LLM under-produces", async () => {
    const llm = llmReturning({
      globalThesis: "t",
      pages: [
        { slug: "overview", title: "Overview", purpose: "i", audience: "graduate-student-entering-field", estimatedLengthWords: 2000, coreSections: ["A"], keyEffortsCited: ["vino"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "introduction" },
        { slug: "bibliography", title: "Bibliography", purpose: "r", audience: "specialist-refresher", estimatedLengthWords: 800, coreSections: [], keyEffortsCited: [], keyPaperReadsCited: ["P0"], relatedPageSlugs: [], narrativeRole: "references" },
      ],
      pageOrder: ["overview", "bibliography"],
    });

    const plan = await outlineWikiPages(baseInput(), { llm });
    expect(plan.totalPages).toBeGreaterThanOrEqual(3);
    expect(plan.pageOrder.at(-1)).toBe("bibliography");
    expect(plan.pageOrder[0]).toBe("overview");
  });

  it("falls back to a fully-synthesized plan when the LLM returns garbage", async () => {
    const llm: SpineLLM = vi.fn(async () => "not json at all");
    const plan = await outlineWikiPages(baseInput(), { llm });
    expect(plan.totalPages).toBeGreaterThanOrEqual(3);
    expect(plan.pages.filter((p) => p.audience === "graduate-student-entering-field")).toHaveLength(1);
    expect(plan.pages.some((p) => p.slug === "bibliography")).toBe(true);
    for (const page of plan.pages) {
      if (page.slug === "bibliography") continue;
      expect(page.keyEffortsCited.length + page.keyPaperReadsCited.length).toBeGreaterThan(0);
    }
  });

  it("includes prior-survey add-value framing in the prompt", () => {
    const priorArt: PriorArtCorpus = {
      surveys: [{ paperId: "P0", title: "Old Survey on Goldbach", authors: ["X"], year: 2010, source: "arxiv", confidence: 0.8, why: "yes" }],
      expositoryAnswers: [],
    };
    const prompt = buildWikiOutlinePrompt({ ...baseInput(), priorArt });
    expect(prompt).toContain("ADD VALUE");
    expect(prompt).toContain("Old Survey on Goldbach");
    expect(WIKI_OUTLINE_PROMPT_VERSION).toBe("v2");
  });

  it("persists and reloads a WikiPlan", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-wikiplan-"));
    try {
      const projectDir = path.join(dir, "proj");
      await fs.mkdir(projectDir, { recursive: true });
      const plan: WikiPlan = {
        globalThesis: "t",
        totalPages: 1,
        pages: [{ slug: "overview", title: "O", purpose: "p", audience: "graduate-student-entering-field", estimatedLengthWords: 100, coreSections: [], keyEffortsCited: ["vino"], keyPaperReadsCited: [], relatedPageSlugs: [], relatedPages: [], narrativeRole: "introduction" }],
        pageOrder: ["overview"],
      };
      await persistWikiPlan(projectDir, plan);
      const loaded = await readWikiPlan(projectDir);
      expect(loaded).toEqual(plan);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // ── 2026-06-30 — argument-map / typed-relations tests ─────────────────────

  it("coerces typed relatedPages and keeps relatedPageSlugs in sync", async () => {
    // LLM returns the new shape: relatedPages: [{slug,relation}, …]. We assert
    // the plan ends up with BOTH fields populated (typed for v3 writer, legacy
    // slug list for the nav footer).
    const llm: SpineLLM = async () =>
      JSON.stringify({
        globalThesis: "t",
        argumentMap: {
          thesis: "t",
          subClaims: [
            { id: "C1", claim: "First claim", supportedByPages: ["middle"], dependsOn: [] },
            { id: "C2", claim: "Second claim", supportedByPages: ["frontier"], dependsOn: ["C1"] },
            { id: "C3", claim: "Third claim", supportedByPages: ["middle"], dependsOn: ["C1"] },
          ],
        },
        pages: [
          { slug: "overview", title: "Overview", purpose: "intro", audience: "graduate-student-entering-field", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPages: [] },
          { slug: "middle", title: "M", purpose: "m", audience: "specialist-refresher", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPages: [{ slug: "frontier", relation: "extends" }], subClaimId: "C1" },
          { slug: "frontier", title: "F", purpose: "f", audience: "expert-checking-status", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPages: [{ slug: "middle", relation: "prerequisite" }], subClaimId: "C2" },
          { slug: "bibliography", title: "B", purpose: "b", audience: "specialist-refresher", coreSections: ["s"], keyPaperReadsCited: ["P1"], relatedPages: [], narrativeRole: "references" },
        ],
        pageOrder: ["overview", "middle", "frontier", "bibliography"],
      });
    const plan = await outlineWikiPages(baseInput(), { llm });
    const middle = plan.pages.find((p) => p.slug === "middle")!;
    expect(middle.relatedPages).toEqual([{ slug: "frontier", relation: "extends" }]);
    // Legacy slug list is kept in sync (used by nav footer).
    expect(middle.relatedPageSlugs).toEqual(["frontier"]);
    expect(middle.subClaimId).toBe("C1");
  });

  it("repairs missing argumentMap by synthesizing one sub-claim per content page", async () => {
    // LLM forgot argumentMap entirely. Repair should not let the writer
    // prompt go blank — synthesize a degenerate map (1 sub-claim per
    // content page).
    const llm: SpineLLM = async () =>
      JSON.stringify({
        globalThesis: "t",
        pages: [
          { slug: "overview", title: "O", purpose: "p", audience: "graduate-student-entering-field", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPageSlugs: [] },
          { slug: "circle-method", title: "Circle", purpose: "p", audience: "specialist-refresher", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPageSlugs: [] },
          { slug: "minor-arcs", title: "Minor", purpose: "p", audience: "specialist-refresher", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPageSlugs: [] },
          { slug: "bibliography", title: "B", purpose: "b", audience: "specialist-refresher", coreSections: ["s"], keyPaperReadsCited: ["P1"], relatedPageSlugs: [], narrativeRole: "references" },
        ],
        pageOrder: ["overview", "circle-method", "minor-arcs", "bibliography"],
      });
    const plan = await outlineWikiPages(baseInput(), { llm });
    expect(plan.argumentMap).toBeDefined();
    // 2 content pages → synthesized 2 sub-claims (below MIN, so repair tries
    // to pad by splitting; with only 1 page per claim, padding gives up
    // gracefully — final count is whatever survives).
    expect(plan.argumentMap!.subClaims.length).toBeGreaterThanOrEqual(2);
    // Every content page is covered by exactly one sub-claim.
    const covered = new Set<string>();
    for (const sc of plan.argumentMap!.subClaims) {
      for (const s of sc.supportedByPages) covered.add(s);
    }
    expect(covered.has("circle-method")).toBe(true);
    expect(covered.has("minor-arcs")).toBe(true);
    // Intro and bibliography are NOT covered (they don't argue sub-claims).
    expect(covered.has("overview")).toBe(false);
    expect(covered.has("bibliography")).toBe(false);
  });

  it("breaks cycles in subClaim.dependsOn", async () => {
    // LLM emits a cycle C1 → C2 → C1. Repair should drop one back-edge.
    const llm: SpineLLM = async () =>
      JSON.stringify({
        globalThesis: "t",
        argumentMap: {
          thesis: "t",
          subClaims: [
            { id: "C1", claim: "first", supportedByPages: ["page-a"], dependsOn: ["C2"] },
            { id: "C2", claim: "second", supportedByPages: ["page-b"], dependsOn: ["C1"] },
            { id: "C3", claim: "third", supportedByPages: ["page-c"], dependsOn: [] },
          ],
        },
        pages: [
          { slug: "overview", title: "O", purpose: "p", audience: "graduate-student-entering-field", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPageSlugs: [] },
          { slug: "page-a", title: "A", purpose: "p", audience: "specialist-refresher", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPageSlugs: [] },
          { slug: "page-b", title: "B", purpose: "p", audience: "specialist-refresher", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPageSlugs: [] },
          { slug: "page-c", title: "C", purpose: "p", audience: "specialist-refresher", coreSections: ["s"], keyEffortsCited: ["n1"], relatedPageSlugs: [] },
          { slug: "bibliography", title: "B", purpose: "b", audience: "specialist-refresher", coreSections: ["s"], keyPaperReadsCited: ["P1"], relatedPageSlugs: [], narrativeRole: "references" },
        ],
        pageOrder: ["overview", "page-a", "page-b", "page-c", "bibliography"],
      });
    const plan = await outlineWikiPages(baseInput(), { llm });
    const map = plan.argumentMap!;
    // Walk dependsOn and confirm it's now a DAG (no node reachable from
    // itself).
    const byId = new Map(map.subClaims.map((sc) => [sc.id, sc]));
    function reachable(start: string, target: string, seen = new Set<string>()): boolean {
      if (seen.has(start)) return false;
      seen.add(start);
      const node = byId.get(start);
      if (!node) return false;
      for (const dep of node.dependsOn) {
        if (dep === target) return true;
        if (reachable(dep, target, seen)) return true;
      }
      return false;
    }
    for (const sc of map.subClaims) {
      expect(reachable(sc.id, sc.id)).toBe(false);
    }
  });
});
