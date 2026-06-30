import { describe, it, expect } from "vitest";
import {
  inferDominantMathCategory,
  arxivPhraseFor,
  buildArxivQuery,
  extractConcepts,
} from "./concept-extractor.js";
import type { PaperNode, PaperRead } from "../../../paper-graph/types.js";
import type { NarrativeSpine } from "../spine/types.js";

function node(overrides: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "p1",
    source: "arxiv:1234.5678",
    title: "x",
    authors: [],
    discoveredAt: "2026-06-30T00:00:00Z",
    rejected: false,
    ...overrides,
  } as PaperNode;
}

function spine(overrides: Partial<NarrativeSpine> = {}): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-06-30T00:00:00Z",
    globalThesis: "",
    eras: [],
    nodes: [],
    edges: [],
    threads: [],
    openQuestions: [],
    ...overrides,
  };
}

describe("inferDominantMathCategory", () => {
  it("returns the most-common math.* category across read nodes", () => {
    const ns = [
      node({ id: "a", categories: ["math.NT", "math.CO"] }),
      node({ id: "b", categories: ["math.NT"] }),
      node({ id: "c", categories: ["math.AP"] }),
    ];
    expect(inferDominantMathCategory(ns)).toBe("math.NT");
  });

  it("returns null when no math.* categories appear", () => {
    const ns = [node({ id: "a", categories: ["cs.AI"] }), node({ id: "b" })];
    expect(inferDominantMathCategory(ns)).toBeNull();
  });

  it("handles empty input", () => {
    expect(inferDominantMathCategory([])).toBeNull();
  });

  it("accepts math-ph hyphenated form", () => {
    const ns = [node({ id: "a", categories: ["math-ph"] })];
    expect(inferDominantMathCategory(ns)).toBe("math-ph");
  });
});

describe("arxivPhraseFor", () => {
  it("wraps multi-word phrases in URL-encoded quotes", () => {
    const out = arxivPhraseFor("circle method");
    expect(out).toBe("%22circle%20method%22");
  });

  it("leaves single words unquoted", () => {
    expect(arxivPhraseFor("goldbach")).toBe("goldbach");
  });

  it("strips LaTeX commands and math delimiters", () => {
    expect(arxivPhraseFor("\\frac{a}{b} prime gaps $\\mathbb{N}$")).toContain("prime%20gaps");
  });

  it("returns empty string on garbage-only input", () => {
    expect(arxivPhraseFor("$$$$$")).toBe("");
  });

  it("collapses whitespace", () => {
    expect(arxivPhraseFor("a   b   c")).toBe("%22a%20b%20c%22");
  });
});

describe("buildArxivQuery", () => {
  it("scopes by math category when known", () => {
    const q = buildArxivQuery("circle method", "math.NT");
    expect(q).toBe("cat:math.NT+AND+all:%22circle%20method%22");
  });

  it("falls back to bare all: when no category", () => {
    const q = buildArxivQuery("circle method", null);
    expect(q).toBe("all:%22circle%20method%22");
  });

  it("returns empty string for empty phrase (caller should skip)", () => {
    expect(buildArxivQuery("$$", null)).toBe("");
  });
});

describe("extractConcepts", () => {
  it("uses spine.globalThesis as first concept when spine is present", () => {
    const out = extractConcepts({
      spine: spine({ globalThesis: "Binary Goldbach meets sieve barriers" }),
      readPapers: [],
      readNodesById: new Map([["a", node({ id: "a", categories: ["math.NT"] })]]),
      problemTitle: "Binary Goldbach",
      problemTags: [],
    });
    expect(out[0]?.source).toBe("spine-thesis");
    expect(out[0]?.arxivQuery).toContain("cat:math.NT");
    expect(out[0]?.label.toLowerCase()).toContain("binary");
  });

  it("falls back to problem.title when spine is null", () => {
    const out = extractConcepts({
      spine: null,
      readPapers: [],
      readNodesById: new Map(),
      problemTitle: "Twin primes conjecture",
      problemTags: ["analytic-number-theory"],
    });
    expect(out).not.toHaveLength(0);
    expect(out[0]?.source).toBe("spine-thesis");
    expect(out[0]?.label.toLowerCase()).toContain("twin");
  });

  it("falls back to tags when spine is null AND title is empty", () => {
    const out = extractConcepts({
      spine: null,
      readPapers: [],
      readNodesById: new Map(),
      problemTitle: "",
      problemTags: ["sieve-theory", "L-functions"],
    });
    expect(out.map((c) => c.label).join(" ").toLowerCase()).toContain("sieve");
  });

  it("dedupes identical arxiv queries", () => {
    // Same name twice should only produce one concept.
    const out = extractConcepts({
      spine: spine({
        globalThesis: "X",
        threads: [
          { id: "t1", name: "X", description: "", nodeIds: [], status: "active" },
          { id: "t2", name: "X", description: "", nodeIds: [], status: "active" },
        ] as any,
      }),
      readPapers: [],
      readNodesById: new Map(),
      problemTitle: "Y",
      problemTags: [],
    });
    // "X" appears as thesis AND two thread names — should collapse to ONE concept.
    expect(out.filter((c) => c.label === "X")).toHaveLength(1);
  });

  it("caps at FRONTIER_MAX_CONCEPTS_PER_TICK (5)", () => {
    const out = extractConcepts({
      spine: spine({
        globalThesis: "Thesis A",
        threads: [
          { id: "t1", name: "Thread 1", description: "", nodeIds: [], status: "active" },
          { id: "t2", name: "Thread 2", description: "", nodeIds: [], status: "active" },
          { id: "t3", name: "Thread 3", description: "", nodeIds: [], status: "active" },
          { id: "t4", name: "Thread 4", description: "", nodeIds: [], status: "active" },
          { id: "t5", name: "Thread 5", description: "", nodeIds: [], status: "active" },
          { id: "t6", name: "Thread 6", description: "", nodeIds: [], status: "active" },
        ] as any,
        openQuestions: [
          { title: "Q1", statement: "Open question 1", relatedNodeIds: [], barrier: "", partialProgress: "" },
        ],
      }),
      readPapers: [],
      readNodesById: new Map(),
      problemTitle: "P",
      problemTags: [],
    });
    expect(out).toHaveLength(5);
  });

  it("sorts thread names alphabetically for deterministic output", () => {
    const out = extractConcepts({
      spine: spine({
        threads: [
          { id: "t1", name: "Zeta", description: "", nodeIds: [], status: "active" },
          { id: "t2", name: "Alpha", description: "", nodeIds: [], status: "active" },
          { id: "t3", name: "Mu", description: "", nodeIds: [], status: "active" },
        ] as any,
      }),
      readPapers: [],
      readNodesById: new Map(),
      problemTitle: "P",
      problemTags: [],
    });
    // After the (fallback) thesis from problemTitle "P", thread names appear sorted.
    const threadLabels = out.filter((c) => c.source === "spine-thread").map((c) => c.label);
    expect(threadLabels).toEqual(["Alpha", "Mu", "Zeta"]);
  });
});
