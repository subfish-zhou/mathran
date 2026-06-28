/**
 * Hypothesis-spine tests (Layer 3).
 *
 * Cover prompt builder + parse/validate + builder failure-isolation + the
 * reconciler's verified/refined/falsified/unread classification.
 */

import { describe, expect, it } from "vitest";
import {
  buildHypothesisSpine,
  reconcileSpines,
  parseAndValidateHypothesisSpine,
  buildHypothesisSpinePrompt,
  EMPTY_HYPOTHESIS_SPINE,
  type HypothesisSpine,
  type HypothesisSpineNode,
} from "./index.js";
import type { SpineLLM } from "../spine/llm.js";
import type { NarrativeSpine, SpineNode } from "../spine/types.js";
import type { CanonicalLandmarkHit } from "../prior-art/canonical-landmarks-search.js";
import type { PriorArtCorpus } from "../prior-art/index.js";

  // local → major (SpineNodeDepth is incremental|major|foundational).
  // Replace in test fixtures:
const minimalCanon = (n: number): CanonicalLandmarkHit[] =>
  Array.from({ length: n }, (_, i) => ({
    arxivId: `${1000 + i}.0000${i}`,
    doi: undefined,
    title: `Canon ${i + 1}`,
    authors: [`Author${i + 1}`],
    year: 1900 + i * 10,
    venue: "Journal",
    crossrefYear: undefined,
    crossrefVenue: undefined,
    why: `step ${i + 1}`,
    resolution: { arxivAttempts: [], crossrefAttempts: [] },
  }));

const minimalCorpus = (canon = 0): PriorArtCorpus | null => canon === 0 ? null : ({
  surveys: [],
  expositoryAnswers: [],
  canonicalLandmarks: minimalCanon(canon),
  unresolvedCanonicalLandmarks: undefined,
  surveyDistillations: [],
  metadata: { totalCandidates: canon, totalResolved: canon, queriesUsed: [], llmCallCount: 1 },
} as unknown as PriorArtCorpus);

describe("buildHypothesisSpinePrompt", () => {
  it("includes both canon and survey blocks, sorts canon by year", () => {
    const p = buildHypothesisSpinePrompt({
      problemTitle: "Goldbach",
      problemStatement: "every even n>2 is p+q",
      problemTags: ["nt"],
      canon: minimalCanon(3),
      surveys: [],
    });
    expect(p).toContain("Goldbach");
    expect(p).toContain("Canon 1");
    expect(p).toContain("Canon 3");
    // chronological order: Canon 1 (1900) before Canon 3 (1920)
    expect(p.indexOf("Canon 1")).toBeLessThan(p.indexOf("Canon 3"));
  });

  it("works with empty canon", () => {
    const p = buildHypothesisSpinePrompt({
      problemTitle: "X", problemStatement: "y", problemTags: [], canon: [], surveys: [],
    });
    expect(p).toContain("no canon proposed");
  });
});

describe("parseAndValidateHypothesisSpine", () => {
  it("returns null on garbage", () => {
    expect(parseAndValidateHypothesisSpine(null, new Set())).toBeNull();
    expect(parseAndValidateHypothesisSpine({}, new Set())).toBeNull();
    expect(parseAndValidateHypothesisSpine({ nodes: [] }, new Set())).toBeNull();
  });

  it("drops nodes missing required fields", () => {
    const r = parseAndValidateHypothesisSpine({
      nodes: [
        { id: "n1", title: "T", statement: "S", significance: "x", depth: "local", expectedPaperIds: [] },
        { id: "n2", title: "T2" }, // missing statement → dropped
        { id: "", title: "T3", statement: "S" }, // missing id → dropped
      ],
    }, new Set());
    expect(r!.nodes).toHaveLength(1);
    expect(r!.nodes[0].id).toBe("n1");
  });

  it("drops expectedPaperIds not in the candidate set", () => {
    const r = parseAndValidateHypothesisSpine({
      nodes: [{
        id: "n1", type: "milestone", title: "T", statement: "S", significance: "y", depth: "local",
        expectedPaperIds: ["paper-1", "fake-paper", "paper-2"],
      }],
    }, new Set(["paper-1", "paper-2"]));
    expect(r!.nodes[0].expectedPaperIds).toEqual(["paper-1", "paper-2"]);
  });

  it("drops edges referencing missing nodes", () => {
    const r = parseAndValidateHypothesisSpine({
      nodes: [{ id: "n1", type: "milestone", title: "T", statement: "S", significance: "y", depth: "local", expectedPaperIds: [] }],
      edges: [
        { from: "n1", to: "n1", type: "enables", context: "self-edge dropped" },
        { from: "n1", to: "fake", type: "enables", context: "missing target" },
        { from: "n1", to: "n1", type: "enables", context: "self" },
      ],
    }, new Set());
    expect(r!.edges).toEqual([]);
  });
});

