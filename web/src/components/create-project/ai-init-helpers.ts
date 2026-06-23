/**
 * Pure (React-free) validation/parsing helpers for AiInitConfig. Kept in a
 * standalone module so they can be unit-tested under the root vitest config
 * without pulling in `react` (web/ has no @testing-library/react).
 */

export interface AiInitPayload {
  title: string;
  searchDepth: "quick" | "standard" | "deep";
  useSpine: boolean;
  enableWiki: boolean;
  seedReferences: string[];
  /** Absolute on-disk paths of uploaded seed files (from `POST /api/uploads`). */
  seedPdfs: string[];
}

/** Matches `1234.5678`, `arXiv:1234.5678`, optional version suffix `v2`. */
const ARXIV_RE = /^(?:arxiv:)?\d{4}\.\d{4,5}(?:v\d+)?$/i;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidSeed(line: string): boolean {
  return ARXIV_RE.test(line) || isHttpUrl(line);
}

/**
 * Split a textarea blob (one reference per line) into valid/invalid buckets.
 * Blank lines are ignored. A line is valid if it is an arXiv id or an http(s)
 * URL.
 */
export function parseSeedReferences(text: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (isValidSeed(line)) valid.push(line);
    else invalid.push(line);
  }
  return { valid, invalid };
}

/** Returns an error message if the title is empty/whitespace, else null. */
export function validateTitle(t: string): string | null {
  if (!t.trim()) return "Title is required";
  return null;
}

export interface BuildAiInitPayloadArgs {
  title: string;
  searchDepth: "quick" | "standard" | "deep";
  useSpine: boolean;
  enableWiki: boolean;
  seedReferences: string[];
  seedPdfs: string[];
}

/**
 * Assemble a normalized `AiInitPayload` from the form fields. Trims the title
 * and passes the (already-validated) reference/pdf lists through unchanged.
 */
export function buildAiInitPayload(args: BuildAiInitPayloadArgs): AiInitPayload {
  return {
    title: args.title.trim(),
    searchDepth: args.searchDepth,
    useSpine: args.useSpine,
    enableWiki: args.enableWiki,
    seedReferences: args.seedReferences,
    seedPdfs: args.seedPdfs,
  };
}
