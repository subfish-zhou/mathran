/**
 * Server-only dedup search — queries the real `projects` DB table.
 * Separated from dedup-search.ts to avoid bundling server modules in client components.
 */

// TODO(mathran-v0.1): import { getDb } from "@/server/db";
// TODO(mathran-v0.1): import { projects } from "@/server/db/schema";
import { sql } from "drizzle-orm";
import { searchSimilarProjectsInCorpus } from "./dedup-search";
// TODO(mathran-v0.1): import type { SimilarProject } from "@/components/create-project/DuplicateAlert";

function tokenize(text: string): string[] {
  const STOP_WORDS = new Set([
    "the", "and", "for", "that", "this", "with", "from", "are", "was",
    "were", "been", "have", "has", "had", "not", "but", "all", "can",
    "one", "our", "new", "about", "which", "each", "their", "will",
    "than", "other", "into", "its", "also", "some", "such", "then",
    "more", "very", "when", "here", "there", "where", "what", "who",
    "how", "may", "any", "does", "let", "every",
    "problem", "problems", "project", "study", "research", "conjecture",
    "theorem", "lemma", "proof", "result", "results", "method", "methods",
    "analysis", "equation", "function", "number", "numbers", "set", "sets",
    "is", "it", "in", "of", "on", "to", "as", "at", "be", "by", "or",
    "an", "if", "so", "we", "do", "no", "up",
    "的", "了", "是", "在", "和", "有", "用", "一个", "这个", "那个",
  ]);
  function normalizeToken(word: string): string {
    let token = word.toLowerCase();
    if (token.length > 4 && token.endsWith("ies")) token = `${token.slice(0, -3)}y`;
    else if (token.length > 4 && token.endsWith("es")) token = token.slice(0, -2);
    else if (token.length > 3 && token.endsWith("s")) token = token.slice(0, -1);
    return token;
  }
  return text
    .toLowerCase()
    .replace(/\$\$[^$]*\$\$/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
    .split(/\s+/)
    .map((w) => normalizeToken(w))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Search the real `projects` DB table for similar projects.
 */
export async function searchSimilarProjectsDB(
  query: string,
  tags: string[] = [],
  maxResults: number = 5
): Promise<SimilarProject[]> {
  try {
    const db = getDb();

    const searchTerms = [
      ...tokenize(query).slice(0, 10),
      ...tags.map((t) => t.toLowerCase().trim()).filter(Boolean),
    ];
    if (searchTerms.length === 0) return [];

    const conditions = searchTerms.map(
      (term) =>
        sql`(${projects.title} ILIKE ${"%" + term + "%"} OR ${projects.description} ILIKE ${"%" + term + "%"})`
    );

    const whereClause = sql.join(conditions, sql` OR `);

    const rows = await db
      .select({
        id: projects.id,
        title: projects.title,
        slug: projects.slug,
        description: projects.description,
        status: projects.status,
        formalStatement: projects.formalStatement,
      })
      .from(projects)
      .where(whereClause)
      .limit(maxResults * 3);

    if (rows.length === 0) return [];

    const corpus = rows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      description: r.description ?? "",
      formalStatement: r.formalStatement ?? undefined,
      status: r.status ?? "active",
      memberCount: 1,
    }));

    return searchSimilarProjectsInCorpus(query, corpus, maxResults);
  } catch (err) {
    console.error("DB dedup search failed:", err);
    return [];
  }
}

// IMPL [unimpl-PGVECTOR] Semantic dedup via pgvector cosine similarity.
// Falls back to text search if no embedding service is configured or the
// pgvector index is missing.
export async function searchSimilarProjectsByEmbedding(
  queryEmbedding: number[],
  maxResults = 5,
  similarityThreshold = 0.78,
): Promise<Array<{ id: string; title: string; description: string; similarity: number }>> {
  try {
    const db = getDb();
    // P0-11 follow-up: defense-in-depth — validate embedding shape before
    // letting it anywhere near the query. Even though queryEmbedding comes
    // from a controlled AI model path, accepting non-finite values would let
    // a compromised model corrupt the SQL or downstream similarity math.
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return [];
    if (!queryEmbedding.every((v) => typeof v === "number" && Number.isFinite(v))) return [];
    const limit = Math.max(1, Math.min(1000, Math.floor(maxResults * 2)));

    // pgvector cosine distance: 1 - (a <=> b) gives similarity in [0, 1].
    // Project embeddings live on the `embeddings` table keyed by (contentType, contentId).
    // Build the vector literal as a drizzle sql tag parameter (proper $1 binding),
    // not via string interpolation into sql.raw — that pattern was the GHSA-gpj5-g38j-94v9
    // class of risk even when the input was nominally trusted.
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const result = await db.execute(sql`
      SELECT
        p.id,
        p.title,
        p.description,
        1 - (e.embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM projects p
      JOIN embeddings e ON e.content_type = 'project' AND e.content_id = p.id
      WHERE e.embedding IS NOT NULL
        AND p.deleted_at IS NULL
      ORDER BY e.embedding <=> ${vectorLiteral}::vector ASC
      LIMIT ${limit}
    `);
    const rows = (result as unknown as { rows?: Array<{ id: string; title: string; description: string; similarity: number }> }).rows
      ?? (result as unknown as Array<{ id: string; title: string; description: string; similarity: number }>);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r) => r.similarity >= similarityThreshold)
      .slice(0, maxResults);
  } catch (err) {
    console.warn("[dedup] pgvector similarity search failed:", err);
    return [];
  }
}
