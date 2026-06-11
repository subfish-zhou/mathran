// MathRef resolver — server-side, imports db.
import { eq, and, desc } from "drizzle-orm";
import type { Database } from "@/server/db";
import {
  projects,
  workspaceEfforts,
  wikiPages,
  posts,
  threads,
} from "@/server/db/schema";
import { slugify } from "@/lib/utils";
import type { ParsedMathRef, MathRefModule } from "./parse";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefStatus =
  | "ok"
  | "deleted"
  | "not_found"
  | "dead_end"
  | "superseded"
  | "anchor_missing";

export interface ResolvedRef {
  module: MathRefModule | "thread";
  identifier: string;
  entityType: "effort" | "wiki" | "post" | "thread" | "project" | null;
  entityId: string | null;
  title: string | null;
  status: RefStatus;
  effortStatus?: string | null;
  supersededBy?: string | null;
  author?: { name: string } | null;
  excerpt?: string | null;
  href?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
void UUID_RE;

function buildHref(
  section: string,
  id: string,
  projectSlug: string,
  anchor?: string,
): string {
  const base = `/project/${projectSlug}/${section}/${id}`;
  return anchor ? `${base}#${anchor}` : base;
}

async function resolveProjectId(
  db: Database,
  slug: string,
): Promise<string | null> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1)
    .then((r) => r[0]);
  return row?.id ?? null;
}

async function getProjectSlug(
  db: Database,
  projectId: string,
): Promise<string> {
  const row = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);
  return row?.slug ?? "";
}

// ---------------------------------------------------------------------------
// Per-module resolution
// ---------------------------------------------------------------------------

async function resolveWorkspace(
  db: Database,
  ref: ParsedMathRef,
  projectId: string,
  projectSlug: string,
): Promise<ResolvedRef> {
  const base: ResolvedRef = {
    module: "workspace",
    identifier: ref.identifier,
    entityType: "effort",
    entityId: null,
    title: null,
    status: "not_found",
  };

  let effort: typeof workspaceEfforts.$inferSelect | undefined;

  // Try exact id match first (effort ids may be short human ids like "r13", UUIDs, or 60-char ids)
  effort = await db
    .select()
    .from(workspaceEfforts)
    .where(
      and(
        eq(workspaceEfforts.id, ref.identifier),
        eq(workspaceEfforts.projectId, projectId),
      ),
    )
    .limit(1)
    .then((r) => r[0]);

  if (!effort) {
    // Try real persisted slug column match (project-scoped, exclude soft-deleted)
    effort = await db
      .select()
      .from(workspaceEfforts)
      .where(
        and(
          eq(workspaceEfforts.slug, ref.identifier),
          eq(workspaceEfforts.projectId, projectId),
          eq(workspaceEfforts.isDeleted, false),
        ),
      )
      .limit(1)
      .then((r) => r[0]);
  }

  if (!effort) {
    // Try slug match (slugify title) — fallback for efforts created before the
    // slug column existed or whose slug was never backfilled.
    const allEfforts = await db
      .select()
      .from(workspaceEfforts)
      .where(
        and(
          eq(workspaceEfforts.projectId, projectId),
          eq(workspaceEfforts.isDeleted, false),
        ),
      );

    effort = allEfforts.find(
      (e) => slugify(e.title) === ref.identifier,
    );
  }

  if (!effort) return base;

  base.entityId = effort.id;
  base.title = effort.title;
  base.excerpt = (effort.document ?? effort.description ?? "").slice(0, 200);
  base.href = buildHref("workspace", effort.id, projectSlug, ref.anchor);

  if (effort.isDeleted) {
    base.status = "deleted";
    return base;
  }

  if (effort.status === "DEAD_END") {
    base.status = "dead_end";
    base.effortStatus = effort.status;
    return base;
  }

  if (effort.status === "SUPERSEDED") {
    base.status = "superseded";
    base.effortStatus = effort.status;
    base.supersededBy = effort.supersededBy;
    return base;
  }

  base.status = "ok";
  base.effortStatus = effort.status;
  return base;
}

async function resolveWiki(
  db: Database,
  ref: ParsedMathRef,
  projectId: string,
  projectSlug: string,
): Promise<ResolvedRef> {
  const base: ResolvedRef = {
    module: "wiki",
    identifier: ref.identifier,
    entityType: "wiki",
    entityId: null,
    title: null,
    status: "not_found",
  };

  const page = await db
    .select()
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.projectId, projectId),
        eq(wikiPages.slug, ref.identifier),
        eq(wikiPages.isDeleted, false),
      ),
    )
    .limit(1)
    .then((r) => r[0]);

  if (!page) return base;

  base.entityId = page.id;
  base.title = page.title;
  base.excerpt = (page.content ?? "").slice(0, 200);
  base.href = buildHref("wiki", page.slug, projectSlug, ref.anchor);
  base.status = "ok";
  return base;
}

