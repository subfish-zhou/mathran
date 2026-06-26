/**
 * Built-in `user_profile_search` tool (user-distillation Phase 4).
 *
 * Lets the model ask "what does the user know / care about that's
 * relevant to <query>?" without dumping the full profile into
 * context. Uses BM25-style term overlap over the combined profile
 * (papers-own + papers-cited + projects + active inferred entries +
 * notes from reactions) and returns the top-K matches.
 *
 * Why BM25 instead of embeddings:
 *   - Zero new deps. Same TS toolchain.
 *   - Profile size is tiny (<200 entries typical) — exact term scoring
 *     is comparable in quality to embeddings for queries that share
 *     surface vocabulary with entries. For semantic queries that
 *     don't share vocabulary, the model can fall back to
 *     user_profile_read('all') and skim.
 *   - Embeddings would require a real index (faiss/sqlite-vec) and a
 *     re-embed-on-write loop. Not worth it for the v1 surface.
 *
 * 2026-06-26.
 */

import type { ToolSpec } from "../session.js";
import {
  readActiveInferred,
  readCitedPapers,
  readOwnPapers,
  readProjects,
  readReactions,
  type ReactionEntry,
} from "../../profile/index.js";

export interface UserProfileSearchToolOptions {
  /** Profile dir override (test seam). */
  profileDir?: string;
  /** Hard cap on returned JSON bytes (default 4 KiB). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024;
const DEFAULT_K = 5;

/** What the search index treats as one row. Each row carries a tag so the
 * model knows what kind of entry matched (`own-paper`, `project`, etc.). */
interface IndexRow {
  /** Display payload returned in tool output. */
  payload: Record<string, unknown>;
  /** The lowercased, whitespace-tokenised text we score against. */
  tokens: string[];
  /** Unique within the index — for tie-break stability. */
  id: string;
  /** Pretty type label shown in results. */
  kind:
    | "own-paper"
    | "cited-paper"
    | "project"
    | "inferred"
    | "reaction-note";
}

function tokenize(text: string): string[] {
  // Lowercase, split on non-word chars, drop short tokens.
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2);
}

/** Build the in-memory index from one read of all profile slices. */
async function buildIndex(profileDir: string | undefined): Promise<IndexRow[]> {
  const [own, cited, projects, inferred, reactions] = await Promise.all([
    readOwnPapers(profileDir),
    readCitedPapers(profileDir),
    readProjects(profileDir),
    readActiveInferred(profileDir),
    readReactions(profileDir),
  ]);
  const rows: IndexRow[] = [];
  for (const p of own) {
    rows.push({
      id: `own:${p.arxivId ?? p.doi ?? p.title}`,
      kind: "own-paper",
      payload: {
        kind: "own-paper",
        title: p.title,
        role: p.role,
        year: p.year,
        arxivId: p.arxivId,
        doi: p.doi,
        notes: p.notes,
      },
      tokens: tokenize(
        [p.title, p.notes ?? "", p.role, String(p.year ?? "")].join(" "),
      ),
    });
  }
  for (const c of cited) {
    rows.push({
      id: `cited:${c.paperId}`,
      kind: "cited-paper",
      payload: {
        kind: "cited-paper",
        paperId: c.paperId,
        contextHint: c.contextHint,
      },
      tokens: tokenize([c.paperId, c.contextHint ?? ""].join(" ")),
    });
  }
  for (const p of projects) {
    rows.push({
      id: `proj:${p.slug}`,
      kind: "project",
      payload: {
        kind: "project",
        slug: p.slug,
        title: p.title,
        status: p.status,
        methods: p.methods,
        description: p.description,
      },
      tokens: tokenize(
        [
          p.slug,
          p.title,
          p.status ?? "",
          (p.methods ?? []).join(" "),
          (p.collaborators ?? []).join(" "),
          p.description ?? "",
        ].join(" "),
      ),
    });
  }
  for (const i of inferred) {
    rows.push({
      id: `inf:${i.id}`,
      kind: "inferred",
      payload: {
        kind: "inferred",
        id: i.id,
        kindLabel: i.kind,
        content: i.content,
        confidence: i.confidence,
        evidenceCount: i.evidence.length,
      },
      tokens: tokenize([i.content, i.kind, i.userNote ?? ""].join(" ")),
    });
  }
  // Reaction NOTES are user-written natural language — searchable.
  // Quick likes/dislikes are too sparse to be useful here.
  for (const r of reactions) {
    if (r.reaction !== "note" || !r.body) continue;
    rows.push({
      id: `note:${r.paperId}:${r.timestamp}`,
      kind: "reaction-note",
      payload: {
        kind: "reaction-note",
        paperId: r.paperId,
        body: r.body,
        timestamp: r.timestamp,
      },
      tokens: tokenize([r.body, r.paperId].join(" ")),
    });
  }
  return rows;
}

