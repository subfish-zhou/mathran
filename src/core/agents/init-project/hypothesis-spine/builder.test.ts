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

  // ── fix #3 from run-13-audit: paper-id intersection + cross-prefix normalization ──

  it("matches by paper-id intersection even when titles are very different", () => {
    // Hypothesis title is generic, real spine title is verbose & specific.
    // Pre-fix this matched 0 (Jaccard 0.10 < 0.5). Post-fix the shared
    // paper-id forces a match regardless of title.
    const local: HypothesisSpine = {
      ...hyp,
      nodes: [{
        id: "hyp-paperid", type: "milestone",
        title: "Sieve",
        statement: "some result that is long enough to trigger the substring-similarity check",
        significance: "x",
        depth: "major",
        expectedPaperIds: ["arxiv-math_0209360"],
        confidence: "hypothesis",
      }],
    };
    const local_real: NarrativeSpine = {
      ...realSpine,
      nodes: [{
        id: "real-X", type: "milestone",
        title: "A long verbose specific title that shares no tokens with the hypothesis Sieve",
        statement: "some result that is long enough to trigger the substring-similarity check",
        significance: "x", paperIds: ["arxiv-math_0209360"], effortIds: [], depth: "major",
      }],
    };
    const r = reconcileSpines({
      hypothesis: local, realSpine: local_real,
      readPaperIds: new Set(["arxiv-math_0209360"]), rejectedPaperIds: new Set(),
    });
    const n = r.reconciled.nodes[0];
    expect(n.matchedSpineNodeId).toBe("real-X");
    expect(n.confidence).toBe("verified");
  });

  it("normalizes id prefixes (doi:foo vs arxiv-foo vs raw foo) so cross-store ids match", () => {
    // Run-13 actual case: hypothesis cites by doi, real spine has arxiv id.
    // Pre-fix: 0 matched. Post-fix: normalized form bridges them.
    const local: HypothesisSpine = {
      ...hyp,
      nodes: [{
        id: "hyp-doi", type: "foundation", title: "Hardy-Littlewood",
        statement: "circle-method singular series",
        significance: "x", depth: "foundational",
        expectedPaperIds: ["doi:10.1007/bf02403921"],
        confidence: "hypothesis",
      }],
    };
    const local_real: NarrativeSpine = {
      ...realSpine,
      nodes: [{
        id: "real-Y", type: "foundation",
        title: "Some paper that the spine builder gave a different title to",
        statement: "circle-method singular series",
        significance: "x",
        paperIds: ["arxiv-10.1007/bf02403921"],
        effortIds: [], depth: "foundational",
      }],
    };
    const r = reconcileSpines({
      hypothesis: local, realSpine: local_real,
      readPaperIds: new Set(["arxiv-10.1007/bf02403921"]), rejectedPaperIds: new Set(),
    });
    expect(r.reconciled.nodes[0].matchedSpineNodeId).toBe("real-Y");
  });

  it("title-Jaccard fallback at 0.25 catches near-matches the old 0.5 threshold dropped", () => {
    // Pre-fix Run 13: "Brun sieve and almost-prime Goldbach substitutes" vs
    // "Brun's sieve and combinatorial sieves" — jaccard 0.33, below 0.5,
    // not matched. Now at 0.25, this matches.
    const local: HypothesisSpine = {
      ...hyp,
      nodes: [{
        id: "hyp-near", type: "foundation",
        title: "Brun sieve and almost-prime Goldbach substitutes",
        statement: "sieve substitute",
        significance: "x", depth: "foundational",
        expectedPaperIds: [],
        confidence: "hypothesis",
      }],
    };
    const local_real: NarrativeSpine = {
      ...realSpine,
      nodes: [{
        id: "real-Z", type: "foundation",
        title: "Brun's sieve and combinatorial sieves",
        statement: "sieve substitute",
        significance: "x",
        paperIds: ["arxiv-math_0209360"], effortIds: [], depth: "foundational",
      }],
    };
    const r = reconcileSpines({
      hypothesis: local, realSpine: local_real,
      readPaperIds: new Set(), rejectedPaperIds: new Set(),
    });
    expect(r.reconciled.nodes[0].matchedSpineNodeId).toBe("real-Z");
  });

  it("prefers the real node with the LARGEST paper-id intersection (multi-id hypothesis)", () => {
    const local: HypothesisSpine = {
      ...hyp,
      nodes: [{
        id: "hyp-multi", type: "milestone", title: "A",
        statement: "x", significance: "x", depth: "major",
        expectedPaperIds: ["arxiv-A", "arxiv-B", "arxiv-C"],
        confidence: "hypothesis",
      }],
    };
    const local_real: NarrativeSpine = {
      ...realSpine,
      nodes: [
        { id: "real-1id", type: "milestone", title: "x", statement: "x", significance: "x",
          paperIds: ["arxiv-A"], effortIds: [], depth: "major" },
        { id: "real-2ids", type: "milestone", title: "x", statement: "x", significance: "x",
          paperIds: ["arxiv-B", "arxiv-C"], effortIds: [], depth: "major" },
      ],
    };
    const r = reconcileSpines({
      hypothesis: local, realSpine: local_real,
      readPaperIds: new Set(["arxiv-B"]), rejectedPaperIds: new Set(),
    });
    // real-2ids wins on intersection size (2 vs 1).
    expect(r.reconciled.nodes[0].matchedSpineNodeId).toBe("real-2ids");
  });
});
