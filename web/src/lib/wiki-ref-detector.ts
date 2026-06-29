/**
 * wiki-ref-detector — find mathran-flavoured inline references inside
 * a markdown source string.
 *
 * Recognised forms (all examples taken from real init-project output
 * in goldbach/twin-primes wikis):
 *
 *   [[slug]]                              → wikilink, target slug
 *   [[slug|Display label]]                → wikilink with custom label
 *   @paper-read:arxiv-2306.17769          → paper-read ref
 *   @paper-read:arxiv-2306.17769#mainResult-1  → with anchor
 *   @paper-read:doi-10.1090_jams_123      → DOI paper (slashes encoded as _)
 *   @ws:effort-id                         → workspace effort ref
 *   @ws:effort-id#section-anchor          → with anchor
 *
 * Returns a flat list of disjoint matches, sorted by `start` ascending.
 * Overlapping matches are collapsed to the outermost — currently none
 * of the schemes can legitimately overlap each other so we just do a
 * post-pass that drops anything covered by a previous match.
 *
 * NOTE: we do NOT detect the bare URL forms `[text](url)` because
 * marked already handles those natively.
 *
 * 2026-06-29.
 */

export type WikiRefKind = "wikilink" | "paper-read" | "ws";

export interface WikiRef {
  kind: WikiRefKind;
  /** The identifier — slug for wikilink, paperId for paper-read,
   *  effort-id for ws. */
  target: string;
  /** Optional display label (only meaningful for wikilink today). */
  label?: string;
  /** Optional anchor inside the target — `mainResult-1` etc. */
  anchor?: string;
  /** Absolute char offset into the input string. */
  start: number;
  /** Length of the matched substring. */
  length: number;
  /** Verbatim matched substring. */
  raw: string;
}

// `[[slug]]` or `[[slug|label]]`. slug is `[a-z0-9._-]+` to match the
// SAFE_SLUG_PATTERN allowed by the server (now including `_index`).
const WIKILINK_RE = /\[\[([a-z0-9_][a-z0-9._-]*)(\|([^\]]+))?\]\]/gi;

// `@paper-read:<paperId>(#anchor)?`
// paperId is `arxiv-NNNN.NNNNN(vN)?` or `doi-10.NNNN_xxx` (slashes → underscores).
// Trailing punctuation (.,;:!?) terminates the match so it doesn't get
// dragged into `paperId`.
const PAPER_READ_RE = /@paper-read:([a-z0-9_-][a-z0-9._-]*[a-z0-9_])(?:#([a-z0-9._-]+))?/gi;

// `@ws:<effort-id>(#anchor)?` — same trailing-punctuation discipline.
const WS_RE = /@ws:([a-z0-9_-][a-z0-9._-]*[a-z0-9_])(?:#([a-z0-9._-]+))?/gi;

export function detectWikiRefs(text: string): WikiRef[] {
  if (!text) return [];
  const refs: WikiRef[] = [];

  let m: RegExpExecArray | null;

  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    refs.push({
      kind: "wikilink",
      target: m[1],
      label: m[3] || undefined,
      start: m.index,
      length: m[0].length,
      raw: m[0],
    });
  }

  PAPER_READ_RE.lastIndex = 0;
  while ((m = PAPER_READ_RE.exec(text)) !== null) {
    refs.push({
      kind: "paper-read",
      target: m[1],
      anchor: m[2] || undefined,
      start: m.index,
      length: m[0].length,
      raw: m[0],
    });
  }

  WS_RE.lastIndex = 0;
  while ((m = WS_RE.exec(text)) !== null) {
    refs.push({
      kind: "ws",
      target: m[1],
      anchor: m[2] || undefined,
      start: m.index,
      length: m[0].length,
      raw: m[0],
    });
  }

  // Sort by start offset. Drop any ref whose range overlaps a
  // previously-accepted earlier-starting ref.
  refs.sort((a, b) => a.start - b.start);
  const out: WikiRef[] = [];
  let lastEnd = -1;
  for (const r of refs) {
    if (r.start < lastEnd) continue; // overlap — skip
    out.push(r);
    lastEnd = r.start + r.length;
  }
  return out;
}
