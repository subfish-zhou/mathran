import { describe, expect, it } from "vitest";

import { searchCanonicalLandmarks, defaultCrossrefSearch } from "./canonical-landmarks-search.js";
import type {
  CrossrefSearchFn,
  CrossrefWork,
  SearchArxivByTitleFn,
} from "./canonical-landmarks-search.js";
import type { CrawledResource } from "../types.js";
import type { SpineLLM } from "../spine/llm.js";

function arxivRes(over: Partial<CrawledResource> & { arxivId: string; title: string }): CrawledResource {
  return {
    id: `arxiv-${over.arxivId}`,
    authors: ["A. Author"],
    sourceType: "arxiv",
    url: `https://arxiv.org/abs/${over.arxivId}`,
    ...over,
  } as CrawledResource;
}

function work(over: Partial<CrossrefWork> & { doi: string; title: string }): CrossrefWork {
  const { doi, title, ...rest } = over;
  return {
    doi,
    title,
    authors: ["A. Author"],
    year: 2020,
    ...rest,
  } as CrossrefWork;
}

const McKAY_LANDMARK = {
  title: "La correspondance de McKay",
  titleEn: "The McKay correspondence",
  authors: ["Miles Reid"],
  year: 2000,
  venue: "Séminaire Bourbaki, Astérisque 276",
  why: "Canonical survey of the higher-dim McKay picture",
};

const problem = {
  title: "McKay correspondence",
  tags: ["math.AG"],
};

function mockLLM(landmarks: unknown[]): SpineLLM {
  return async () => JSON.stringify(landmarks);
}

