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

// ═══════════════════════════════════════════════════════════════════════════
//  Stage 2 abstract capture (arxiv → crossref → openalex fallback chain)
// ═══════════════════════════════════════════════════════════════════════════

describe("searchCanonicalLandmarks — abstract capture (Stages A/B/C/D → E)", () => {
  it("stores arxiv abstract when arxiv Stage A hits", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [
      arxivRes({
        arxivId: "math/9911165",
        title: "The McKay correspondence",
        abstract: "We prove the McKay correspondence for finite subgroups of SL(3,C) via derived equivalences.",
      }),
    ];
    // Crossref returns nothing so its abstract path is not tested here.
    const openAlexCalls: string[] = [];
    const hits = await searchCanonicalLandmarks(
      { title: "McKay correspondence", tags: [] },
      {
        llm: async () => JSON.stringify([{ ...McKAY_LANDMARK, why: McKAY_LANDMARK.why }]),
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async (doi) => { openAlexCalls.push(doi); return undefined; },
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.abstract).toContain("McKay correspondence for finite subgroups");
    expect(hits[0]!.resolution.abstractSource).toBe("arxiv");
    // With arxiv hit AND crossref empty (no DOI), Stage E should NOT be reached — cost saving.
    expect(openAlexCalls).toEqual([]);
  });

  it("prefers arxiv abstract over crossref abstract when BOTH exist", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [
      arxivRes({
        arxivId: "math/1111",
        title: "The McKay correspondence",
        abstract: "ARXIV ABSTRACT: the definitive one",
      }),
    ];
    const searchCrossref: CrossrefSearchFn = async () => [
      { doi: "10.1000/foo", title: "The McKay correspondence", authors: ["Reid"], year: 2000, abstract: "CROSSREF abstract: also present" },
    ];
    const hits = await searchCanonicalLandmarks(
      { title: "McKay correspondence", tags: [] },
      {
        llm: async () => JSON.stringify([McKAY_LANDMARK]),
        searchArxivByTitle,
        searchCrossref,
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.abstract).toBe("ARXIV ABSTRACT: the definitive one");
    expect(hits[0]!.resolution.abstractSource).toBe("arxiv");
  });

  it("falls back to crossref abstract when arxiv gave title match but no abstract text", async () => {
    // Preprint had arxiv id but empty abstract (weird edge — old alg-geom archive entries sometimes)
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [
      arxivRes({ arxivId: "alg-geom/9612003", title: "The McKay correspondence", abstract: undefined }),
    ];
    const searchCrossref: CrossrefSearchFn = async () => [
      { doi: "10.1000/foo", title: "The McKay correspondence", authors: ["Reid"], year: 2000, abstract: "CROSSREF filled in the abstract" },
    ];
    const hits = await searchCanonicalLandmarks(
      { title: "McKay correspondence", tags: [] },
      {
        llm: async () => JSON.stringify([McKAY_LANDMARK]),
        searchArxivByTitle,
        searchCrossref,
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.abstract).toBe("CROSSREF filled in the abstract");
    expect(hits[0]!.resolution.abstractSource).toBe("crossref");
  });

  it("falls back to OpenAlex when arxiv AND crossref both lack abstract but crossref supplied DOI", async () => {
    // No arxiv hit at all. Crossref has DOI but no abstract. OpenAlex fills in.
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [];
    const searchCrossref: CrossrefSearchFn = async () => [
      { doi: "10.1090/pspum/046.1/927963", title: "Young person's guide to canonical singularities", authors: ["Reid"], year: 1987 },
    ];
    const openAlexAbs = async (doi: string) => {
      expect(doi).toBe("10.1090/pspum/046.1/927963");
      return "This lecture note surveys canonical and terminal singularities and discrepancies for 3-fold birational geometry.";
    };
    const hits = await searchCanonicalLandmarks(
      { title: "McKay correspondence", tags: [] },
      {
        llm: async () => JSON.stringify([{ ...McKAY_LANDMARK, title: "Young person's guide to canonical singularities", titleEn: undefined, authors: ["Miles Reid"] }]),
        searchArxivByTitle,
        searchCrossref,
        fetchOpenAlexAbstract: openAlexAbs,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.abstract).toContain("canonical and terminal singularities");
    expect(hits[0]!.resolution.abstractSource).toBe("openalex");
  });

  it("does NOT call OpenAlex when there's no DOI (nothing to look up)", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [];
    const searchCrossref: CrossrefSearchFn = async () => [];
    const openAlexCalls: string[] = [];
    const hits = await searchCanonicalLandmarks(
      { title: "McKay correspondence", tags: [] },
      {
        llm: async () => JSON.stringify([McKAY_LANDMARK]),
        searchArxivByTitle,
        searchCrossref,
        fetchOpenAlexAbstract: async (doi) => { openAlexCalls.push(doi); return undefined; },
        rateDelayMs: 0,
      },
    );
    expect(openAlexCalls).toEqual([]);
    expect(hits[0]!.abstract).toBeUndefined();
    expect(hits[0]!.resolution.abstractSource).toBe("none");
  });

  it("swallows OpenAlex errors without failing the whole hit", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [];
    const searchCrossref: CrossrefSearchFn = async () => [
      { doi: "10.1000/xyz", title: "The McKay correspondence", authors: ["Reid"], year: 2000 },
    ];
    const hits = await searchCanonicalLandmarks(
      { title: "McKay correspondence", tags: [] },
      {
        llm: async () => JSON.stringify([McKAY_LANDMARK]),
        searchArxivByTitle,
        searchCrossref,
        fetchOpenAlexAbstract: async () => { throw new Error("openalex down"); },
        rateDelayMs: 0,
      },
    );
    // Hit still returned, just no abstract.
    expect(hits[0]!.doi).toBe("10.1000/xyz");
    expect(hits[0]!.abstract).toBeUndefined();
    expect(hits[0]!.resolution.abstractSource).toBe("none");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Stage 2.5 priority classifier
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return a mock LLM: first call → landmarks JSON (Stage 1); second call → priority JSON (Stage 2.5).
 * Simplifies test setup so we don't have to route by prompt inspection.
 */
function twoCallLLM(landmarksJson: string, priorityJson: string): SpineLLM {
  let call = 0;
  return async () => {
    call++;
    if (call === 1) return landmarksJson;
    return priorityJson;
  };
}

describe("searchCanonicalLandmarks — Stage 2.5 priority classifier", () => {
  const THREE_LANDMARKS = [
    { title: "BKR", titleEn: "The McKay correspondence as an equivalence of derived categories", authors: ["Bridgeland", "King", "Reid"], year: 2001, venue: "JAMS", why: "founding derived McKay" },
    { title: "Haiman", titleEn: "Hilbert schemes, polygraphs and the Macdonald positivity conjecture", authors: ["Haiman"], year: 2001, venue: "JAMS", why: "sn-Hilb bridge" },
    { title: "Klein", titleEn: "Lectures on the Icosahedron", authors: ["Klein"], year: 1884, venue: "Teubner", why: "polyhedral background" },
  ];

  it("applies core/important/supplementary tags from LLM output", async () => {
    // Arxiv returns matches for all three so Stage E does not run.
    const searchArxivByTitle: SearchArxivByTitleFn = async (q) => {
      if (q.startsWith("au:")) return [];
      if (/BKR|derived categories/i.test(q)) return [arxivRes({ arxivId: "math/9908027", title: "The McKay correspondence as an equivalence of derived categories", abstract: "Long enough abstract A: proves the derived McKay correspondence via Fourier-Mukai equivalence for G-Hilbert schemes." })];
      if (/Hilbert.*polygraphs/i.test(q)) return [arxivRes({ arxivId: "math/0010246", title: "Hilbert schemes, polygraphs and the Macdonald positivity conjecture", abstract: "Long enough abstract B: uses polygraph freeness and blowup structure of the isospectral Hilbert scheme." })];
      if (/Icosahedron/i.test(q)) return [arxivRes({ arxivId: "0000.klein", title: "Lectures on the Icosahedron", abstract: "Long enough abstract C: classical background on binary polyhedral groups and invariant theory of the icosahedron." })];
      return [];
    };
    const priorityJson = JSON.stringify([
      { index: 0, priority: "core", reasoning: "the founding derived-McKay theorem" },
      { index: 1, priority: "important", reasoning: "primary technique bridge" },
      { index: 2, priority: "supplementary", reasoning: "classical background only" },
    ]);
    const hits = await searchCanonicalLandmarks(
      { title: "McKay correspondence", tags: [] },
      {
        llm: twoCallLLM(JSON.stringify(THREE_LANDMARKS), priorityJson),
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    // Ordering by "arxiv resolved first" — since all 3 got arxiv, order is by insertion.
    const byArxivId = new Map(hits.map((h) => [h.arxivId, h]));
    expect(byArxivId.get("math/9908027")!.priority).toBe("core");
    expect(byArxivId.get("math/9908027")!.priorityReasoning).toContain("founding");
    // abstract is > 20 chars so low-confidence should be false
    expect(byArxivId.get("math/9908027")!.priorityLowConfidence).toBe(false);
    expect(byArxivId.get("math/0010246")!.priority).toBe("important");
    expect(byArxivId.get("0000.klein")!.priority).toBe("supplementary");
  });

  it("marks priorityLowConfidence=false when abstract is present and >20 chars", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [
      arxivRes({
        arxivId: "math/x",
        title: "Sample landmark title with enough words for similarity",
        abstract: "A long enough abstract to survive the 20-char filter in resolveOneLandmark",
      }),
    ];
    const priorityJson = JSON.stringify([{ index: 0, priority: "core", reasoning: "founding" }]);
    const hits = await searchCanonicalLandmarks(
      { title: "test", tags: [] },
      {
        llm: twoCallLLM(JSON.stringify([{
          title: "Sample landmark title with enough words for similarity",
          titleEn: "Sample landmark title with enough words for similarity",
          authors: ["A"],
          year: 2000,
          why: "w",
        }]), priorityJson),
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.priority).toBe("core");
    expect(hits[0]!.priorityLowConfidence).toBe(false);
    expect(hits[0]!.arxivId).toBe("math/x");
  });

  it("marks priorityLowConfidence=true when abstract is missing", async () => {
    // Arxiv returns match but WITHOUT abstract (edge case: alg-geom archive entries).
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [
      arxivRes({
        arxivId: "math/x",
        title: "Sample landmark title with enough words for similarity",
        abstract: undefined,
      }),
    ];
    const priorityJson = JSON.stringify([{ index: 0, priority: "core", reasoning: "founding" }]);
    const hits = await searchCanonicalLandmarks(
      { title: "test", tags: [] },
      {
        llm: twoCallLLM(JSON.stringify([{
          title: "Sample landmark title with enough words for similarity",
          titleEn: "Sample landmark title with enough words for similarity",
          authors: ["A"],
          year: 2000,
          why: "w",
        }]), priorityJson),
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.abstract).toBeUndefined();
    expect(hits[0]!.priority).toBe("core");
    expect(hits[0]!.priorityLowConfidence).toBe(true);
  });

  it("caps 'core' at 5 — demotes 6th+ to 'important'", async () => {
    // Six landmarks, LLM greedily tags all six as core. Post-parse cap enforces max 5.
    const six = Array.from({ length: 6 }, (_, i) => ({
      title: `Paper ${i}`, titleEn: `Paper ${i}`, authors: [`Author${i}`], year: 2000 + i, venue: "V", why: "canon",
    }));
    const searchArxivByTitle: SearchArxivByTitleFn = async (q) => {
      if (q.startsWith("au:")) {
        const m = q.match(/au:Author(\d)/);
        if (m) return [arxivRes({ arxivId: `arxiv/${m[1]}`, title: `Paper ${m[1]}`, abstract: `abs ${m[1]}` })];
      }
      // Full-title search
      const m = q.match(/^Paper (\d)/);
      if (m) return [arxivRes({ arxivId: `arxiv/${m[1]}`, title: `Paper ${m[1]}`, abstract: `abs ${m[1]}` })];
      return [];
    };
    const priorityJson = JSON.stringify([
      { index: 0, priority: "core", reasoning: "x" },
      { index: 1, priority: "core", reasoning: "x" },
      { index: 2, priority: "core", reasoning: "x" },
      { index: 3, priority: "core", reasoning: "x" },
      { index: 4, priority: "core", reasoning: "x" },
      { index: 5, priority: "core", reasoning: "x" }, // this one should be demoted to important
    ]);
    const hits = await searchCanonicalLandmarks(
      { title: "test", tags: [] },
      {
        llm: twoCallLLM(JSON.stringify(six), priorityJson),
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    const coreN = hits.filter((h) => h.priority === "core").length;
    const impN = hits.filter((h) => h.priority === "important").length;
    expect(coreN).toBe(5);
    expect(impN).toBe(1);
  });

  it("leaves priority undefined when Stage 2.5 LLM output is unparseable", async () => {
    const searchArxivByTitle: SearchArxivByTitleFn = async (q) =>
      q.startsWith("au:") ? [] : [arxivRes({ arxivId: "math/x", title: "T", abstract: "a" })];
    // Second LLM call returns garbage.
    const hits = await searchCanonicalLandmarks(
      { title: "test", tags: [] },
      {
        llm: twoCallLLM(JSON.stringify([{ title: "T", titleEn: "T", authors: ["A"], year: 2000, why: "w" }]), "not json"),
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.priority).toBeUndefined();
    expect(hits[0]!.priorityReasoning).toBeUndefined();
  });

  it("leaves priority undefined when Stage 2.5 LLM throws", async () => {
    const TITLE = "Sample landmark title with enough words";
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [
      arxivRes({ arxivId: "math/x", title: TITLE, abstract: "An abstract long enough to survive filters." }),
    ];
    let call = 0;
    const llm: SpineLLM = async () => {
      call++;
      if (call === 1) return JSON.stringify([{ title: TITLE, titleEn: TITLE, authors: ["A"], year: 2000, why: "w" }]);
      throw new Error("Stage 2.5 LLM died");
    };
    const hits = await searchCanonicalLandmarks(
      { title: "test", tags: [] },
      {
        llm,
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.priority).toBeUndefined();
    // But other fields survived — the hit itself is intact.
    expect(hits[0]!.arxivId).toBe("math/x");
  });

  it("ignores entries with invalid tier strings or out-of-range indices", async () => {
    const TITLE = "Sample landmark title with enough words";
    const searchArxivByTitle: SearchArxivByTitleFn = async () => [
      arxivRes({ arxivId: "math/x", title: TITLE, abstract: "An abstract long enough to survive filters." }),
    ];
    const priorityJson = JSON.stringify([
      { index: 0, priority: "URGENT", reasoning: "invalid tier" }, // bad
      { index: 99, priority: "core", reasoning: "out of range" }, // bad
    ]);
    const hits = await searchCanonicalLandmarks(
      { title: "test", tags: [] },
      {
        llm: twoCallLLM(JSON.stringify([{ title: TITLE, titleEn: TITLE, authors: ["A"], year: 2000, why: "w" }]), priorityJson),
        searchArxivByTitle,
        searchCrossref: async () => [],
        fetchOpenAlexAbstract: async () => undefined,
        rateDelayMs: 0,
      },
    );
    expect(hits[0]!.priority).toBeUndefined();
  });
});
