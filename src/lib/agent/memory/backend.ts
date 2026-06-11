/**
 * Memories backend — DB-backed CRUD for the codex-parity memory tools.
 *
 * Wraps user_memories (+ embeddings) into the API surface the model-facing
 * tools (memory_add / list / read / search) need. All operations are
 * user-scoped: a userId must be passed in, and the backend never returns a
 * row that belongs to another user.
 *
 * Design notes:
 *   - addMemoryNote always writes kind='note' so we can distinguish from
 *     background-extracted rows. Slug is auto-generated if the caller
 *     does not pass one.
 *   - searchMemories is a hybrid: try pgvector cosine first when an
 *     embedding can be computed; fall back to ILIKE substring on the
 *     trigram-indexed content column. Every search hit bumps mention_count.
 *   - listMemories supports cursor pagination via (createdAt, id) tuple.
 *   - Result shapes are small + JSON-safe so the tool layer can return
 *     them directly to the model.
 *
 * Ported: 2026-06-10 (commit 07a/sprint-2 of mathub-ai-codex-upgrade).
 */

import { and, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { userMemories, embeddings } from "@/server/db/schema";
// TODO(mathran-v0.1): import { generateEmbedding } from "@/lib/embedding";

export type MemoryKind = "note" | "auto" | "summary";

export type MemoryCategory =
  | "preference"
  | "expertise"
  | "project_context"
  | "research_interest";

export interface MemoryRow {
  id: string;
  userId: string;
  category: string;
  kind: string;
  slug: string | null;
  content: string;
  mentionCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  sourceConversationId: string | null;
}

export interface AddMemoryOpts {
  userId: string;
  content: string;
  category?: MemoryCategory | string;
  slug?: string;
  sourceConversationId?: string | null;
}

export interface ListMemoryOpts {
  userId: string;
  category?: string;
  kind?: MemoryKind;
  /** Cursor in ISO timestamp + id format: "<isoTs>|<id>". */
  cursor?: string;
  /** Default 50, hard cap 200. */
  maxResults?: number;
}

export interface SearchMemoryOpts {
  userId: string;
  query: string;
  category?: string;
  /** Default 20, hard cap 100. */
  maxResults?: number;
  /**
   * When true, skip the pgvector pass (useful for tests / when embeddings
   * are not configured). Defaults to false.
   */
  ilikeOnly?: boolean;
}

export interface SearchHit {
  row: MemoryRow;
  /** Cosine similarity in [0,1] when vector match; null when ILIKE-only. */
  score: number | null;
  /** Up to 240 chars of context around the first match. */
  snippet: string;
}

const DEFAULT_LIST_MAX = 50;
const HARD_LIST_MAX = 200;
const DEFAULT_SEARCH_MAX = 20;
const HARD_SEARCH_MAX = 100;
const ADD_MAX_CONTENT_LEN = 5000;
const VALID_KINDS = new Set<MemoryKind>(["note", "auto", "summary"]);

function clamp(n: number | undefined, def: number, max: number): number {
  if (!n || !Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function makeAutoSlug(content: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tail = slugify(content.slice(0, 60)) || "note";
  return `${ts}-${tail}`.slice(0, 80);
}

function rowToMemoryRow(r: typeof userMemories.$inferSelect): MemoryRow {
  return {
    id: r.id,
    userId: r.userId,
    category: r.category,
    kind: r.kind,
    slug: r.slug ?? null,
    content: r.content,
    mentionCount: r.mentionCount ?? 0,
    lastUsedAt: r.lastUsedAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt ?? null,
    sourceConversationId: r.sourceConversationId ?? null,
  };
}

function snippet(content: string, query: string): string {
  const lc = content.toLowerCase();
  const idx = lc.indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, 240);
  const start = Math.max(0, idx - 80);
  const end = Math.min(content.length, idx + query.length + 160);
  const ellipsis = (start > 0 ? "…" : "") + (end < content.length ? "…" : "");
  return ellipsis ? content.slice(start, end) + ellipsis : content.slice(start, end);
}

/**
 * Add an explicit memory note. Always sets kind='note'. Returns the new row.
 * Throws when content is empty or too long; the tool layer surfaces it.
 */
export async function addMemoryNote(opts: AddMemoryOpts): Promise<MemoryRow> {
  const trimmed = opts.content.trim();
  if (!trimmed) throw new Error("memory content is empty");
  if (trimmed.length > ADD_MAX_CONTENT_LEN) {
    throw new Error(
      `memory content too long (${trimmed.length} > ${ADD_MAX_CONTENT_LEN} chars)`,
    );
  }
  const db = getDb();
  const slug = (opts.slug && opts.slug.trim()) || makeAutoSlug(trimmed);
  const category = opts.category ?? "preference";
  const [row] = await db
    .insert(userMemories)
    .values({
      userId: opts.userId,
      category,
      kind: "note",
      slug,
      content: trimmed,
      sourceConversationId: opts.sourceConversationId ?? null,
    })
    .returning();
  // Best-effort embedding so memory_search vector path can find it. Failure
  // is non-fatal: ILIKE fallback still works.
  try {
    const vec = await generateEmbedding(trimmed);
    if (Array.isArray(vec) && vec.length === 1536) {
      await db.insert(embeddings).values({
        contentType: "user_memory",
        contentId: row!.id,
        embedding: vec,
        chunkText: trimmed.slice(0, 500),
      });
    }
  } catch (err) {
    console.warn("[memory-backend] embedding generation failed (non-fatal):", err);
  }
  return rowToMemoryRow(row!);
}

/**
 * List memories, paginated. Always user-scoped + non-expired.
 */
export async function listMemories(opts: ListMemoryOpts): Promise<{
  items: MemoryRow[];
  nextCursor: string | null;
}> {
  const db = getDb();
  const max = clamp(opts.maxResults, DEFAULT_LIST_MAX, HARD_LIST_MAX);
  const conditions = [eq(userMemories.userId, opts.userId)];
  if (opts.category) conditions.push(eq(userMemories.category, opts.category));
  if (opts.kind && VALID_KINDS.has(opts.kind)) {
    conditions.push(eq(userMemories.kind, opts.kind));
  }
  // Filter out expired.
  conditions.push(
    or(
      sql`${userMemories.expiresAt} IS NULL`,
      sql`${userMemories.expiresAt} > NOW()`,
    )!,
  );
  // Cursor: createdAt|id ascending boundary (we sort desc, so cursor
  // means "rows strictly older than this").
  if (opts.cursor) {
    const [ts, id] = opts.cursor.split("|");
    if (ts && id) {
      const cutoff = new Date(ts);
      if (!isNaN(cutoff.getTime())) {
        conditions.push(
          or(
            lt(userMemories.createdAt, cutoff),
            and(
              eq(userMemories.createdAt, cutoff),
              lt(userMemories.id, id),
            )!,
          )!,
        );
      }
    }
  }
  const rows = await db
    .select()
    .from(userMemories)
    .where(and(...conditions))
    .orderBy(desc(userMemories.createdAt), desc(userMemories.id))
    .limit(max + 1);
  const hasMore = rows.length > max;
  const items = rows.slice(0, max).map(rowToMemoryRow);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? `${last.createdAt.toISOString()}|${last.id}`
      : null;
  return { items, nextCursor };
}

/**
 * Single-row fetch by id, user-scoped. Returns null when not found.
 */
export async function readMemory(opts: {
  userId: string;
  id: string;
}): Promise<MemoryRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.id, opts.id), eq(userMemories.userId, opts.userId)))
    .limit(1);
  return row ? rowToMemoryRow(row) : null;
}

