import { describe, expect, it } from "vitest";
import type { CrawledResource } from "../types.js";
import type { SpineLLM } from "../spine/llm.js";
import {
  searchArxivSurveys,
  buildSurveyQueries,
  type SearchArxivFn,
} from "./arxiv-survey-search.js";

const problem = {
  title: "Lonely Runner Conjecture",
  tags: ["math.NT", "combinatorics"],
  formalStatement: "For n runners ...",
};

function res(over: Partial<CrawledResource> & { arxivId: string; title: string }): CrawledResource {
  return {
    id: `arxiv-${over.arxivId}`,
    authors: ["A. Author"],
    sourceType: "arxiv",
    url: `https://arxiv.org/abs/${over.arxivId}`,
    ...over,
  } as CrawledResource;
}

describe("buildSurveyQueries", () => {
  it("emits a title query and category/free-text tag queries", () => {
    const qs = buildSurveyQueries(problem);
    expect(qs.some((q) => q.includes('all:"Lonely Runner Conjecture"'))).toBe(true);
    expect(qs.some((q) => q.includes("cat:math.NT"))).toBe(true);
    expect(qs.some((q) => q.includes('all:"combinatorics"'))).toBe(true);
    expect(qs.length).toBeLessThanOrEqual(5);
  });
});

describe("searchArxivSurveys", () => {
  it("ranks candidates by LLM surveyConfidence and discards below threshold", async () => {
    const search: SearchArxivFn = async () => [
      res({ arxivId: "2401.00001", title: "A Survey of the Lonely Runner Conjecture", abstract: "We survey ..." }),
      res({ arxivId: "2401.00002", title: "A new bound for n=7", abstract: "We prove ..." }),
      res({ arxivId: "2401.00003", title: "Introduction to Diophantine approximation", abstract: "Lecture notes ..." }),
    ];
    const llm: SpineLLM = async () =>
      JSON.stringify([
        { index: 0, surveyConfidence: 0.9, matchedReason: "Clear survey" },
        { index: 1, surveyConfidence: 0.1, matchedReason: "Primary research" },
        { index: 2, surveyConfidence: 0.6, matchedReason: "Lecture notes" },
      ]);

    const hits = await searchArxivSurveys(problem, { llm, searchArxiv: search, rateDelayMs: 0 });
    expect(hits.map((h) => h.arxivId)).toEqual(["2401.00001", "2401.00003"]);
    expect(hits[0]!.surveyConfidence).toBeGreaterThan(hits[1]!.surveyConfidence);
    expect(hits[0]!.source).toBe("arxiv");
  });

  it("floors confidence for crawler isSurvey=true candidates", async () => {
    const search: SearchArxivFn = async () => [
      res({ arxivId: "2401.10000", title: "Some paper", isSurvey: true }),
    ];
    const llm: SpineLLM = async () => JSON.stringify([{ index: 0, surveyConfidence: 0.1, matchedReason: "low" }]);
    const hits = await searchArxivSurveys(problem, { llm, searchArxiv: search, rateDelayMs: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.surveyConfidence).toBeGreaterThanOrEqual(0.5);
  });

  it("dedupes by arxivId across queries", async () => {
    const search: SearchArxivFn = async () => [
      res({ arxivId: "2401.55555", title: "Survey X", abstract: "survey" }),
    ];
    const llm: SpineLLM = async () => JSON.stringify([{ index: 0, surveyConfidence: 0.8, matchedReason: "s" }]);
    const hits = await searchArxivSurveys(problem, { llm, searchArxiv: search, rateDelayMs: 0 });
    expect(hits).toHaveLength(1);
  });

  it("is failure-isolated: returns [] when search throws", async () => {
    const search: SearchArxivFn = async () => {
      throw new Error("network down");
    };
    const llm: SpineLLM = async () => "[]";
    const hits = await searchArxivSurveys(problem, { llm, searchArxiv: search, rateDelayMs: 0 });
    expect(hits).toEqual([]);
  });

  it("returns [] when LLM output is unparseable (no scores → all below threshold)", async () => {
    const search: SearchArxivFn = async () => [res({ arxivId: "2401.99999", title: "X" })];
    const llm: SpineLLM = async () => "not json at all";
    const hits = await searchArxivSurveys(problem, { llm, searchArxiv: search, rateDelayMs: 0 });
    expect(hits).toEqual([]);
  });
});
