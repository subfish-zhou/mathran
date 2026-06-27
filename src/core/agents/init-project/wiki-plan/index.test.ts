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
    expect(WIKI_OUTLINE_PROMPT_VERSION).toBe("v1");
  });

  it("persists and reloads a WikiPlan", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-wikiplan-"));
    try {
      const projectDir = path.join(dir, "proj");
      await fs.mkdir(projectDir, { recursive: true });
      const plan: WikiPlan = {
        globalThesis: "t",
        totalPages: 1,
        pages: [{ slug: "overview", title: "O", purpose: "p", audience: "graduate-student-entering-field", estimatedLengthWords: 100, coreSections: [], keyEffortsCited: ["vino"], keyPaperReadsCited: [], relatedPageSlugs: [], narrativeRole: "introduction" }],
        pageOrder: ["overview"],
      };
      await persistWikiPlan(projectDir, plan);
      const loaded = await readWikiPlan(projectDir);
      expect(loaded).toEqual(plan);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
