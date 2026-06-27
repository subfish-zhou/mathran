import type { PaperRead } from "../../../paper-graph/types.js";
import type { NarrativeSpine, SpineNode } from "../spine/types.js";

export function makeNode(id: string, overrides: Partial<SpineNode> = {}): SpineNode {
  return {
    id,
    type: "milestone",
    title: `Theorem of ${id}`,
    year: 2015,
    authors: ["A. Author"],
    statement: "$\\chi(G) \\le \\Delta(G) + 1$",
    significance: "Establishes a sharp bound central to the problem.",
    paperIds: [`${id}-paper`],
    effortIds: [],
    depth: "major",
    ...overrides,
  };
}

export function makeSpine(nodes: SpineNode[]): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-06-27T00:00:00.000Z",
    globalThesis: "Determine the chromatic number of every graph.",
    eras: [{ name: "Modern", startYear: 2000, endYear: 2030, summary: "s", nodeIds: nodes.map((n) => n.id) }],
    nodes,
    edges: [],
    threads: [],
    openQuestions: [],
  };
}

export function makeFullPaperRead(paperId: string, overrides: Partial<PaperRead> = {}): PaperRead {
  return {
    paperId,
    arxivId: "2401.00001",
    sourceKind: "tex",
    sourceBytes: 412_000,
    truncated: false,
    skim: {
      oneLineSummary: "A sharp upper bound for the chromatic number via a probabilistic argument.",
      mainContribution: "Proves $\\chi(G) \\le \\Delta + 1$ with an explicit colouring algorithm.",
      sectionOutline: [{ level: 1, title: "Introduction" }],
      decision: "study",
      decisionReason: "Core milestone for the spine.",
    },
    read: {
      mainResults: [
        {
          label: "Theorem 1.1",
          statement: "$\\chi(G) \\le \\Delta(G) + 1$ for every finite simple graph $G$.",
          whereInPaper: "§3, p. 12",
          noveltyVsPrior: "Improves the constant of Smith 2009.",
        },
        {
          label: "Lemma 3.2",
          statement: "$|N(v)| \\le \\Delta$ for all $v$.",
          whereInPaper: "§3, p. 14",
          noveltyVsPrior: "Standard but stated for completeness.",
        },
      ],
      proofStrategy: "Greedy colouring with a deletion-method refinement.",
      keyTechniques: [
        { name: "Lovász Local Lemma", role: "Bounds the bad events in the random colouring." },
      ],
      technicalDependencies: [
        { claim: "$e \\cdot p \\cdot d \\le 1$ suffices.", source: "arXiv:1990.0001", whereUsed: "Lemma 3.2" },
      ],
      novelContributions: "An explicit, derandomizable colouring procedure.",
      standardMaterial: "Basic greedy colouring background.",
      hardSteps: ["Controlling the dependency graph degree in the local lemma application."],
      role: "milestone",
    },
    audit: {
      verdict: "trusted",
      score: 9,
      flags: ["minor-typo-eq-7"],
      reason: "Argument is airtight; one display equation has a sign typo that does not affect the result.",
      pass: "fine",
      checkedAt: "2026-06-27T00:00:00.000Z",
      sourceRead: "tex",
    },
    outgoingCitations: [
      {
        citedTitle: "An earlier bound",
        citedYear: 2009,
        citedArxivId: "0909.0001",
        contextInThisPaper: "Used as the baseline that Theorem 1.1 improves.",
        importanceToThisPaper: "essential",
      },
    ],
    isSurvey: false,
    modelUsed: "anthropic/claude-sonnet-4",
    promptVersion: "v1",
    passesCompleted: ["skim", "read", "audit"],
    totalLlmCalls: 3,
    totalTokensIn: 1000,
    totalTokensOut: 500,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T11:30:00.000Z",
    ...overrides,
  };
}

export function makeDiscardedPaperRead(paperId: string): PaperRead {
  return {
    paperId,
    arxivId: "2402.99999",
    sourceKind: "abstract-only",
    sourceBytes: 1200,
    truncated: false,
    skim: {
      oneLineSummary: "Tangential note with no bearing on the problem.",
      mainContribution: "A minor remark.",
      sectionOutline: [],
      decision: "discard",
      decisionReason: "Off-topic for this spine.",
    },
    outgoingCitations: [],
    isSurvey: false,
    modelUsed: "anthropic/claude-sonnet-4",
    promptVersion: "v1",
    passesCompleted: ["skim"],
    totalLlmCalls: 1,
    totalTokensIn: 100,
    totalTokensOut: 30,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T10:00:00.000Z",
  };
}