describe("searchCanonicalLandmarks — Stage B (author+keyword arxiv fallback)", () => {
  it("recovers an arxiv id when full-title search misses but au:X AND ti:Y matches", async () => {
    // Full-title search returns nothing that scores >= 0.5 similarity (e.g. arxiv
    // has "Mukai implies McKay: the McKay correspondence …" but the LLM proposed
    // "La correspondance de McKay"). Author+keyword search using
    // au:Reid AND ti:mckay AND ti:correspondence hits correctly.
    const calls: string[] = [];
    const searchArxivByTitle: SearchArxivByTitleFn = async (query) => {
      calls.push(query);
      if (query.startsWith("au:")) {
        // Author+keyword query — return a preprint whose title contains "McKay correspondence".
        return [arxivRes({ arxivId: "math/9911165", title: "The McKay correspondence" })];
      }
      // Full-title search — return an unrelated hit that scores below 0.5.
      return [arxivRes({ arxivId: "math/0000001", title: "Wildly unrelated title with no words in common" })];
    };
    const searchCrossref: CrossrefSearchFn = async () => [];
    const hits = await searchCanonicalLandmarks(
      problem,
      { llm: mockLLM([McKAY_LANDMARK]), searchArxivByTitle, searchCrossref, rateDelayMs: 0 },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.arxivId).toBe("math/9911165");
    // Log trail should show BOTH stages were attempted, and Stage B is what succeeded.
    const attempts = hits[0]!.resolution.arxivAttempts.join(" | ");
    expect(attempts).toMatch(/arxiv\[title\]:/);
    expect(attempts).toMatch(/arxiv\[au\+kw\]: matched math\/9911165/);
  });

  it("emits an au:X AND ti:Y AND ti:Z query with family name only (strips 'Given')", async () => {
    const captured: string[] = [];
    const searchArxivByTitle: SearchArxivByTitleFn = async (query) => {
      captured.push(query);
      return [];
    };
    const searchCrossref: CrossrefSearchFn = async () => [];
    await searchCanonicalLandmarks(
      problem,
      { llm: mockLLM([McKAY_LANDMARK]), searchArxivByTitle, searchCrossref, rateDelayMs: 0 },
    );
    // Second call is the au+kw fallback.
    const auKw = captured.find((c) => c.startsWith("au:"));
    expect(auKw).toBeDefined();
    expect(auKw).toContain("au:Reid");
    // titleEn "The McKay correspondence" → keywords: mckay, correspondence (stopword "the" dropped, length<4 filter)
    expect(auKw).toContain("ti:mckay");
    expect(auKw).toContain("ti:correspondence");
  });

  it("handles 'Family, Given' comma format", async () => {
    const captured: string[] = [];
    const searchArxivByTitle: SearchArxivByTitleFn = async (query) => {
      captured.push(query);
      return [];
    };
    await searchCanonicalLandmarks(
      { title: "X", tags: [] },
      {
        llm: mockLLM([
          {
            title: "Some Paper",
            titleEn: "Some Paper",
            authors: ["Reid, Miles"],
            year: 2000,
            why: "canon",
          },
        ]),
        searchArxivByTitle,
        searchCrossref: async () => [],
        rateDelayMs: 0,
      },
    );
    const auKw = captured.find((c) => c.startsWith("au:"));
    expect(auKw).toContain("au:Reid");
  });

  it("skips au+kw stage cleanly when there is no author (never throws)", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [];
    const searchCrossref: CrossrefSearchFn = async () => [];
    const hits = await searchCanonicalLandmarks(
      problem,
      {
        llm: mockLLM([{ title: "No author paper", titleEn: "No author paper", authors: [], why: "canon" }]),
        searchArxivByTitle,
        searchCrossref,
        rateDelayMs: 0,
      },
    );
    expect(hits).toHaveLength(1);
    const attempts = hits[0]!.resolution.arxivAttempts.join(" | ");
    expect(attempts).toMatch(/arxiv\[au\+kw\]: skipped/);
  });

  it("uses the relaxed 0.3 threshold for au+kw so borderline overlaps count", async () => {
    // McKAY_LANDMARK.titleEn = "The McKay correspondence" → normalized words {mckay, correspondence}.
    // Candidate title has 4 words, 2 overlap. Jaccard = 2/(2+4-2) = 0.5 → passes 0.3 but not 0.5.
    // (We want to prove 0.3 is genuinely more permissive than 0.5, so pick a case that would
    // FAIL the strict Stage A threshold but PASS the relaxed Stage B threshold. This one scores
    // 0.5 exactly which is right on the edge for Stage A; the important assertion is that
    // Stage A is skipped [we return [] there] and Stage B accepts it.)
    const searchArxivByTitle: SearchArxivByTitleFn = async (query) => {
      if (query.startsWith("au:")) {
        return [
          arxivRes({
            arxivId: "0000.0001",
            title: "Higher-dimensional McKay correspondence classes",
          }),
        ];
      }
      // Stage A: no results at all, so we don't accidentally pass because of A.
      return [];
    };
    const hits = await searchCanonicalLandmarks(
      problem,
      {
        llm: mockLLM([McKAY_LANDMARK]),
        searchArxivByTitle,
        searchCrossref: async () => [],
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.arxivId).toBe("0000.0001");
    const attempts = hits[0]!.resolution.arxivAttempts.join(" | ");
    expect(attempts).toMatch(/arxiv\[au\+kw\]: matched 0000\.0001/);
  });
});