interface IndexStats {
  /** Document frequency for each term. */
  df: Map<string, number>;
  /** Total docs. */
  N: number;
  /** Average doc length (in tokens). */
  avgDocLen: number;
}

function computeStats(rows: IndexRow[]): IndexStats {
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const row of rows) {
    totalLen += row.tokens.length;
    const seen = new Set<string>();
    for (const t of row.tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return {
    df,
    N: rows.length,
    avgDocLen: rows.length > 0 ? totalLen / rows.length : 0,
  };
}

/** Okapi BM25 scoring. k1=1.5, b=0.75 (standard params). */
function bm25Score(queryTokens: string[], row: IndexRow, stats: IndexStats): number {
  const k1 = 1.5;
  const b = 0.75;
  const tf = new Map<string, number>();
  for (const t of row.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const q of queryTokens) {
    const f = tf.get(q);
    if (!f) continue;
    const n = stats.df.get(q) ?? 0;
    if (n === 0) continue;
    // BM25 IDF: log((N - n + 0.5) / (n + 0.5) + 1) keeps positive.
    const idf = Math.log((stats.N - n + 0.5) / (n + 0.5) + 1);
    const norm =
      f * (k1 + 1) /
      (f + k1 * (1 - b + (b * row.tokens.length) / (stats.avgDocLen || 1)));
    score += idf * norm;
  }
  return score;
}

export function createUserProfileSearchTool(
  opts: UserProfileSearchToolOptions = {},
): ToolSpec {
  const profileDir = opts.profileDir;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return {
    name: "user_profile_search",
    riskClass: "read",
    readOnly: true,
    description:
      "Search the user's research profile (own papers / cited papers / " +
      "projects / inferred preferences / notes) for entries relevant to " +
      "your query. Use this when you want to know if the user has touched " +
      "a topic without dumping their entire profile into your context — " +
      "much more focused than user_profile_read('all'). Returns the top " +
      "matching entries scored by term overlap (BM25). Returns [] when " +
      "the profile is empty or nothing matches.\n\n" +
      "Query tip: use the topic words you actually care about, not full " +
      "questions. Good: 'sieve method Goldbach'. Bad: 'has the user " +
      "worked on the Goldbach conjecture using sieve methods?'",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search terms (one or more keywords; whitespace-separated).",
        },
        k: {
          type: "number",
          description: `Max results to return. Default ${DEFAULT_K}, max 20.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>) {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) {
        return { ok: false, content: "user_profile_search requires 'query'" };
      }
      let k = typeof args.k === "number" ? Math.floor(args.k) : DEFAULT_K;
      if (!Number.isFinite(k) || k <= 0) k = DEFAULT_K;
      if (k > 20) k = 20;

      try {
        const rows = await buildIndex(profileDir);
        if (rows.length === 0) {
          return {
            ok: true,
            content:
              "[]\n\n[user profile is empty — no own-papers / projects / " +
              "inferred entries yet. Suggest the user populate their " +
              "Profile page if relevant.]",
          };
        }
        const stats = computeStats(rows);
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) {
          return {
            ok: false,
            content:
              "user_profile_search: query had no scoreable tokens (too short / all stop chars)",
          };
        }
        const scored = rows
          .map((row) => ({ row, score: bm25Score(queryTokens, row, stats) }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, k);

        if (scored.length === 0) {
          return {
            ok: true,
            content: `[]\n\n[no profile entries matched "${query}"]`,
          };
        }

        const result = scored.map((s) => ({
          score: Number(s.score.toFixed(3)),
          ...s.row.payload,
        }));
        const json = JSON.stringify(result, null, 2);
        if (Buffer.byteLength(json, "utf-8") > maxBytes) {
          const truncated = Buffer.from(json, "utf-8")
            .subarray(0, maxBytes)
            .toString("utf-8");
          return {
            ok: true,
            content: `${truncated}\n\n[... truncated at ${maxBytes} bytes; lower 'k' to see fewer per call]`,
          };
        }
        return { ok: true, content: json };
      } catch (err: any) {
        return {
          ok: false,
          content: `user_profile_search error: ${err?.message ?? String(err)}`,
        };
      }
    },
  };
}

/** Lone export so tests / other tools can call the search directly. */
export async function searchProfile(
  query: string,
  k: number,
  profileDir?: string,
): Promise<unknown[]> {
  const rows = await buildIndex(profileDir);
  if (rows.length === 0) return [];
  const stats = computeStats(rows);
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  return rows
    .map((row) => ({ row, score: bm25Score(queryTokens, row, stats) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => ({ score: Number(s.score.toFixed(3)), ...s.row.payload }));
}

// Local — avoid an extra import.
type _IgnoredReaction = ReactionEntry;