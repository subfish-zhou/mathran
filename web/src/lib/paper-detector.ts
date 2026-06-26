/**
 * Detect arXiv / DOI references in chat text so the SPA can render a
 * PaperCard instead of a plain markdown link.
 *
 * Patterns recognized (case-insensitive):
 *   - URL                    https://arxiv.org/abs/2401.12345
 *                            https://arxiv.org/pdf/2401.12345v2
 *                            http://arxiv.org/abs/cs.LG/0412020 (old format)
 *   - Bare label             arXiv:2401.12345
 *                            arXiv:cs.LG/0412020
 *   - DOI URL                https://doi.org/10.1090/jams/123
 *                            https://dx.doi.org/10.48550/arXiv.2401.12345
 *   - Bare DOI label         doi:10.1090/jams/123
 *
 * Returns a flat list of disjoint matches with absolute char offsets
 * into the input string, sorted by `start` ascending. Overlapping
 * matches (e.g. an arxiv URL inside a markdown link `[arXiv:X](URL)`)
 * are collapsed to the OUTERMOST match so the renderer never
 * double-replaces a region.
 *
 * Special-case: arXiv DOIs (10.48550/arxiv.NNNN.NNNNN) round-trip to
 * scheme="arxiv" so the SPA's lookup cache doesn't split the same
 * paper into two records.
 *
 * 2026-06-26 (user-distillation Phase 2).
 */

export type PaperRefScheme = "arxiv" | "doi";

export interface PaperRef {
  /** Identifier scheme. */
  scheme: PaperRefScheme;
  /** Canonical id — `2401.12345` for arxiv, full doi for doi. */
  id: string;
  /** Absolute character offset into the input string (inclusive). */
  start: number;
  /** Length of the matched substring. End offset = start + length. */
  length: number;
  /** The verbatim matched substring (debug + accessibility). */
  raw: string;
}

// Modern arXiv id: YYMM.NNNNN(vN)? — 4 digit yymm, dot, 4-5 digit number.
const MODERN_ARXIV_RE = /[0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?/;
// Legacy arxiv id: subject-class[.subcat]/YYMMNNN(vN)?  e.g. cs.LG/0412020
const LEGACY_ARXIV_RE = /[a-z\-]+(?:\.[A-Z]{2})?\/[0-9]{7}(?:v[0-9]+)?/;

const ARXIV_ID_SRC = `(?:${MODERN_ARXIV_RE.source}|${LEGACY_ARXIV_RE.source})`;
const DOI_BODY_SRC = `10\\.[0-9]{4,9}/[^\\s<>"'\`)\\]]+`;

interface PatternDef {
  /**
   * Source regex matching the FULL span we want to replace. Must use
   * exactly one capture group: the bare identifier.
   */
  source: string;
  scheme: PaperRefScheme;
}

const PATTERNS: PatternDef[] = [
  // arxiv URLs — full URL is the span, capture the id (optionally trim .pdf later).
  { scheme: "arxiv", source: `https?:\\/\\/arxiv\\.org\\/(?:abs|pdf)\\/(${ARXIV_ID_SRC})(?:\\.pdf)?` },
  // doi URLs — full URL is the span, capture body.
  { scheme: "doi", source: `https?:\\/\\/(?:dx\\.)?doi\\.org\\/(${DOI_BODY_SRC})` },
  // arXiv: label form — match only `arXiv:ID` (the literal+id, NO leading char).
  { scheme: "arxiv", source: `arXiv:(${ARXIV_ID_SRC})` },
  // doi: label form — `doi:ID`.
  { scheme: "doi", source: `doi:(${DOI_BODY_SRC})` },
];

function buildRegex(p: PatternDef): RegExp {
  return new RegExp(p.source, "gi");
}

/** Strip trailing punctuation that's almost certainly not part of the id. */
function trimTrailing(s: string): string {
  return s.replace(/[).,;:\]}'"]+$/g, "");
}

/**
 * arXiv DOIs round-trip back to arXiv ids. Keeps the SPA's lookup
 * cache from splitting the same paper into two records.
 */
function canonicalize(
  scheme: PaperRefScheme,
  id: string,
): { scheme: PaperRefScheme; id: string } {
  if (scheme === "doi") {
    const m = /^10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)$/i.exec(id);
    if (m) return { scheme: "arxiv", id: m[1].toLowerCase() };
  }
  return { scheme, id };
}

interface RawMatch {
  scheme: PaperRefScheme;
  id: string;
  start: number;
  length: number;
  raw: string;
  priority: number; // higher wins on overlap
}

/**
 * Top-level: find paper references in `text` and return a sorted,
 * disjoint list ready to drive a render pass.
 */
export function detectPaperRefs(text: string): PaperRef[] {
  if (!text) return [];

  const raw: RawMatch[] = [];
  for (let i = 0; i < PATTERNS.length; i++) {
    const p = PATTERNS[i];
    const re = buildRegex(p);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const length = m[0].length;
      const captured = trimTrailing(m[1]);
      // If trimming chopped chars off, shrink the replaced span to match
      // so trailing `)` etc. stay in the surrounding markdown.
      const trimmedLength = length - (m[1].length - captured.length);
      // Priority — earlier pattern in PATTERNS wins on overlap. URLs are
      // first (most informative), then labels.
      raw.push({
        scheme: p.scheme,
        id: captured,
        start,
        length: trimmedLength,
        raw: text.slice(start, start + trimmedLength),
        priority: PATTERNS.length - i,
      });
    }
  }
  if (raw.length === 0) return [];

  // Sort by start ascending; on tie put HIGHER priority first.
  raw.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.priority - a.priority;
  });

  // Walk in order, accepting non-overlapping matches. When two overlap
  // we keep whichever started first; on tie the higher-priority one
  // (already first after sort).
  const accepted: RawMatch[] = [];
  let cursor = 0;
  for (const m of raw) {
    if (m.start < cursor) continue;
    accepted.push(m);
    cursor = m.start + m.length;
  }

  return accepted.map((m): PaperRef => {
    const can = canonicalize(m.scheme, m.id);
    return {
      scheme: can.scheme,
      id: can.id,
      start: m.start,
      length: m.length,
      raw: m.raw,
    };
  });
}
