/**
 * Pure (React-free) helpers for ReferenceLinksInput. Kept in a standalone
 * module so they can be unit-tested under the root vitest config without
 * pulling in `react` (web/ has no @testing-library/react).
 */

export type ReferenceType = "arxiv" | "doi" | "url" | "unknown";

export interface ClassifiedReference {
  type: ReferenceType;
  /** Canonical form: bare arXiv id, bare DOI, or the trimmed url/input. */
  normalized: string;
}

/** `1234.5678`, optional `arXiv:` prefix and `v2` version suffix. */
const ARXIV_RE = /^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i;
/** A bare DOI (optionally prefixed with `doi:` or a doi.org URL). */
const DOI_BARE_RE = /^10\.\d{4,}\/\S+$/;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Classify a raw reference string into an arXiv id, DOI, URL, or unknown, and
 * produce a normalized canonical form. Never throws; an empty/whitespace input
 * yields `{ type: "unknown", normalized: "" }`.
 */
export function classifyReference(input: string): ClassifiedReference {
  const trimmed = input.trim();
  if (!trimmed) return { type: "unknown", normalized: "" };

  const arxiv = trimmed.match(ARXIV_RE);
  if (arxiv) return { type: "arxiv", normalized: arxiv[1]!.toLowerCase() };

  // `doi:10.x/...` or a doi.org URL → extract the bare DOI.
  const doiPrefixed = trimmed.replace(/^doi:\s*/i, "");
  const doiFromUrl = trimmed.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,}\/\S+)$/i);
  if (doiFromUrl) return { type: "doi", normalized: doiFromUrl[1]! };
  if (DOI_BARE_RE.test(doiPrefixed)) return { type: "doi", normalized: doiPrefixed };

  if (isHttpUrl(trimmed)) return { type: "url", normalized: trimmed };

  return { type: "unknown", normalized: trimmed };
}

/** True when the input classifies as a recognized arXiv/DOI/URL reference. */
export function isValidReference(input: string): boolean {
  return classifyReference(input).type !== "unknown";
}
