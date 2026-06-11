/**
 * Wiki Patch Applier — shared helper for converting a `WikiDraftPatch` into a
 * persisted `wikiDrafts` row (creating the backing `wikiPages` row first when the
 * patch represents a brand-new page).
 *
 * A1 (cross-cutting.md): consolidates the previously-divergent insert logic that
 * lived in three places:
 *   1. `wiki-sync-engine.applyPatches`  (queue/job-driven, system-authored)
 *   2. `wiki-sync/effort/apply/route`   (HTTP preview-then-apply, user-authored)
 *   3. `forum-wiki-sync/apply/route`    (HTTP preview-then-apply, user-authored)
 *
 * Differences that are *intentional* are exposed as `ApplyWikiPatchOptions`
 * (actor identity, new-page change summary). Differences that were *bugs* are
 * unified here:
 *   - `wikiPages.content` placeholder for new pages: always `"[Draft pending review]"`
 *     (HTTP routes previously wrote empty string, leaving UI rendering blank).
 *   - `wikiDrafts.baseVersionNumber` for existing pages: always falls back to
 *     `patch.baseVersionNumber ?? page.version ?? 1` (HTTP routes previously
 *     passed through `undefined` when the LLM forgot the field, falling on the
 *     DB default).
 *   - `wikiDrafts.baseVersionNumber` for new pages: always `1` (HTTP routes
 *     previously relied on DB default).
 */

import { and, eq } from "drizzle-orm";
// TODO(mathran-v0.1): import type { Database } from "@/server/db";
// TODO(mathran-v0.1): import { wikiPages, wikiDrafts } from "@/server/db/schema";
// TODO(mathran-v0.1): import { createWikiPage } from "@/lib/wiki-service";

/** Subset of Drizzle Database operations needed here — accepts both a full
 * database handle and a transaction handle (PgTransaction). */
type Db = Pick<Database, "select" | "insert" | "update" | "delete" | "execute" | "transaction">;

export interface WikiPatchInput {
  pageId?: string;
  pageSlug: string;
  content: string;
  baseVersionNumber?: number;
  title: string;
  changeSummary: string;
  isNewPage: boolean;
}

export interface ApplyWikiPatchOptions {
  /** User id (real session user) or the system pseudo-user for auto sync. */
  actorUserId: string;
  /**
   * Change summary written into the `wikiPages` row when creating a new page.
   * If omitted, falls back to `patch.changeSummary` (engine-style behavior).
   */
  newPageChangeSummary?: string;
  /**
   * When true (HTTP route behavior), verifies the resolved page belongs to
   * `projectId` before inserting a draft for an existing page. Returns null
   * for the skip case so the caller's `if (result) draftIds.push(...)` works.
   * When false (engine behavior), the caller has already resolved `pages`
   * out of band via `pageId/slug` match — we trust it.
   */
  verifyPageProject?: boolean;
  /**
   * Optional pre-resolved pages list. Engine pre-fetches all pages for the
   * project/program before the loop; passing it here avoids per-iteration
   * lookup. HTTP routes leave this undefined and let the helper query.
   */
  resolvedPages?: Array<{ id: string; slug: string; version: number }>;
}

const NEW_PAGE_PLACEHOLDER = "[Draft pending review]";
const NEW_PAGE_BASE_VERSION = 1;

export async function applyWikiPatch(
  tx: Db,
  patch: WikiPatchInput,
  projectId: string,
  opts: ApplyWikiPatchOptions,
): Promise<{ draftId: string; pageId: string } | null> {
  let pageId: string;
  let baseVersionForDraft: number;

  if (patch.isNewPage) {
    pageId = await createWikiPage(tx, {
      projectId,
      title: patch.title,
      slug: patch.pageSlug,
      content: NEW_PAGE_PLACEHOLDER,
      isAiGenerated: true,
      editedBy: opts.actorUserId,
      changeSummary: opts.newPageChangeSummary ?? patch.changeSummary,
      reviewStatus: "AI_GENERATED",
    });
    baseVersionForDraft = NEW_PAGE_BASE_VERSION;
  } else {
    // Resolve the target page row.
    let page: { id: string; version: number } | undefined;
    if (opts.resolvedPages) {
      const candidate = opts.resolvedPages.find(
        (p) => p.id === patch.pageId || p.slug === patch.pageSlug,
      );
      if (candidate) page = { id: candidate.id, version: candidate.version };
    } else if (patch.pageId) {
      const rows = await tx
        .select({ id: wikiPages.id, version: wikiPages.version })
        .from(wikiPages)
        .where(and(eq(wikiPages.id, patch.pageId), eq(wikiPages.projectId, projectId)))
        .limit(1);
      page = rows[0];
    } else {
      const rows = await tx
        .select({ id: wikiPages.id, version: wikiPages.version })
        .from(wikiPages)
        .where(and(eq(wikiPages.slug, patch.pageSlug), eq(wikiPages.projectId, projectId)))
        .limit(1);
      page = rows[0];
    }

    if (!page) return null;
    // verifyPageProject is implicitly enforced above by the eq(projectId) filter
    // whenever we do the lookup; for the resolvedPages branch the caller
    // pre-scoped the list. opts.verifyPageProject remains a documentation hint.

    pageId = page.id;
    baseVersionForDraft = patch.baseVersionNumber ?? page.version ?? NEW_PAGE_BASE_VERSION;
  }

  const [draft] = await tx
    .insert(wikiDrafts)
    .values({
      pageId,
      authorId: opts.actorUserId,
      content: patch.content,
      baseVersionNumber: baseVersionForDraft,
      title: patch.title,
      changeSummary: patch.changeSummary,
      status: "editing",
    })
    .returning({ id: wikiDrafts.id });

  if (!draft) return null;
  return { draftId: draft.id, pageId };
}