/**
 * Hybrid search: pgvector cosine first, ILIKE substring fallback. Every
 * returned hit bumps mention_count + last_used_at so the hot ranking warms
 * with use.
 */
export async function searchMemories(opts: SearchMemoryOpts): Promise<{
  hits: SearchHit[];
  via: "vector" | "ilike" | "mixed";
}> {
  const db = getDb();
  const q = opts.query.trim();
  if (!q) return { hits: [], via: "ilike" };
  const max = clamp(opts.maxResults, DEFAULT_SEARCH_MAX, HARD_SEARCH_MAX);

  const baseConditions = [
    eq(userMemories.userId, opts.userId),
    or(
      sql`${userMemories.expiresAt} IS NULL`,
      sql`${userMemories.expiresAt} > NOW()`,
    )!,
  ];
  if (opts.category) baseConditions.push(eq(userMemories.category, opts.category));

  const vectorIds = new Set<string>();
  const scoreById = new Map<string, number>();

  if (!opts.ilikeOnly) {
    try {
      const vec = await generateEmbedding(q);
      if (Array.isArray(vec) && vec.length === 1536) {
        // Pull the user's memory ids first, then constrain the embedding
        // join to that set. Avoids a cross-user vector scan.
        const userMemIds = await db
          .select({ id: userMemories.id })
          .from(userMemories)
          .where(and(...baseConditions));
        if (userMemIds.length > 0) {
          const ids = userMemIds.map((r) => r.id);
          // Use cosine distance (1 - similarity); lower is better.
          const vectorRows = await db
            .select({
              contentId: embeddings.contentId,
              dist: sql<number>`${embeddings.embedding} <=> ${vec}::vector`,
            })
            .from(embeddings)
            .where(
              and(
                eq(embeddings.contentType, "user_memory"),
                inArray(embeddings.contentId, ids),
              ),
            )
            .orderBy(sql`${embeddings.embedding} <=> ${vec}::vector`)
            .limit(max);
          for (const r of vectorRows) {
            vectorIds.add(r.contentId);
            // cosine similarity = 1 - distance.
            const sim = Math.max(0, Math.min(1, 1 - Number(r.dist)));
            scoreById.set(r.contentId, sim);
          }
        }
      }
    } catch (err) {
      console.warn("[memory-backend] vector search failed, falling back to ILIKE:", err);
    }
  }

  // ILIKE pass: fill remaining slots with substring matches the vector
  // pass missed (or skipped).
  const remaining = max - vectorIds.size;
  let ilikeRows: (typeof userMemories.$inferSelect)[] = [];
  if (remaining > 0) {
    const ilikeConditions = [...baseConditions, ilike(userMemories.content, `%${q}%`)];
    if (vectorIds.size > 0) {
      ilikeConditions.push(sql`${userMemories.id} NOT IN (${sql.join([...vectorIds].map((id) => sql`${id}`), sql.raw(", "))})`);
    }
    ilikeRows = await db
      .select()
      .from(userMemories)
      .where(and(...ilikeConditions))
      .orderBy(desc(userMemories.mentionCount), desc(userMemories.createdAt))
      .limit(remaining);
  }

  // Merge: vector rows first (higher confidence), then ILIKE rows.
  const allIds = [...vectorIds, ...ilikeRows.map((r) => r.id)];
  if (allIds.length === 0) return { hits: [], via: "ilike" };
  const fullRows = await db
    .select()
    .from(userMemories)
    .where(inArray(userMemories.id, allIds));
  const byId = new Map(fullRows.map((r) => [r.id, r]));

  const hits: SearchHit[] = allIds
    .map((id) => byId.get(id))
    .filter((r): r is typeof userMemories.$inferSelect => !!r)
    .map((r) => ({
      row: rowToMemoryRow(r),
      score: scoreById.get(r.id) ?? null,
      snippet: snippet(r.content, q),
    }));

  // Best-effort bump: mention_count++ for every hit, last_used_at=now.
  if (hits.length > 0) {
    try {
      await db
        .update(userMemories)
        .set({
          mentionCount: sql`${userMemories.mentionCount} + 1`,
          lastUsedAt: new Date(),
        })
        .where(inArray(userMemories.id, hits.map((h) => h.row.id)));
    } catch (err) {
      console.warn("[memory-backend] mention bump failed (non-fatal):", err);
    }
  }

  const via: "vector" | "ilike" | "mixed" =
    vectorIds.size > 0 && ilikeRows.length > 0
      ? "mixed"
      : vectorIds.size > 0
        ? "vector"
        : "ilike";
  return { hits, via };
}