describe("buildHypothesisSpine (failure isolation)", () => {
  it("returns EMPTY when no canon AND no surveys are available", async () => {
    const llm: SpineLLM = async () => "should-not-call";
    const r = await buildHypothesisSpine({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [], priorArt: null,
    });
    expect(r).toEqual(EMPTY_HYPOTHESIS_SPINE);
  });

  it("returns EMPTY when the LLM throws", async () => {
    const llm: SpineLLM = async () => { throw new Error("provider down"); };
    const r = await buildHypothesisSpine({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [], priorArt: minimalCorpus(2),
    });
    expect(r.nodes).toEqual([]);
  });

  it("returns EMPTY when the LLM returns garbage", async () => {
    const llm: SpineLLM = async () => "sorry, can't help";
    const r = await buildHypothesisSpine({ llm }, {
      problemTitle: "X", problemStatement: "y", problemTags: [], priorArt: minimalCorpus(2),
    });
    expect(r.nodes).toEqual([]);
  });

  it("returns a populated hypothesis when the LLM returns a valid plan", async () => {
    const llm: SpineLLM = async () => JSON.stringify({
      global_thesis: "central tension",
      nodes: [{
        id: "n1", type: "foundation", title: "Foundational result", year: 1900,
        statement: "every even n > 2 is something",
        significance: "starts the line",
        depth: "foundational",
        expectedPaperIds: ["arxiv-1000.00000"],
      }],
      eras: [{ name: "First wave", node_ids: ["n1"], summary: "the start" }],
      threads: [{ id: "main", name: "Main thread", description: "core", node_ids: ["n1"], status: "active" }],
    });
    const r = await buildHypothesisSpine({ llm }, {
      problemTitle: "Goldbach", problemStatement: "...", problemTags: ["nt"],
      priorArt: minimalCorpus(2),
    });
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0].confidence).toBe("hypothesis");
    expect(r.nodes[0].expectedPaperIds).toEqual(["arxiv-1000.00000"]);
    expect(r.builtFrom.canonIds).toEqual(["arxiv-1000.00000", "arxiv-1001.00001"]);
  });
});

describe("reconcileSpines", () => {
  const hyp: HypothesisSpine = {
    globalThesis: "x",
    nodes: [
      {
        id: "hyp-1", type: "foundation", title: "Combinatorial sieve foundations",
        statement: "Brun-style upper bound on prime tuples",
        significance: "starts the line",
        depth: "foundational",
        expectedPaperIds: ["paper-brun"],
        confidence: "hypothesis",
      },
      {
        id: "hyp-2", type: "refinement", title: "Refinement that won't appear in real spine",
        statement: "an entirely fictitious sharpening",
        significance: "n/a",
        depth: "major",
        expectedPaperIds: ["paper-fake"],
        confidence: "hypothesis",
      },
      {
        id: "hyp-3", type: "milestone", title: "Unread direction",
        statement: "a milestone whose papers were never reached",
        significance: "n/a",
        depth: "major",
        expectedPaperIds: ["paper-skipped"],
        confidence: "hypothesis",
      },
    ],
    eras: [], edges: [], threads: [], openQuestions: [],
    builtAt: "x", builtFrom: { canonIds: [], surveyPaperIds: [] },
  };

  const realSpine: NarrativeSpine = {
    version: 1,
    updatedAt: "2026-06-28T00:00:00Z",
    globalThesis: "real",
    nodes: [
      {
        id: "real-1", type: "foundation", title: "Combinatorial sieve foundations",
        statement: "Brun-style upper bound on prime tuples", // identical → verified
        significance: "x", paperIds: ["paper-brun"], effortIds: [], depth: "foundational",
      },
      {
        id: "real-2", type: "milestone", title: "Some other result",
        statement: "an unrelated theorem", significance: "x", paperIds: [], effortIds: [], depth: "major",
      },
    ],
    eras: [], edges: [], threads: [], openQuestions: [],
  };

  it("classifies a matching hypothesis with substring-aligned statement as 'verified'", () => {
    const r = reconcileSpines({
      hypothesis: hyp,
      realSpine,
      readPaperIds: new Set(["paper-brun"]),
      rejectedPaperIds: new Set(),
    });
    const node1 = r.reconciled.nodes.find((n) => n.id === "hyp-1")!;
    expect(node1.confidence).toBe("verified");
    expect(node1.matchedSpineNodeId).toBe("real-1");
    expect(r.summary.verified).toBe(1);
  });

  it("classifies a hypothesis with no matching real node AND read expected papers as 'falsified'", () => {
    const r = reconcileSpines({
      hypothesis: hyp,
      realSpine,
      readPaperIds: new Set(["paper-fake"]),
      rejectedPaperIds: new Set(),
    });
    const node2 = r.reconciled.nodes.find((n) => n.id === "hyp-2")!;
    expect(node2.confidence).toBe("falsified");
    expect(node2.matchedSpineNodeId).toBeUndefined();
    expect(r.summary.falsified).toBeGreaterThanOrEqual(1);
  });

  it("classifies a hypothesis whose expected papers were never read as 'unread'", () => {
    const r = reconcileSpines({
      hypothesis: hyp,
      realSpine,
      readPaperIds: new Set(),
      rejectedPaperIds: new Set(),
    });
    const node3 = r.reconciled.nodes.find((n) => n.id === "hyp-3")!;
    expect(node3.confidence).toBe("unread");
    // hyp-2 AND hyp-3 both unread when readPaperIds is empty (neither's
    // expected papers were reached). hyp-1 is also unread for the same reason.
    expect(r.summary.unread).toBeGreaterThanOrEqual(1);
  });

  it("classifies a refined match when titles align but statement changes", () => {
    const refinedReal: NarrativeSpine = {
      ...realSpine,
      nodes: [
        {
          ...realSpine.nodes[0],
          statement: "a substantially different formal statement that contains none of the same prose",
        },
        realSpine.nodes[1],
      ],
    };
    const r = reconcileSpines({
      hypothesis: hyp,
      realSpine: refinedReal,
      readPaperIds: new Set(["paper-brun"]),
      rejectedPaperIds: new Set(),
    });
    const n = r.reconciled.nodes.find((n) => n.id === "hyp-1")!;
    expect(n.confidence).toBe("refined");
    expect(n.matchedSpineNodeId).toBe("real-1");
    expect(r.summary.refined).toBeGreaterThanOrEqual(1);
  });
});
