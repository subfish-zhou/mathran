/**
 * Tests for canonical-landmarks-search.
 *
 * Stages tested:
 *   1. LLM proposes landmarks; we parse + clamp.
 *   2. Each landmark is resolved against arxiv (title) and Crossref
 *      (bibliographic). Failures are isolated and don't crash the run.
 *   3. Hits are sorted: arxiv-resolved → doi-only → fully unresolved.
 */

import { describe, expect, it, vi } from "vitest";
import {
  searchCanonicalLandmarks,
  type SearchArxivByTitleFn,
  type CrossrefSearchFn,
} from "./canonical-landmarks-search.js";
import type { SpineLLM } from "../spine/llm.js";

const BIN_GOLDBACH_PROBLEM = {
  title: "Binary Goldbach Conjecture",
  formalStatement: "every even n>2 is the sum of two primes",
  tags: ["Analytic Number Theory"],
  background:
    "Chen (1973) proved (1+2). Vinogradov (1937) handled the ternary case. Helfgott (2013) closed ternary explicitly.",
  mathStatus: "OPEN",
};

function fakeLlm(reply: string): SpineLLM {
  return (async () => reply) as unknown as SpineLLM;
}

describe("searchCanonicalLandmarks", () => {
  it("proposes + resolves; arxiv-resolved hits sort before unresolved", async () => {
    // LLM proposes 3 landmarks.
    const llm = fakeLlm(
      JSON.stringify([
        { title: "On the representation of a large even integer", authors: ["Chen"], year: 1973, venue: "Sci. Sinica", why: "Chen's theorem" },
        { title: "Three Primes Theorem", authors: ["Vinogradov"], year: 1937, venue: "Mat. Sb.", why: "founding ternary result" },
        { title: "Major arcs for Goldbach's problem", authors: ["Helfgott"], year: 2013, venue: "arXiv", why: "explicit ternary closure" },
      ]),
    );

    // arxiv only resolves Helfgott (modern, on arxiv).
    const searchArxivByTitle: SearchArxivByTitleFn = vi.fn(async (q) => {
      if (q.includes("Major arcs")) {
        return [{ arxivId: "1305.2897", title: "Major arcs for Goldbach's problem", authors: ["Helfgott"], year: 2013 } as never];
      }
      return [];
    });
    // Crossref resolves Chen (via reprint DOI) and Vinogradov (via Springer Selected Works).
    const searchCrossref: CrossrefSearchFn = vi.fn(async (q) => {
      if (q.title?.includes("representation of a large even integer")) {
        return [{ doi: "10.1142/9789812776600_0021", title: "On the representation of a large even integer", authors: ["Chen"], year: 1984, venue: "Series in Pure Math." }];
      }
      if (q.title?.includes("Three Primes")) {
        return [{ doi: "10.1007/978-3-642-15086-9_13", title: "Three Primes Theorem", authors: ["Vinogradov"], year: 1985, venue: "Springer Selected Works" }];
      }
      return [];
    });

    const hits = await searchCanonicalLandmarks(BIN_GOLDBACH_PROBLEM, {
      llm,
      searchArxivByTitle,
      searchCrossref,
      rateDelayMs: 0,
    });

    expect(hits).toHaveLength(3);
    // Helfgott (arxiv-resolved) sorts first.
    expect(hits[0]?.arxivId).toBe("1305.2897");
    // Chen + Vinogradov (doi-only) come next, in some order.
    const doiOnly = hits.slice(1).filter((h) => !h.arxivId && h.doi);
    expect(doiOnly).toHaveLength(2);
    expect(doiOnly.find((h) => h.title.includes("representation"))?.doi).toBe("10.1142/9789812776600_0021");
    expect(doiOnly.find((h) => h.title.includes("Three Primes"))?.doi).toBe("10.1007/978-3-642-15086-9_13");
    // All hits carry an audit trail.
    for (const h of hits) {
      expect(h.resolution.arxivAttempts.length).toBeGreaterThan(0);
      expect(h.resolution.crossrefAttempts.length).toBeGreaterThan(0);
    }
  });

  it("returns [] when LLM proposal fails (failure-isolated)", async () => {
    const llm: SpineLLM = (async () => {
      throw new Error("LLM exploded");
    }) as unknown as SpineLLM;
    const hits = await searchCanonicalLandmarks(BIN_GOLDBACH_PROBLEM, {
      llm,
      searchArxivByTitle: vi.fn(),
      searchCrossref: vi.fn(),
      rateDelayMs: 0,
    });
    expect(hits).toEqual([]);
  });

  it("returns [] when LLM returns garbage", async () => {
    const llm = fakeLlm("definitely not JSON");
    const hits = await searchCanonicalLandmarks(BIN_GOLDBACH_PROBLEM, {
      llm,
      searchArxivByTitle: vi.fn(),
      searchCrossref: vi.fn(),
      rateDelayMs: 0,
    });
    expect(hits).toEqual([]);
  });

  it("survives arxiv + crossref errors per-landmark", async () => {
    const llm = fakeLlm(
      JSON.stringify([
        { title: "Some Landmark", authors: ["X"], year: 2020, venue: "Annals", why: "important" },
      ]),
    );
    const searchArxivByTitle: SearchArxivByTitleFn = vi.fn(async () => {
      throw new Error("arxiv down");
    });
    const searchCrossref: CrossrefSearchFn = vi.fn(async () => {
      throw new Error("crossref down");
    });
    const hits = await searchCanonicalLandmarks(BIN_GOLDBACH_PROBLEM, {
      llm,
      searchArxivByTitle,
      searchCrossref,
      rateDelayMs: 0,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.arxivId).toBeUndefined();
    expect(hits[0]?.doi).toBeUndefined();
    expect(hits[0]?.resolution.arxivAttempts[0]).toMatch(/error/);
    expect(hits[0]?.resolution.crossrefAttempts[0]).toMatch(/error/);
  });

  it("requires title similarity ≥0.5 to count as a match", async () => {
    const llm = fakeLlm(
      JSON.stringify([
        { title: "Binary Goldbach Conjecture proof attempt", authors: ["X"], year: 2020, venue: "?", why: "?" },
      ]),
    );
    // Arxiv returns an unrelated paper (low title sim).
    const searchArxivByTitle: SearchArxivByTitleFn = vi.fn(async () => [
      { arxivId: "9999.99999", title: "Quantum Gravity", authors: ["Y"] } as never,
    ]);
    const searchCrossref: CrossrefSearchFn = vi.fn(async () => []);

    const hits = await searchCanonicalLandmarks(BIN_GOLDBACH_PROBLEM, {
      llm,
      searchArxivByTitle,
      searchCrossref,
      rateDelayMs: 0,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.arxivId).toBeUndefined(); // rejected: sim < 0.5
    expect(hits[0]?.resolution.arxivAttempts[0]).toMatch(/no title-match/);
  });

  it("clamps the proposal count via maxProposed", async () => {
    const llm = fakeLlm(
      JSON.stringify(
        Array.from({ length: 30 }, (_, i) => ({
          title: `Landmark ${i}`,
          authors: ["X"],
          year: 2000 + i,
          venue: "?",
          why: "?",
        })),
      ),
    );
    const searchArxivByTitle: SearchArxivByTitleFn = vi.fn(async () => []);
    const searchCrossref: CrossrefSearchFn = vi.fn(async () => []);
    const hits = await searchCanonicalLandmarks(
      BIN_GOLDBACH_PROBLEM,
      { llm, searchArxivByTitle, searchCrossref, rateDelayMs: 0 },
      { maxProposed: 5 },
    );
    expect(hits).toHaveLength(5);
  });
});
