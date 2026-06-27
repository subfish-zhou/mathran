import { describe, expect, it } from "vitest";

import { suggestSeeds } from "./seed-discovery.js";
import type { FormalizedProblem } from "./types.js";
import type { CrawledResource } from "../init-project/types.js";

const PROBLEM: FormalizedProblem = {
  title: "Binary Goldbach Conjecture",
  formalStatement: "Every even n > 2 is a sum of two primes.",
  description: "Posed 1742.",
  background: "Chen (1+2), 1966.",
  tags: ["Analytic Number Theory", "Sieve Theory"],
  mathStatus: "OPEN",
};

function mkResource(id: string, title: string, year: number): CrawledResource {
  return {
    id: `arxiv-${id}`,
    title,
    authors: ["A. Author"],
    year,
    sourceType: "arxiv",
    arxivId: id,
    url: `https://arxiv.org/abs/${id}`,
    abstract: `Abstract for ${title}.`,
  };
}

describe("suggestSeeds", () => {
  it("returns 3 ranked seeds given mocked arxiv + LLM responses", async () => {
    const candidates: CrawledResource[] = [
      mkResource("2606.05224", "Theorem (1+1.9) on Goldbach", 2026),
      mkResource("2508.16400", "Exceptional Set for Goldbach", 2025),
      mkResource("2112.11412", "Siegel zeros and Goldbach", 2021),
      mkResource("1801.00001", "A Survey of Additive Number Theory", 2018),
    ];
    const searchArxiv = async (): Promise<CrawledResource[]> => candidates;

    const llm = async (): Promise<string> =>
      JSON.stringify([
        { index: 0, why: "recent landmark", topicalFit: 0.95, recencyScore: 0.99 },
        { index: 3, why: "key survey", topicalFit: 0.8, recencyScore: 0.4 },
        { index: 2, why: "anchoring paper", topicalFit: 0.7, recencyScore: 0.6 },
      ]);

    const seeds = await suggestSeeds(PROBLEM, llm, { searchArxiv, rateDelayMs: 0 });
    expect(seeds).toHaveLength(3);
    expect(seeds[0]?.arxivId).toBe("2606.05224");
    expect(seeds[0]?.why).toBe("recent landmark");
    expect(seeds[0]?.topicalFit).toBeCloseTo(0.95);
    expect(seeds[1]?.arxivId).toBe("1801.00001");
  });

  it("clamps out-of-range scores and dedups repeated indices", async () => {
    const searchArxiv = async (): Promise<CrawledResource[]> => [
      mkResource("1111.11111", "P1", 2020),
      mkResource("2222.22222", "P2", 2021),
    ];
    const llm = async (): Promise<string> =>
      JSON.stringify([
        { index: 0, why: "a", topicalFit: 5, recencyScore: -3 },
        { index: 0, why: "dup", topicalFit: 0.5, recencyScore: 0.5 },
        { index: 1, why: "b", topicalFit: 0.5, recencyScore: 0.5 },
      ]);
    const seeds = await suggestSeeds(PROBLEM, llm, { searchArxiv, rateDelayMs: 0 });
    expect(seeds).toHaveLength(2);
    expect(seeds[0]?.topicalFit).toBe(1);
    expect(seeds[0]?.recencyScore).toBe(0);
  });

  it("returns [] (failure-isolated) when the LLM throws", async () => {
    const searchArxiv = async (): Promise<CrawledResource[]> => [mkResource("1.1", "P", 2020)];
    const llm = async (): Promise<string> => {
      throw new Error("llm down");
    };
    const seeds = await suggestSeeds(PROBLEM, llm, { searchArxiv, rateDelayMs: 0 });
    expect(seeds).toEqual([]);
  });

  it("returns [] when no arxiv candidates are found", async () => {
    const seeds = await suggestSeeds(PROBLEM, async () => "[]", {
      searchArxiv: async () => [],
      rateDelayMs: 0,
    });
    expect(seeds).toEqual([]);
  });
});
