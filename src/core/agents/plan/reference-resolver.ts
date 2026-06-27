/**
 * Reference resolution for the Plan Agent — port of mathub's `resolveLink` and
 * the surrounding ref-parsing helpers.
 *
 * Detects whether a user-supplied string is an arxiv id, a DOI, or a plain URL,
 * then (best-effort) enriches arxiv references with metadata pulled from the
 * arxiv API. Failure-isolated: a reference that cannot be resolved is still
 * returned (with `resolved: false`) so the Plan flow never breaks.
 */

import type { ParsedReference } from "./types.js";
import {
  fetchArxivById as realFetchArxivById,
  type FetchLike,
} from "../init-project/crawlers.js";
import type { CrawledResource } from "../init-project/types.js";

/** arxiv ids: new (1501.00001) or legacy (math.NT/0501001). */
const ARXIV_NEW_RE = /(\d{4}\.\d{4,5})(?:v\d+)?/;
const ARXIV_OLD_RE = /([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/;
/** DOI: 10.<registrant>/<suffix>. */
const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9]+)\b/i;

/** Extract an arxiv id from an arbitrary string (URL, "arXiv:..", bare id). */
export function extractArxivId(input: string): string | undefined {
  // Avoid matching the "10.xxxx" of a DOI as an arxiv id by checking arxiv
  // markers first.
  const lower = input.toLowerCase();
  const looksArxiv =
    lower.includes("arxiv") || ARXIV_NEW_RE.test(input) || ARXIV_OLD_RE.test(input);
  if (!looksArxiv) return undefined;
  const m = input.match(ARXIV_NEW_RE) || input.match(ARXIV_OLD_RE);
  return m?.[1];
}

/** Extract a DOI from an arbitrary string. */
export function extractDoi(input: string): string | undefined {
  const m = input.match(DOI_RE);
  return m?.[1];
}

/**
 * Parse a raw reference string into a typed `ParsedReference` WITHOUT touching
 * the network. Detection order: arxiv → doi → url → unknown.
 */
export function parseReference(input: string): ParsedReference {
  const original = input.trim();

  const arxivId = extractArxivId(original);
  if (arxivId) {
    return {
      originalInput: original,
      type: "arxiv",
      arxivId,
      url: `https://arxiv.org/abs/${arxivId}`,
      resolved: false,
    };
  }

  const doi = extractDoi(original);
  if (doi) {
    return {
      originalInput: original,
      type: "doi",
      doi,
      url: `https://doi.org/${doi}`,
      resolved: false,
    };
  }

  if (/^https?:\/\//i.test(original)) {
    return { originalInput: original, type: "url", url: original, resolved: false };
  }

  return { originalInput: original, type: "unknown", resolved: false };
}

function applyArxivMetadata(
  ref: ParsedReference,
  res: CrawledResource,
): ParsedReference {
  return {
    ...ref,
    resolved: true,
    title: res.title ?? ref.title,
    authors: res.authors ?? ref.authors,
    year: res.year ?? ref.year,
    abstract: res.abstract ?? ref.abstract,
    url: res.url ?? ref.url,
  };
}

export interface ResolveDeps {
  /** Test seam — defaults to the real arxiv crawler. */
  fetchArxivById?: (arxivId: string, fetchImpl?: FetchLike) => Promise<CrawledResource | null>;
}

/**
 * Resolve a single reference, enriching arxiv refs with metadata. DOI / URL /
 * unknown refs are returned unchanged (resolution deferred — mathran ships no
 * Crossref/S2 client). Never throws.
 */
export async function resolveReference(
  ref: ParsedReference,
  deps: ResolveDeps = {},
): Promise<ParsedReference> {
  const fetchArxiv = deps.fetchArxivById ?? realFetchArxivById;
  if (ref.type === "arxiv" && ref.arxivId) {
    try {
      const res = await fetchArxiv(ref.arxivId);
      if (res) return applyArxivMetadata(ref, res);
    } catch {
      /* failure-isolated */
    }
  }
  return ref;
}

/**
 * Parse + resolve a list of raw reference strings. Resolution runs
 * sequentially to respect arxiv's rate limit. Empty input → empty array.
 */
export async function resolveReferences(
  inputs: string[],
  deps: ResolveDeps = {},
): Promise<ParsedReference[]> {
  const out: ParsedReference[] = [];
  for (const raw of inputs) {
    if (!raw || !raw.trim()) continue;
    out.push(await resolveReference(parseReference(raw), deps));
  }
  return out;
}