async function resolveForumPost(
  db: Database,
  ref: ParsedMathRef,
  projectId: string,
  projectSlug: string,
): Promise<ResolvedRef> {
  const base: ResolvedRef = {
    module: "forum",
    identifier: ref.identifier,
    entityType: "post",
    entityId: null,
    title: null,
    status: "not_found",
  };

  let post: typeof posts.$inferSelect | undefined;

  // Try exact post id match first (covers UUID and short human ids)
  post = await db
    .select()
    .from(posts)
    .innerJoin(threads, eq(posts.threadId, threads.id))
    .where(
      and(eq(posts.id, ref.identifier), eq(threads.projectId, projectId)),
    )
    .limit(1)
    .then((r) => r[0]?.posts);

  if (!post) {
    // Fall back to seq (integer) match
    const seq = Number(ref.identifier);
    if (!isNaN(seq) && Number.isInteger(seq)) {
      post = await db
        .select()
        .from(posts)
        .innerJoin(threads, eq(posts.threadId, threads.id))
        .where(
          and(eq(posts.seq, seq), eq(threads.projectId, projectId)),
        )
        .orderBy(desc(posts.createdAt))
        .limit(1)
        .then((r) => r[0]?.posts);
    }
  }

  if (!post) return base;

  base.entityId = post.id;
  base.excerpt = (post.body ?? "").slice(0, 200);
  base.href = buildHref(
    "forum/post",
    /^\d+$/.test(ref.identifier) ? ref.identifier : post.id,
    projectSlug,
    ref.anchor,
  );

  if (post.isDeleted) {
    base.status = "deleted";
    return base;
  }

  base.status = "ok";
  return base;
}

async function resolveThread(
  db: Database,
  ref: ParsedMathRef,
  projectId: string,
  projectSlug: string,
): Promise<ResolvedRef> {
  const base: ResolvedRef = {
    module: "thread",
    identifier: ref.identifier,
    entityType: "thread",
    entityId: null,
    title: null,
    status: "not_found",
  };

  const thread = await db
    .select()
    .from(threads)
    .where(
      and(eq(threads.id, ref.identifier), eq(threads.projectId, projectId)),
    )
    .limit(1)
    .then((r) => r[0]);

  if (!thread) return base;

  base.entityId = thread.id;
  base.title = thread.title;
  base.excerpt = (thread.body ?? "").slice(0, 200);
  base.href = buildHref("forum", thread.id, projectSlug, ref.anchor);

  if (thread.isDeleted) {
    base.status = "deleted";
    return base;
  }

  base.status = "ok";
  return base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function resolveMathRef(
  db: Database,
  ref: ParsedMathRef,
  currentProjectId: string,
): Promise<ResolvedRef> {
  // Determine effective project
  let projectId = currentProjectId;
  let projectSlug: string;

  if (ref.projectSlug) {
    const resolvedId = await resolveProjectId(db, ref.projectSlug);
    if (!resolvedId) {
      return {
        module: ref.isThread ? "thread" : ref.module,
        identifier: ref.identifier,
        entityType: null,
        entityId: null,
        title: null,
        status: "not_found",
      };
    }
    projectId = resolvedId;
    projectSlug = ref.projectSlug;
  } else {
    projectSlug = await getProjectSlug(db, currentProjectId);
  }

  // Route by module
  if (ref.isThread || ref.shortModule === "t") {
    return resolveThread(db, ref, projectId, projectSlug);
  }

  switch (ref.module) {
    case "workspace":
      return resolveWorkspace(db, ref, projectId, projectSlug);
    case "wiki":
      return resolveWiki(db, ref, projectId, projectSlug);
    case "forum":
      return resolveForumPost(db, ref, projectId, projectSlug);
    case "bib":
    case "user":
      return {
        module: ref.module,
        identifier: ref.identifier,
        entityType: null,
        entityId: null,
        title: null,
        status: "ok",
      };
    default:
      return {
        module: ref.module,
        identifier: ref.identifier,
        entityType: null,
        entityId: null,
        title: null,
        status: "not_found",
      };
  }
}

export async function resolveMathRefs(
  db: Database,
  refs: ParsedMathRef[],
  currentProjectId: string,
): Promise<ResolvedRef[]> {
  return Promise.all(refs.map((ref) => resolveMathRef(db, ref, currentProjectId)));
}

export interface PeekedRef extends ResolvedRef {
  body: string | null;
  version?: number | null;
  threadTitle?: string | null;
}

/**
 * Resolve a ref AND fetch the full target body for the Peek panel.
 * (resolveMathRef only returns a 200-char excerpt.)
 */
export async function peekMathRef(
  db: Database,
  ref: ParsedMathRef,
  currentProjectId: string,
): Promise<PeekedRef> {
  const resolved = await resolveMathRef(db, ref, currentProjectId);
  const out: PeekedRef = { ...resolved, body: resolved.excerpt ?? null };

  if (!resolved.entityId || !resolved.entityType) return out;

  if (resolved.entityType === "effort") {
    const e = await db
      .select()
      .from(workspaceEfforts)
      .where(eq(workspaceEfforts.id, resolved.entityId))
      .limit(1)
      .then((r) => r[0]);
    if (e) out.body = e.document ?? e.description ?? null;
  } else if (resolved.entityType === "wiki") {
    const p = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.id, resolved.entityId))
      .limit(1)
      .then((r) => r[0]);
    if (p) {
      out.body = p.content ?? null;
      out.version = p.version;
    }
  } else if (resolved.entityType === "post") {
    const row = await db
      .select()
      .from(posts)
      .innerJoin(threads, eq(posts.threadId, threads.id))
      .where(eq(posts.id, resolved.entityId))
      .limit(1)
      .then((r) => r[0]);
    if (row) {
      out.body = row.posts.body ?? null;
      out.threadTitle = row.threads.title;
    }
  } else if (resolved.entityType === "thread") {
    const t = await db
      .select()
      .from(threads)
      .where(eq(threads.id, resolved.entityId))
      .limit(1)
      .then((r) => r[0]);
    if (t) out.body = t.body ?? null;
  }

  return out;
}