describe("searchCanonicalLandmarks — Stage D (post-Crossref arxiv preprint hunt)", () => {
  it("finds an arxiv preprint AFTER Crossref supplied a DOI, so hit has BOTH arxivId AND doi", async () => {
    // Stage A (title) fails, Stage B (au+kw) fails, Stage C (Crossref) succeeds with DOI,
    // Stage D uses that success signal to try arxiv one more time with more keywords — hits.
    let arxivCallCount = 0;
    const searchArxivByTitle: SearchArxivByTitleFn = async (query) => {
      arxivCallCount++;
      if (arxivCallCount === 1) return []; // Stage A title miss
      if (arxivCallCount === 2) return []; // Stage B au+kw miss (say the initial keyword set was too narrow)
      // Stage D: hit with a wider keyword set
      return [arxivRes({ arxivId: "math/0207170", title: "Three-dimensional flops and non-commutative rings" })];
    };
    const searchCrossref: CrossrefSearchFn = async () => [
      work({ doi: "10.1215/S0012-7094-04-12234-X", title: "Three-dimensional flops and non-commutative rings" }),
    ];
    const hits = await searchCanonicalLandmarks(
      problem,
      {
        llm: mockLLM([
          {
            title: "Three-dimensional flops and non-commutative rings",
            titleEn: "Three-dimensional flops and non-commutative rings",
            authors: ["Michel Van den Bergh"],
            year: 2004,
            why: "canon",
          },
        ]),
        searchArxivByTitle,
        searchCrossref,
        rateDelayMs: 0,
      },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.arxivId).toBe("math/0207170");
    expect(hits[0]!.doi).toBe("10.1215/S0012-7094-04-12234-X");
    const attempts = hits[0]!.resolution.arxivAttempts.join(" | ");
    expect(attempts).toMatch(/arxiv\[post-crossref\]: matched math\/0207170/);
  });

  it("does NOT run Stage D when Stage A or B already found an arxiv id (saves an API call)", async () => {
    let arxivCallCount = 0;
    const searchArxivByTitle: SearchArxivByTitleFn = async () => {
      arxivCallCount++;
      // Stage A hits immediately.
      return [arxivRes({ arxivId: "math/1111111", title: "The McKay correspondence" })];
    };
    const searchCrossref: CrossrefSearchFn = async () => [
      work({ doi: "10.1000/foo", title: "The McKay correspondence" }),
    ];
    const hits = await searchCanonicalLandmarks(
      problem,
      {
        llm: mockLLM([McKAY_LANDMARK]),
        searchArxivByTitle,
        searchCrossref,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.arxivId).toBe("math/1111111");
    // Only Stage A was called (Stage B skipped because arxivId set, Stage D skipped because arxivId set).
    expect(arxivCallCount).toBe(1);
  });

  it("does NOT run Stage D when Crossref returned nothing (nothing to hunt for)", async () => {
    let arxivCallCount = 0;
    const searchArxivByTitle: SearchArxivByTitleFn = async () => {
      arxivCallCount++;
      return []; // All arxiv attempts miss.
    };
    const searchCrossref: CrossrefSearchFn = async () => []; // Crossref also empty.
    const hits = await searchCanonicalLandmarks(
      problem,
      {
        llm: mockLLM([McKAY_LANDMARK]),
        searchArxivByTitle,
        searchCrossref,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.arxivId).toBeUndefined();
    expect(hits[0]!.doi).toBeUndefined();
    // Stage A + Stage B ran; Stage D skipped because doi undefined → count is 2.
    expect(arxivCallCount).toBe(2);
    const attempts = hits[0]!.resolution.arxivAttempts.join(" | ");
    expect(attempts).not.toMatch(/arxiv\[post-crossref\]/);
  });
});

describe("searchCanonicalLandmarks — failure isolation preserved", () => {
  it("returns [] when LLM proposes nothing", async () => {
    const hits = await searchCanonicalLandmarks(
      problem,
      {
        llm: async () => "[]",
        searchArxivByTitle: async () => [],
        searchCrossref: async () => [],
        rateDelayMs: 0,
      },
    );
    expect(hits).toEqual([]);
  });

  it("swallows arxiv errors and still returns a resolved-with-empty-arxiv hit", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async () => {
      throw new Error("arxiv down");
    };
    const searchCrossref: CrossrefSearchFn = async () => [];
    const hits = await searchCanonicalLandmarks(
      problem,
      { llm: mockLLM([McKAY_LANDMARK]), searchArxivByTitle, searchCrossref, rateDelayMs: 0 },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.arxivId).toBeUndefined();
    const attempts = hits[0]!.resolution.arxivAttempts.join(" | ");
    expect(attempts).toMatch(/arxiv\[title\]: error/);
    expect(attempts).toMatch(/arxiv\[au\+kw\]: error/);
  });
});

describe("defaultCrossrefSearch — export sanity", () => {
  it("is a function callable with (query, ua)", () => {
    // We deliberately do NOT hit the real Crossref API in unit tests (would be flaky /
    // slow). Just prove the module exports a callable of the expected shape; end-to-end
    // real-network testing lives in `scripts/probe-crossref.mjs`.
    expect(typeof defaultCrossrefSearch).toBe("function");
    expect(defaultCrossrefSearch.length).toBeGreaterThanOrEqual(1);
  });
});
