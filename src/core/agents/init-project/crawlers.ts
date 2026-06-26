/**
 * Web crawling for the init-project agent: arXiv search (Atom XML) + Wikipedia
 * summary. Ported verbatim in spirit from mathub's `init-crawlers.ts`, with a
 * `fetchImpl` injection seam so tests never hit the network.
 *
 * arXiv enforces ~3 req/s; callers MUST `sleep(ARXIV_RATE_DELAY)` between
 * requests. Do not parallelize arXiv fetches.
 */

import type { CrawledResource } from "./types.js";

export const ARXIV_SEARCH_URL = "https://export.arxiv.org/api/query";
export const ARXIV_RATE_DELAY = 3500; // 3 req/s limit → 3.5s between requests
export const WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php";

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse arXiv Atom XML into CrawledResources. Exported for unit testing. */
export function parseArxivAtom(xml: string): CrawledResource[] {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const results: CrawledResource[] = [];

  for (const [, entryXml] of entries) {
    if (!entryXml) continue;

    const idMatch = entryXml.match(
      /<id>https?:\/\/arxiv\.org\/abs\/((?:\d{4}\.\d{4,5}|[a-z\-]+\/\d{7})(?:v\d+)?)<\/id>/,
    );
    const rawId = idMatch?.[1]?.replace(/v\d+$/, "");
    if (!rawId) continue;

    const titleMatch = entryXml.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "Untitled";

    const authors = [...entryXml.matchAll(/<name>(.*?)<\/name>/g)].map((m) => m[1]!);

    const summaryMatch = entryXml.match(/<summary>([\s\S]*?)<\/summary>/);
    const abstract = summaryMatch?.[1]?.replace(/\s+/g, " ").trim();

    const publishedMatch = entryXml.match(/<published>(\d{4})/);
    const year = publishedMatch ? parseInt(publishedMatch[1]!, 10) : undefined;

    const categories = [...entryXml.matchAll(/category[^>]*term="([^"]+)"/g)].map((m) => m[1]!);

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
    });
  }

  return results;
}

export async function searchArxiv(
  query: string,
  maxResults: number,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CrawledResource[]> {
  const hasOperators = /\b(AND|OR|ANDNOT)\b/.test(query) || /\b\w+:/.test(query);
  const searchQuery = hasOperators ? query : `all:${query}`;
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: "0",
    max_results: String(maxResults),
    sortBy: "relevance",
    sortOrder: "descending",
  });

  const response = await fetchImpl(`${ARXIV_SEARCH_URL}?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const xml = await response.text();
  return parseArxivAtom(xml);
}

/**
 * Fetch one arxiv paper by id (precise lookup, no relevance ranking).
 * Uses arxiv's `id_list` query param which is much faster than
 * full-text search for known ids. Returns `null` on network failure /
 * unknown id so callers can degrade gracefully.
 *
 * 2026-06-26 — extracted from src/server/paper-routes.ts and exposed
 * here so the init-project agent can ENRICH seed references that come
 * in with only an arxivId (a real gap vs mathub, where the DB-write
 * path pulled title/authors/year/abstract from arxiv automatically).
 */
export async function fetchArxivById(
  arxivId: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<CrawledResource | null> {
  try {
    const params = new URLSearchParams({ id_list: arxivId, max_results: "1" });
    const response = await fetchImpl(`${ARXIV_SEARCH_URL}?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const xml = await response.text();
    if (!xml || xml.indexOf("<entry") === -1) return null;
    const parsed = parseArxivAtom(xml);
    return parsed.length > 0 ? parsed[0] : null;
  } catch {
    return null;
  }
}

/** Fetch the intro extract for a Wikipedia topic, or null on any failure. */
export async function fetchWikipediaSummary(
  topic: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string | null> {
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
    const res = await fetchImpl(WIKIPEDIA_API_URL + "?" + params, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { query?: { pages?: Record<string, { extract?: string }> } };
    const pages = data?.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    return page?.extract || null;
  } catch {
    return null;
  }
}
