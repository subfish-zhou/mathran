import { describe, expect, it, vi } from "vitest";

import {
  searchArxiv,
  fetchWikipediaSummary,
  parseArxivAtom,
  sleep,
  ARXIV_RATE_DELAY,
  type FetchLike,
} from "./crawlers.js";

const SAMPLE_ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1311.1234v2</id>
    <title>Bounded gaps
    between primes</title>
    <summary>We prove that there are infinitely many primes.</summary>
    <published>2013-11-01T00:00:00Z</published>
    <author><name>Yitang Zhang</name></author>
    <category term="math.NT" />
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002</id>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <published>2024-01-02T00:00:00Z</published>
    <author><name>A. Author</name></author>
    <author><name>B. Author</name></author>
    <category term="math.CA" />
  </entry>
</feed>`;

function fakeFetch(opts: { text?: string; json?: unknown }): FetchLike {
  return async () => ({
    async text() {
      return opts.text ?? "";
    },
    async json() {
      return opts.json ?? {};
    },
  });
}

describe("parseArxivAtom", () => {
  it("parses entries with id/title/authors/year/categories", () => {
    const res = parseArxivAtom(SAMPLE_ATOM);
    expect(res.length).toBe(2);
    expect(res[0]).toMatchObject({
      id: "arxiv-1311.1234",
      arxivId: "1311.1234",
      title: "Bounded gaps between primes",
      year: 2013,
      sourceType: "arxiv",
      url: "https://arxiv.org/abs/1311.1234",
    });
    expect(res[0]!.authors).toEqual(["Yitang Zhang"]);
    expect(res[0]!.categories).toEqual(["math.NT"]);
  });

  it("strips version suffix from arxiv id", () => {
    const res = parseArxivAtom(SAMPLE_ATOM);
    expect(res[0]!.arxivId).toBe("1311.1234");
  });

  it("collects multiple authors", () => {
    const res = parseArxivAtom(SAMPLE_ATOM);
    expect(res[1]!.authors).toEqual(["A. Author", "B. Author"]);
  });

  it("returns empty for non-matching xml", () => {
    expect(parseArxivAtom("<feed></feed>")).toEqual([]);
  });
});

describe("searchArxiv", () => {
  it("fetches and parses results via injected fetch", async () => {
    const res = await searchArxiv("twin primes", 5, fakeFetch({ text: SAMPLE_ATOM }));
    expect(res.length).toBe(2);
    expect(res[0]!.title).toContain("Bounded gaps");
  });

  it("builds an all: query when no operators present", async () => {
    const spy = vi.fn(fakeFetch({ text: SAMPLE_ATOM }));
    await searchArxiv("sieve theory", 3, spy);
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain("search_query=all%3Asieve");
  });

  it("preserves boolean operator queries as-is", async () => {
    const spy = vi.fn(fakeFetch({ text: SAMPLE_ATOM }));
    await searchArxiv("au:Zhang AND cat:math.NT", 3, spy);
    const url = spy.mock.calls[0]![0] as string;
    expect(url).not.toContain("all%3A");
  });
});

describe("fetchWikipediaSummary", () => {
  it("extracts the page intro", async () => {
    const json = { query: { pages: { "123": { extract: "Twin primes are pairs." } } } };
    const res = await fetchWikipediaSummary("Twin prime", fakeFetch({ json }));
    expect(res).toBe("Twin primes are pairs.");
  });

  it("returns null when no pages present", async () => {
    const res = await fetchWikipediaSummary("Nope", fakeFetch({ json: { query: {} } }));
    expect(res).toBeNull();
  });

  it("returns null on fetch error", async () => {
    const throwing: FetchLike = async () => {
      throw new Error("network");
    };
    expect(await fetchWikipediaSummary("X", throwing)).toBeNull();
  });
});

describe("sleep / rate limit", () => {
  it("ARXIV_RATE_DELAY honours the 3 req/s limit", () => {
    expect(ARXIV_RATE_DELAY).toBeGreaterThanOrEqual(3000);
  });

  it("sleep resolves after the delay", async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });
});
