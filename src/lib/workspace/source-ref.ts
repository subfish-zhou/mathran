/**
 * Effort source ref helpers.
 *
 * [spec/01 decoupling] workspace_efforts used to carry source_thread_id and
 * source_post_id columns with FK references to the forum schema. Migration
 * 0069 collapsed them into a polymorphic (source_kind, source_id) pair so
 * workspace stops depending on forum at the schema layer.
 *
 * These helpers:
 *   1) Spell the canonical EffortSourceKind union (so adding "wiki_page"
 *      later is one line, not a TS-wide hunt for `if (kind === "...")`).
 *   2) Build the {sourceKind, sourceId} object shape that insert/update
 *      sites need (constructor-style, no stringly-typed kind anywhere).
 *   3) Provide read-side accessors that preserve the old field names
 *      (sourceThreadId / sourcePostId) for the router→frontend boundary,
 *      avoiding a parallel frontend migration.
 */

export const EFFORT_SOURCE_KINDS = [
  "forum_thread",
  "forum_post",
  "wiki_page",
  "external",
] as const;
export type EffortSourceKind = (typeof EFFORT_SOURCE_KINDS)[number];

/** Row shape after select (only the two source columns). */
export interface EffortSourceRow {
  sourceKind: string | null;
  sourceId: string | null;
}

/** Insert/update shape (matches workspace_efforts column names). */
export type EffortSourcePatch =
  | { sourceKind: EffortSourceKind; sourceId: string }
  | { sourceKind: null; sourceId: null };

// ─── Builders ─────────────────────────────────────────────────────────────

export function makeForumThreadSource(threadId: string): EffortSourcePatch {
  return { sourceKind: "forum_thread", sourceId: threadId };
}

export function makeForumPostSource(postId: string): EffortSourcePatch {
  return { sourceKind: "forum_post", sourceId: postId };
}

export function makeWikiPageSource(pageId: string): EffortSourcePatch {
  return { sourceKind: "wiki_page", sourceId: pageId };
}

export function makeExternalSource(url: string): EffortSourcePatch {
  return { sourceKind: "external", sourceId: url };
}

export function clearSource(): EffortSourcePatch {
  return { sourceKind: null, sourceId: null };
}

// ─── Read-side accessors (legacy field names) ────────────────────────────
//
// Keep router responses backward compatible: the frontend still reads
// `sourceThreadId` / `sourcePostId`. These accessors derive them from the
// new polymorphic columns. Frontend can migrate to `sourceKind`/`sourceId`
// in a separate sweep.

export function legacyThreadId(row: EffortSourceRow): string | null {
  return row.sourceKind === "forum_thread" ? row.sourceId : null;
}

export function legacyPostId(row: EffortSourceRow): string | null {
  return row.sourceKind === "forum_post" ? row.sourceId : null;
}

/** Spread into router output: `{ ...effort, ...withLegacySourceFields(effort) }`. */
export function withLegacySourceFields(row: EffortSourceRow): {
  sourceThreadId: string | null;
  sourcePostId: string | null;
} {
  return {
    sourceThreadId: legacyThreadId(row),
    sourcePostId: legacyPostId(row),
  };
}

/** Resolve legacy thread/post fields from a partial input to the new shape.
 *  Used at insert/update boundaries that still accept the old field names
 *  (API surfaces we don't want to break in the same PR). */
export function patchFromLegacyFields(input: {
  sourceThreadId?: string | null;
  sourcePostId?: string | null;
}): EffortSourcePatch | undefined {
  if (input.sourceThreadId) return makeForumThreadSource(input.sourceThreadId);
  if (input.sourcePostId) return makeForumPostSource(input.sourcePostId);
  if (input.sourceThreadId === null || input.sourcePostId === null) {
    return clearSource();
  }
  return undefined;
}
