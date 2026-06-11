/**
 * Paper crawlers — fetch publication metadata from arXiv, Google Scholar, and ORCID.
 *
 * Author-based crawling uses source-specific APIs (arXiv author query, SerpAPI, ORCID).
 * Topic-based search delegates to the shared crawl-pipeline (searchArxiv).
 */

import { XMLParser } from "fast-xml-parser";
import { FETCH_TIMEOUT_MS } from "../constants";
import { searchArxiv } from "../shared/crawl-pipeline";

export interface PaperMeta {
  source: "arxiv" | "scholar" | "orcid";
  externalId: string;
  title: string;
  authors: string[];
  abstract: string | null;
  publicationDate: string | null; // ISO date
  venue: string | null;
  url: string;
  citationCount: number;
}

// ID format validators
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const ARXIV_AUTHOR_RE = /^[a-zA-Z0-9._-]+$/;
const SCHOLAR_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ====================== arXiv ================================

/**
 * Crawl arXiv for papers by author ID using the arXiv API.
 */
export async function crawlArxiv(arxivAuthorId: string): Promise<PaperMeta[]> {
  if (!arxivAuthorId || arxivAuthorId.length > 100 || !ARXIV_AUTHOR_RE.test(arxivAuthorId)) {
    return [];
  }

  const maxResults = 100;
  const url = `https://export.arxiv.org/api/query?search_query=au:${encodeURIComponent(arxivAuthorId)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    console.error(`[crawlArxiv] HTTP ${res.status} for author ${arxivAuthorId}`);
    return [];
  }

  const xml = await res.text();
  return parseArxivAtom(xml);
}

function parseArxivAtom(xml: string): PaperMeta[] {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const parsed = parser.parse(xml);

  const feed = parsed?.feed;
  if (!feed?.entry) return [];

  const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
  const papers: PaperMeta[] = [];

  for (const entry of entries) {
    const rawId: string = typeof entry.id === "string" ? entry.id : "";
    const id = rawId.replace("http://arxiv.org/abs/", "");
    const title = (typeof entry.title === "string" ? entry.title : "").replace(/\s+/g, " ").trim();
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : null;
    const published = typeof entry.published === "string" ? entry.published : null;

    const authorNodes = entry.author
      ? Array.isArray(entry.author) ? entry.author : [entry.author]
      : [];
    const authors: string[] = authorNodes
      .map((a: { name?: string }) => (typeof a.name === "string" ? a.name.trim() : ""))
      .filter(Boolean);

    if (id && title) {
      papers.push({
        source: "arxiv",
        externalId: id,
        title,
        authors,
        abstract: summary,
        publicationDate: published ? new Date(published).toISOString() : null,
        venue: "arXiv",
        url: `https://arxiv.org/abs/${id}`,
        citationCount: 0,
      });
    }
  }

  return papers;
}

// ====================== Google Scholar ========================

/**
 * Crawl Google Scholar for papers. Uses SerpAPI if SERPAPI_KEY is set,
 * otherwise returns empty (Scholar has no public API).
 */
