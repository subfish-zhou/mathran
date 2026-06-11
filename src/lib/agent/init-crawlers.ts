/**
 * Web crawling and external API fetching for the Initialization Agent.
 * Covers arXiv search and Wikipedia summary retrieval.
 */

import type { CrawledResource } from "./init-types";

export const ARXIV_SEARCH_URL = "https://export.arxiv.org/api/query";
export const ARXIV_RATE_DELAY = 3500; // 3 req/s limit → 3.5s between requests
export const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";

export async function searchArxiv(query: string, maxResults: number): Promise<CrawledResource[]> {
  // FIX [audit-2 L3] document: arXiv API does NOT support `sortBy:` as a
  // field-prefix inside `search_query`. Sort order is configured via the
  // top-level `sortBy=` parameter we set below; any `sortBy:foo` written
  // inside `query` will be silently ignored. Callers wanting submission-
  // date ordering should call this function without operator syntax and
  // instead branch on caller intent — or extend this signature to accept
  // a `sort` option.
  // If query already contains boolean operators or field prefixes, use as-is
  const hasOperators = /\b(AND|OR|ANDNOT)\b/.test(query) || /\b\w+:/.test(query);
  const searchQuery = hasOperators ? query : `all:${query}`;
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: "0",
    max_results: String(maxResults),
    sortBy: "relevance",
    sortOrder: "descending",
  });

  const response = await fetch(`${ARXIV_SEARCH_URL}?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const xml = await response.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const results: CrawledResource[] = [];

  for (const [, entryXml] of entries) {
    if (!entryXml) continue;

    // Extract arXiv ID from <id> tag
    const idMatch = entryXml.match(/<id>https?:\/\/arxiv\.org\/abs\/((?:\d{4}\.\d{4,5}|[a-z\-]+\/\d{7})(?:v\d+)?)<\/id>/);
    const rawId = idMatch?.[1]?.replace(/v\d+$/, "");
    if (!rawId) continue;

    // Title
    const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "Untitled";

    // Authors
    const authors = [...entryXml.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]!);

    // Abstract
    const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/);
    const abstract = summaryMatch?.[1]?.replace(/\s+/g, " ").trim();

    // Published date
    const publishedMatch = entryXml.match(/<published>(\d{4})/);
    const year = publishedMatch ? parseInt(publishedMatch[1]!, 10) : undefined;

    // Categories
    const categories = [...entryXml.matchAll(/category[^>]*term="([^"]+)"/g)].map((m) => m[1]!);

    // Code links from <link> tags with rel='related' and title='code'
    const codeUrls = [...entryXml.matchAll(/<link[^>]*rel=["']related["'][^>]*title=["']code["'][^>]*href=["']([^"']+)["'][^>]*\/?>/g)]
      .map((m) => m[1]!)
      .concat(
        [...entryXml.matchAll(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']related["'][^>]*title=["']code["'][^>]*\/?>/g)]
          .map((m) => m[1]!)
      )
      .filter((url, i, arr) => arr.indexOf(url) === i);

    results.push({
      id: `arxiv-${rawId}`,
      title,
      authors,
      year,
      sourceType: "arxiv",
      arxivId: rawId,
      url: `https://arxiv.org/abs/${rawId}`,
      abstract,
      categories,
      ...(codeUrls.length > 0 ? { codeUrls } : {}),
    });
  }

  return results;
}

/** Fetch Wikipedia summary for a topic */
export async function fetchWikipediaSummary(topic: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      action: "query",
      titles: topic,
      prop: "extracts",
      exintro: "1",
      explaintext: "1",
      format: "json",
      redirects: "1",
    });
    const res = await fetch(WIKIPEDIA_API_URL + "?" + params, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json() as { query?: { pages?: Record<string, { extract?: string }> } };
    const pages = data?.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    return page?.extract || null;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
