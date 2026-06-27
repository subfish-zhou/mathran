import { describe, expect, it, vi } from "vitest";

import { buildSpineFromReads } from "./build-spine-from-reads.js";
import type { SpineLLM } from "../spine/llm.js";
import type { PaperRead, PaperNode } from "../../../paper-graph/types.js";
import type { PriorArtCorpus } from "../prior-art/index.js";

// A deliberately gnarly LaTeX string with constructs an LLM might "clean up":
// nested braces, \cdots, primes, subscripts, escaped chars.
const TRICKY_STATEMENT =
  "\\sum_{n \\le x} \\Lambda(n) e\\!\\left(n\\alpha\\right) \\ll x (\\log x)^{-A}, \\quad \\alpha = a/q + \\beta,\\ |\\beta| \\le 1/q^2, \\ \\gcd(a,q)=1, \\ q \\le (\\log x)^{B} \\cdots";

function makeRead(overrides: Partial<PaperRead> & { paperId: string }): PaperRead {
  const now = "2026-06-27T00:00:00.000Z";
  return {
    sourceKind: "tex",
    sourceBytes: 1000,
    truncated: false,
    skim: {
      oneLineSummary: "A paper.",
      mainContribution: "Proves a bound.",
      sectionOutline: [{ level: 1, title: "Intro" }],
      decision: "study",
      decisionReason: "relevant",
    },
    read: {
      mainResults: [
        {
          label: "Theorem 1.1",
          statement: "Default statement.",
          whereInPaper: "§1",
          noveltyVsPrior: "new",
        },
      ],
      proofStrategy: "circle method",
      keyTechniques: [{ name: "Vaughan identity", role: "Type II sums" }],
      technicalDependencies: [],
      novelContributions: "improved exponent",
      standardMaterial: "",
      hardSteps: [],
      role: "milestone",
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
    ...overrides,
  };
}

function makeNode(id: string): PaperNode {
  return {
    id,
    title: `Paper ${id}`,
    authors: ["A. Author"],
    year: 2020,
    isSurvey: false,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
}

/** Routes node-extraction vs assembly by prompt content. */
function fakeLlm(nodeReply: unknown, assemblyReply: unknown): SpineLLM {
  return vi.fn(async (prompt: string) => {
    if (prompt.includes("extracting Narrative-Spine nodes")) {
      return JSON.stringify(nodeReply);
    }
    return JSON.stringify(assemblyReply);
  });
}

const baseProblem = {
  title: "Goldbach's conjecture",
  formalStatement: "Every even integer > 2 is a sum of two primes.",
  description: "Classic additive prime problem.",
  tags: ["number-theory"],
  mathStatus: "OPEN",
};

describe("buildSpineFromReads", () => {
  it("copies SpineNode.statement VERBATIM from PaperReadMainResult.statement (no LaTeX alteration)", async () => {
    const reads: PaperRead[] = [
      makeRead({
        paperId: "P-tricky",
        read: {
          mainResults: [
            {
              label: "Theorem 2.3",
              statement: TRICKY_STATEMENT,
              whereInPaper: "§2",
              noveltyVsPrior: "improves Vinogradov",
            },
          ],
          proofStrategy: "minor arcs",
          keyTechniques: [{ name: "large sieve", role: "major arcs" }],
          technicalDependencies: [],
          novelContributions: "explicit constants",
          standardMaterial: "",
          hardSteps: [],
          role: "milestone",
        },
      }),
    ];

    // The LLM deliberately MANGLES the statement in its reply (drops \cdots,
    // collapses braces). The module MUST overwrite it with the verbatim source.
    const nodeReply = {
      nodes: [
        {
          id: "vinogradov-bound",
          type: "milestone",
          title: "Vinogradov-type minor arc bound",
          year: 2020,
          authors: ["A. Author"],
          statement: "\\sum \\Lambda(n) e(n alpha) is small",
          sourcePaperId: "P-tricky",
          sourceResultLabel: "Theorem 2.3",
          significance: "Core estimate.",
          paper_ids: ["P-tricky"],
          depth: "major",
          suggested_edges: [],
        },
      ],
    };
    const assemblyReply = {
      global_thesis: "thesis",
      eras: [{ name: "Modern", start_year: 2000, end_year: 2030, summary: "x", node_ids: ["vinogradov-bound"] }],
      edges: [],
      threads: [{ id: "minor-arcs", name: "Minor arcs", description: "d", node_ids: ["vinogradov-bound"], status: "active" }],
      open_questions: [],
    };

    const spine = await buildSpineFromReads(
      { problem: baseProblem, reads, paperNodes: [makeNode("P-tricky")], priorArt: null },
      { llm: fakeLlm(nodeReply, assemblyReply) },
    );

    expect(spine.nodes).toHaveLength(1);
    expect(spine.nodes[0]!.statement).toBe(TRICKY_STATEMENT);
    // Sanity: the mangled LLM string did NOT win.
    expect(spine.nodes[0]!.statement).not.toContain("is small");
  });

  it("assembles eras, threads, edges and openQuestions from two reads", async () => {
    const reads: PaperRead[] = [
      makeRead({ paperId: "P0", read: { ...makeRead({ paperId: "P0" }).read!, mainResults: [{ label: "Thm 1", statement: "S0", whereInPaper: "§1", noveltyVsPrior: "n" }] } }),
      makeRead({ paperId: "P1", read: { ...makeRead({ paperId: "P1" }).read!, mainResults: [{ label: "Thm 2", statement: "S1", whereInPaper: "§1", noveltyVsPrior: "n" }] } }),
    ];
    const nodeReply = {
      nodes: [
        { id: "n0", type: "foundation", title: "N0", year: 1900, statement: "x", sourcePaperId: "P0", sourceResultLabel: "Thm 1", significance: "s", paper_ids: ["P0"], depth: "foundational", suggested_edges: [{ target: "n1", type: "enables", context: "c" }] },
        { id: "n1", type: "milestone", title: "N1", year: 2010, statement: "x", sourcePaperId: "P1", sourceResultLabel: "Thm 2", significance: "s", paper_ids: ["P1"], depth: "major", suggested_edges: [] },
      ],
    };
    const assemblyReply = {
      global_thesis: "The story.",
      eras: [
        { name: "Classical", start_year: 1800, end_year: 2000, summary: "x", node_ids: ["n0"] },
        { name: "Modern", start_year: 2000, end_year: 2030, summary: "y", node_ids: ["n1"] },
      ],
      edges: [{ from: "n0", to: "n1", type: "enables", context: "leads to" }],
      threads: [{ id: "main", name: "Main line", description: "d", node_ids: ["n0", "n1"], status: "active" }],
      open_questions: [{ title: "Full conjecture", statement: "all evens", related_node_ids: ["n1"], barrier: "b", partial_progress: "p" }],
    };

    const spine = await buildSpineFromReads(
      { problem: baseProblem, reads, paperNodes: [makeNode("P0"), makeNode("P1")], priorArt: null },
      { llm: fakeLlm(nodeReply, assemblyReply) },
    );

    expect(spine.nodes).toHaveLength(2);
    expect(spine.nodes[0]!.statement).toBe("S0");
    expect(spine.nodes[1]!.statement).toBe("S1");
    expect(spine.eras).toHaveLength(2);
    expect(spine.threads[0]!.nodeIds).toEqual(["n0", "n1"]);
    expect(spine.openQuestions).toHaveLength(1);
    // suggested edge folded in even if assembly already provided one (no dup).
    expect(spine.edges).toHaveLength(1);
    expect(spine.edges[0]).toMatchObject({ from: "n0", to: "n1" });
  });

  it("pre-filters rejected and discarded reads", async () => {
    const reads: PaperRead[] = [
      makeRead({ paperId: "good" }),
      makeRead({ paperId: "rejected", audit: { verdict: "rejected", flags: [], pass: "fine", checkedAt: "2026-06-27T00:00:00.000Z" } }),
      makeRead({
        paperId: "discarded",
        skim: { oneLineSummary: "x", mainContribution: "x", sectionOutline: [], decision: "discard", decisionReason: "off-topic" },
      }),
    ];
    // Extraction prompt should only mention the good paper id.
    let capturedPrompt = "";
    const llm: SpineLLM = vi.fn(async (prompt: string) => {
      if (prompt.includes("extracting Narrative-Spine nodes")) {
        capturedPrompt = prompt;
        return JSON.stringify({ nodes: [{ id: "g", type: "milestone", title: "G", statement: "x", sourcePaperId: "good", sourceResultLabel: "Theorem 1.1", significance: "s", paper_ids: ["good"], depth: "major" }] });
      }
      return JSON.stringify({ global_thesis: "t", eras: [], edges: [], threads: [], open_questions: [] });
    });

    const spine = await buildSpineFromReads(
      { problem: baseProblem, reads, paperNodes: [], priorArt: null },
      { llm },
    );

    expect(capturedPrompt).toContain("[good]");
    expect(capturedPrompt).not.toContain("[rejected]");
    expect(capturedPrompt).not.toContain("[discarded]");
    // Orphan node still gets attached to a synthesized era.
    expect(spine.eras.length).toBeGreaterThanOrEqual(1);
    expect(spine.eras.flatMap((e) => e.nodeIds)).toContain("g");
  });

  it("feeds high-confidence survey outlines as structural prior, ignoring low-confidence ones", async () => {
    const reads: PaperRead[] = [
      makeRead({ paperId: "primary" }),
      makeRead({
        paperId: "survey-hi",
        isSurvey: true,
        surveyDistillation: {
          coveredSubAreas: ["minor arcs"],
          keyReferences: [],
          surveyOutline: [
            { heading: "Major arc estimates", summary: "x" },
            { heading: "Minor arc estimates", summary: "y" },
          ],
        },
      }),
      makeRead({
        paperId: "survey-lo",
        isSurvey: true,
        surveyDistillation: {
          coveredSubAreas: [],
          keyReferences: [],
          surveyOutline: [{ heading: "Should not appear", summary: "z" }],
        },
      }),
    ];
    const priorArt: PriorArtCorpus = {
      surveys: [
        { paperId: "survey-hi", title: "A Good Survey", authors: ["S"], year: 2019, source: "arxiv", confidence: 0.9, why: "yes" },
        { paperId: "survey-lo", title: "A Weak Survey", authors: ["W"], year: 2005, source: "arxiv", confidence: 0.2, why: "maybe" },
      ],
      expositoryAnswers: [],
    };

    let assemblyPrompt = "";
    const llm: SpineLLM = vi.fn(async (prompt: string) => {
      if (prompt.includes("extracting Narrative-Spine nodes")) {
        return JSON.stringify({ nodes: [{ id: "n", type: "milestone", title: "N", statement: "x", sourcePaperId: "primary", sourceResultLabel: "Theorem 1.1", significance: "s", paper_ids: ["primary"], depth: "major" }] });
      }
      assemblyPrompt = prompt;
      return JSON.stringify({ global_thesis: "t", eras: [{ name: "E", node_ids: ["n"] }], edges: [], threads: [{ id: "th", name: "T", description: "d", node_ids: ["n"], status: "active" }], open_questions: [] });
    });

    await buildSpineFromReads(
      { problem: baseProblem, reads, paperNodes: [], priorArt },
      { llm },
    );

    expect(assemblyPrompt).toContain("A Good Survey");
    expect(assemblyPrompt).toContain("Major arc estimates");
    expect(assemblyPrompt).not.toContain("A Weak Survey");
    expect(assemblyPrompt).not.toContain("Should not appear");
  });

  it("returns an empty spine when all reads are filtered out", async () => {
    const reads: PaperRead[] = [
      makeRead({ paperId: "x", skim: { oneLineSummary: "x", mainContribution: "x", sectionOutline: [], decision: "discard", decisionReason: "r" } }),
    ];
    const llm = vi.fn(async () => "{}");
    const spine = await buildSpineFromReads(
      { problem: baseProblem, reads, paperNodes: [], priorArt: null },
      { llm },
    );
    expect(spine.nodes).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("batches node extraction when > 25 papers", async () => {
    const reads: PaperRead[] = Array.from({ length: 27 }, (_, i) => makeRead({ paperId: `P${i}` }));
    let extractionCalls = 0;
    const llm: SpineLLM = vi.fn(async (prompt: string) => {
      if (prompt.includes("extracting Narrative-Spine nodes")) {
        extractionCalls++;
        return JSON.stringify({ nodes: [] });
      }
      return JSON.stringify({ global_thesis: "t", eras: [], edges: [], threads: [], open_questions: [] });
    });
    await buildSpineFromReads(
      { problem: baseProblem, reads, paperNodes: [], priorArt: null },
      { llm },
    );
    expect(extractionCalls).toBe(2); // 25 + 2
  });
});