export async function crawlScholar(scholarId: string): Promise<PaperMeta[]> {
  if (!scholarId || scholarId.length > 20 || !SCHOLAR_ID_RE.test(scholarId)) {
    return [];
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    console.warn("[crawlScholar] SERPAPI_KEY not set — skipping Scholar crawl");
    return [];
  }

  // FIX [audit-2 H5] wrap fetch in try/catch and redact api_key from any
  // thrown error message — SerpAPI requires the key as a query param so the
  // URL contains it; uncaught network errors could leak it via upstream
  // logs (AgentRunLogger, fire-and-forget verifications, etc.).
  // NOTE: SerpAPI only supports API key via query parameter. Ensure this URL is never logged.
  const url = `https://serpapi.com/search.json?engine=google_scholar_author&author_id=${encodeURIComponent(scholarId)}&api_key=${apiKey}&num=100`;

  const redactKey = (msg: string) => msg.replace(/api_key=[^&\s]+/g, "api_key=REDACTED");

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[crawlScholar] network error: ${redactKey(msg)}`);
    return [];
  }
  if (!res.ok) {
    console.error(`[crawlScholar] HTTP ${res.status} for scholar ${scholarId}`);
    return [];
  }

  const data = await res.json() as {
    articles?: Array<{
      title?: string;
      authors?: string;
      year?: string;
      link?: string;
      citation_id?: string;
      cited_by?: { value?: number };
    }>;
  };

  return (data.articles ?? [])
    .filter((a) => a.title)
    .map((a) => ({
      source: "scholar" as const,
      externalId: a.citation_id ?? a.title ?? "",
      title: a.title ?? "",
      authors: a.authors?.split(",").map((s) => s.trim()) ?? [],
      abstract: null,
      publicationDate: a.year ? `${a.year}-01-01T00:00:00Z` : null,
      venue: null,
      url: a.link ?? "",
      citationCount: a.cited_by?.value ?? 0,
    }));
}

// ====================== ORCID ================================

/**
 * Crawl ORCID public API for papers by ORCID iD.
 */
export async function crawlOrcid(orcid: string): Promise<PaperMeta[]> {
  if (!ORCID_RE.test(orcid)) {
    return [];
  }

  const url = `https://pub.orcid.org/v3.0/${encodeURIComponent(orcid)}/works`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(`[crawlOrcid] HTTP ${res.status} for ORCID ${orcid}`);
    return [];
  }

  const data = await res.json() as {
    group?: Array<{
      "work-summary"?: Array<{
        title?: { title?: { value?: string } };
        "external-ids"?: {
          "external-id"?: Array<{
            "external-id-type"?: string;
            "external-id-value"?: string;
            "external-id-url"?: { value?: string };
          }>;
        };
        "publication-date"?: {
          year?: { value?: string };
          month?: { value?: string };
        };
        "journal-title"?: { value?: string };
      }>;
    }>;
  };

  const papers: PaperMeta[] = [];

  for (const group of data.group ?? []) {
    const summary = group["work-summary"]?.[0];
    if (!summary) continue;

    const title = summary.title?.title?.value;
    if (!title) continue;

    const extIds = summary["external-ids"]?.["external-id"] ?? [];
    const doi = extIds.find((e) => e["external-id-type"] === "doi");
    const externalId = doi?.["external-id-value"] ?? title;
    const extUrl = doi?.["external-id-url"]?.value ?? "";

    const pubDate = summary["publication-date"];
    const year = pubDate?.year?.value;
    const month = pubDate?.month?.value ?? "01";
    const dateStr = year ? `${year}-${month.padStart(2, "0")}-01T00:00:00Z` : null;

    papers.push({
      source: "orcid",
      externalId,
      title,
      authors: [],
      abstract: null,
      publicationDate: dateStr,
      venue: summary["journal-title"]?.value ?? null,
      url: extUrl,
      citationCount: 0,
    });
  }

  return papers;
}

// ====================== Topic-based search (shared pipeline) ==========

/**
 * Search arXiv by topic/keyword using the shared crawl-pipeline.
 * Returns PaperMeta[] for consistency with author-based crawlers.
 *
 * @param query  Free-text search query (topic, keyword, problem title)
 * @param maxResults  Maximum papers to return (default 5)
 */
export async function searchPapersByTopic(
  query: string,
  maxResults = 5,
): Promise<PaperMeta[]> {
  if (!query.trim()) return [];

  try {
    const results = await searchArxiv(query, maxResults);

    return results.map((r) => ({
      source: "arxiv" as const,
      externalId: r.arxivId ?? r.id,
      title: r.title,
      authors: r.authors,
      abstract: r.abstract ?? null,
      publicationDate: r.year ? `${r.year}-01-01T00:00:00Z` : null,
      venue: "arXiv",
      url: r.url,
      citationCount: 0,
    }));
  } catch (err) {
    console.error(`[searchPapersByTopic] Failed for query "${query}":`, err);
    return [];
  }
}
