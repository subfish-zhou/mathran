// TODO(mathran-v0.1): import { escapeLike } from "@/server/api/helpers/escape-like";

/** Max search query length (W2 contract). */
export const SEARCH_QUERY_MAX = 200;

/**
 * Build a SQL LIKE/ILIKE pattern from a free-text query.
 *
 * - Trims input.
 * - Throws if empty after trim.
 * - Throws if length > {@link SEARCH_QUERY_MAX}.
 * - Wildcard-escapes (% _ \) so user input cannot inject patterns.
 *
 * Returns the pattern (wrapped with `%` on both sides) ready for `ilike`.
 */
export function buildSearchPattern(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new SearchQueryError("search query is required");
  }
  if (trimmed.length > SEARCH_QUERY_MAX) {
    throw new SearchQueryError(`search query too long (max ${SEARCH_QUERY_MAX})`);
  }
  return `%${escapeLike(trimmed)}%`;
}

export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

/** Clamp a list `limit` query arg between 1 and `max` (default 100). */
export function clampLimit(limit: number | undefined, max = 100): number {
  if (limit == null || !Number.isFinite(limit)) return Math.min(20, max);
  const n = Math.max(1, Math.min(Math.floor(limit), max));
  return n;
}

export function clampOffset(offset: number | undefined): number {
  if (offset == null || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}
