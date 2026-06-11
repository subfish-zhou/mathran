import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchArxiv, fetchWikipediaSummary, sleep } from "./init-crawlers";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

const SAMPLE_ARXIV_XML = `<?xml version="1.0"?>
<feed>
  <entry>
    <id>https://arxiv.org/abs/2301.12345v1</id>
    <title>Test Paper Title</title>
    <summary>This is the abstract of the test paper</summary>
    <published>2023-01-15T00:00:00Z</published>
    <author><name>Alice Author</name></author>
    <author><name>Bob Author</name></author>
    <category term="math.AG"/>
    <category term="math.NT"/>
  </entry>
  <entry>
    <id>https://arxiv.org/abs/2302.54321</id>
    <title>Second Paper</title>
    <summary>Second abstract</summary>
    <published>2023-02-01T00:00:00Z</published>
    <author><name>Charlie</name></author>
  </entry>
</feed>`;

describe("searchArxiv", () => {
  it("parses arxiv XML response", async () => {
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(SAMPLE_ARXIV_XML) });
    const results = await searchArxiv("test query", 10);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("arxiv-2301.12345");
    expect(results[0]!.title).toBe("Test Paper Title");
    expect(results[0]!.authors).toEqual(["Alice Author", "Bob Author"]);
    expect(results[0]!.year).toBe(2023);
    expect(results[0]!.abstract).toBe("This is the abstract of the test paper");
    expect(results[0]!.categories).toEqual(["math.AG", "math.NT"]);
    expect(results[0]!.arxivId).toBe("2301.12345");
    expect(results[0]!.url).toBe("https://arxiv.org/abs/2301.12345");
    expect(results[0]!.sourceType).toBe("arxiv");
  });

  it("strips version from arxiv ID", async () => {
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(SAMPLE_ARXIV_XML) });
    const results = await searchArxiv("test", 10);
    expect(results[0]!.arxivId).toBe("2301.12345"); // v1 stripped
  });

  it("handles empty response", async () => {
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve("<feed></feed>") });
    const results = await searchArxiv("nothing", 5);
    expect(results).toEqual([]);
  });

  it("passes correct query params", async () => {
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve("<feed></feed>") });
    await searchArxiv("kakeya conjecture", 15);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("search_query=all%3Akakeya+conjecture");
    expect(url).toContain("max_results=15");
  });

  it("handles malformed entries gracefully", async () => {
    const xml = `<feed><entry><title>No ID</title></entry></feed>`;
    mockFetch.mockResolvedValueOnce({ text: () => Promise.resolve(xml) });
    const results = await searchArxiv("test", 5);
    expect(results).toEqual([]);
  });
});

describe("fetchWikipediaSummary", () => {
  it("returns extract from Wikipedia API", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ query: { pages: { "123": { extract: "Summary text" } } } }),
    });
    const result = await fetchWikipediaSummary("Kakeya set");
    expect(result).toBe("Summary text");
  });

  it("returns null when page not found", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ query: { pages: { "-1": {} } } }),
    });
    const result = await fetchWikipediaSummary("Nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const result = await fetchWikipediaSummary("Test");
    expect(result).toBeNull();
  });

  it("returns null for missing query", async () => {
    mockFetch.mockResolvedValueOnce({ json: () => Promise.resolve({}) });
    const result = await fetchWikipediaSummary("Test");
    expect(result).toBeNull();
  });
});

describe("sleep", () => {
  it("resolves after delay", async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
