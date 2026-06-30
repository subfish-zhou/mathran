/**
 * Frontier arxiv fetcher — calls arxiv API with `sortBy=submittedDate` to
 * surface RECENT preprints in a category + keyword combination. Distinct
 * from `crawlers.ts#searchArxiv` (which uses `relevance` sort and is shared
 * by prior-art + read-loop title resolution — we don't want to break those
 * by changing their sort order).
 *
 * Returns `FrontierCandidate[]` already deduplicated against the
 * `alreadyKnown` set and time-filtered to ≥ `(currentYear - yearWindow)`.
 *
 * Failure-isolated: network error / bad XML → empty array + logged.
 */

import { sleep, ARXIV_SEARCH_URL, ARXIV_RATE_DELAY, parseArxivAtom } from "../crawlers.js";
import type { CrawledResource } from "../types.js";
import type { FrontierCandidate, FrontierConcept } from "./types.js";
import {
  FRONTIER_MAX_RESULTS_PER_CONCEPT,
  FRONTIER_YEAR_WINDOW_DEFAULT,
} from "./types.js";

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ text: () => Promise<string>; ok?: boolean; status?: number }>;

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as ReturnType<FetchLike>;

export interface FrontierArxivFetcherDeps {
  fetchImpl?: FetchLike;
  /** ms between requests to respect arxiv's ~3 req/s ceiling. */
  rateDelayMs?: number;
  /** How recent (years) candidates must be. Default 3. */
  yearWindow?: number;
  /** Max results per concept query. Default 15. */
  maxPerConcept?: number;
  /** Year override for tests (default: new Date().getFullYear()). */
  currentYear?: number;
  /** Logger seam. */
  log?: (msg: string) => void;
}

/**
 * Single concept query → candidate list. Public for unit testing.
 */
export async function fetchOneConcept(
  concept: FrontierConcept,
  alreadyKnown: Set<string>,
  deps: FrontierArxivFetcherDeps = {},
): Promise<FrontierCandidate[]> {
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const maxPerConcept = deps.maxPerConcept ?? FRONTIER_MAX_RESULTS_PER_CONCEPT;
  const yearWindow = deps.yearWindow ?? FRONTIER_YEAR_WINDOW_DEFAULT;
  const currentYear = deps.currentYear ?? new Date().getFullYear();
  const minYear = currentYear - yearWindow;
  const log = deps.log ?? (() => {});

  // arxiv API requires submittedDate sort to surface recent work.
  // start=0, max=maxPerConcept — we don't paginate further; if the
  // first page is exhausted by dedup, that concept is "saturated".
  const url =
    `${ARXIV_SEARCH_URL}?search_query=${concept.arxivQuery}` +
    `&start=0&max_results=${maxPerConcept}` +
    `&sortBy=submittedDate&sortOrder=descending`;

  let xml: string;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    xml = await res.text();
  } catch (err) {
    log(`[frontier] arxiv fetch failed for "${concept.label}": ${errMsg(err)}`);
    return [];
  }

  let parsed: CrawledResource[];
  try {
    parsed = parseArxivAtom(xml);
  } catch (err) {
    log(`[frontier] arxiv parse failed for "${concept.label}": ${errMsg(err)}`);
    return [];
  }

  const out: FrontierCandidate[] = [];
  for (const r of parsed) {
    const arxivId = r.arxivId ?? r.id;
    if (!arxivId) continue;
    if (alreadyKnown.has(arxivId)) continue;
    // Time filter — drop anything older than the window.
    if (typeof r.year === "number" && r.year < minYear) continue;
    out.push({
      arxivId,
      title: r.title,
      authors: r.authors,
      year: r.year ?? currentYear,
      abstract: r.abstract ?? "",
      fromConcept: concept.label,
    });
    // Mark as seen so a later concept's hits don't duplicate.
    alreadyKnown.add(arxivId);
  }
  return out;
}

/**
 * Multi-concept tick fetch. Runs concepts serially with `rateDelayMs`
 * between requests to respect arxiv's rate limit. Returns the aggregated
 * candidate list across all concepts + a per-concept count for logging.
 *
 * `alreadyKnown` is MUTATED (each yielded arxivId is added) so the same
 * Set can be passed to subsequent ticks.
 */
export async function fetchAllConcepts(
  concepts: FrontierConcept[],
  alreadyKnown: Set<string>,
  deps: FrontierArxivFetcherDeps = {},
): Promise<{ candidates: FrontierCandidate[]; perConcept: Array<{ concept: string; fetched: number }> }> {
  const rateDelayMs = deps.rateDelayMs ?? ARXIV_RATE_DELAY;
  const all: FrontierCandidate[] = [];
  const perConcept: Array<{ concept: string; fetched: number }> = [];
  for (let i = 0; i < concepts.length; i++) {
    if (i > 0) await sleep(rateDelayMs);
    const c = concepts[i]!;
    const hits = await fetchOneConcept(c, alreadyKnown, deps);
    all.push(...hits);
    perConcept.push({ concept: c.label, fetched: hits.length });
  }
  return { candidates: all, perConcept };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
