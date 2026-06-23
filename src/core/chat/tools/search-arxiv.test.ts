import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FetchLike } from "../../agents/init-project/crawlers.js";
import {
  createSearchArxivTool,
  _resetArxivRateLimit,
} from "./search-arxiv.js";

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1311.1234v2</id>
    <title>Bounded gaps between primes</title>
    <summary>We prove that there are bounded gaps.</summary>
    <published>2013-11-01T00:00:00Z</published>
    <author><name>Yitang Zhang</name></author>
    <category term="math.NT" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1505.5678</id>
    <title>Sieve methods</title>
    <summary>An overview of sieves.</summary>
    <published>2015-05-01T00:00:00Z</published>
    <author><name>A. Author</name></author>
    <author><name>B. Author</name></author>
    <category term="math.NT" />
  </entry>
</feed>`;

function fakeFetch(text: string): FetchLike {
  return async () => ({
    async text() {
      return text;
    },
    async json() {
      return {};
    },
  });
}

describe("search_arxiv tool", () => {
  beforeEach(() => {
    _resetArxivRateLimit();
  });

  it("parses sample Atom into chat-friendly results", async () => {
    const tool = createSearchArxivTool({ fetchImpl: fakeFetch(SAMPLE_ATOM), rateMs: 0 });
    const res = await tool.execute({ query: "primes" });
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.content);
    expect(parsed.count).toBe(2);
    expect(parsed.query).toBe("primes");
    expect(parsed.results[0]).toMatchObject({
      arxivId: "1311.1234",
      title: "Bounded gaps between primes",
      year: 2013,
      url: "https://arxiv.org/abs/1311.1234",
      categories: ["math.NT"],
    });
    expect(parsed.results[1].authors).toEqual(["A. Author", "B. Author"]);
  });

  it("rejects empty / whitespace-only query", async () => {
    const tool = createSearchArxivTool({ fetchImpl: fakeFetch(SAMPLE_ATOM), rateMs: 0 });
    const empty = await tool.execute({ query: "" });
    expect(empty.ok).toBe(false);
    expect(empty.content).toContain("query");
    const ws = await tool.execute({ query: "   " });
    expect(ws.ok).toBe(false);
  });

  it("clamps limit to 1..50", async () => {
    const spy = vi.fn(fakeFetch(SAMPLE_ATOM));
    const tool = createSearchArxivTool({ fetchImpl: spy, rateMs: 0 });
    await tool.execute({ query: "x", limit: -5 });
    expect(spy.mock.calls[0]![0] as string).toContain("max_results=1");
    _resetArxivRateLimit();
    await tool.execute({ query: "x", limit: 999 });
    expect(spy.mock.calls[1]![0] as string).toContain("max_results=50");
  });

  it("falls back to relevance for an invalid sortBy", async () => {
    const spy = vi.fn(fakeFetch(SAMPLE_ATOM));
    const tool = createSearchArxivTool({ fetchImpl: spy, rateMs: 0 });
    await tool.execute({ query: "x", sortBy: "bogus" });
    expect(spy.mock.calls[0]![0] as string).toContain("sortBy=relevance");
  });

  it("passes sortBy=lastUpdatedDate through to the URL", async () => {
    const spy = vi.fn(fakeFetch(SAMPLE_ATOM));
    const tool = createSearchArxivTool({ fetchImpl: spy, rateMs: 0 });
    await tool.execute({ query: "x", sortBy: "lastUpdatedDate" });
    expect(spy.mock.calls[0]![0] as string).toContain("sortBy=lastUpdatedDate");
  });

  it("builds an all: query for plain text and preserves operator queries", async () => {
    const spy = vi.fn(fakeFetch(SAMPLE_ATOM));
    const tool = createSearchArxivTool({ fetchImpl: spy, rateMs: 0 });
    await tool.execute({ query: "sieve theory" });
    expect(spy.mock.calls[0]![0] as string).toContain("all%3Asieve");
    _resetArxivRateLimit();
    await tool.execute({ query: "au:Zhang AND cat:math.NT" });
    expect(spy.mock.calls[1]![0] as string).not.toContain("all%3A");
  });

  it("spaces back-to-back calls by at least rateMs", async () => {
    const tool = createSearchArxivTool({ fetchImpl: fakeFetch(SAMPLE_ATOM), rateMs: 50 });
    const start = Date.now();
    await tool.execute({ query: "a" });
    await tool.execute({ query: "b" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it("returns { ok: false } with an error message when fetch throws", async () => {
    const throwing: FetchLike = async () => {
      throw new Error("network down");
    };
    const tool = createSearchArxivTool({ fetchImpl: throwing, rateMs: 0 });
    const res = await tool.execute({ query: "x" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("error");
    expect(res.content).toContain("network down");
  });
});
