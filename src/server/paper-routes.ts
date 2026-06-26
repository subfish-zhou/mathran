/**
 * REST surface for the paper graph + reactions (user-distillation Phase 2).
 *
 * Two surfaces:
 *
 *   1. Paper lookup / ingestion — `/api/papers/...`
 *      The SPA renders a PaperCard for every `arXiv:2401.12345` link it
 *      detects in a chat bubble. To render the card we need title +
 *      authors + abstract; those live in the paper-graph. If the model
 *      hasn't ingested the paper yet the SPA POSTs to /ingest which
 *      fetches arXiv metadata, ingests, and returns the node.
 *
 *   2. Reactions — `/api/papers/:paperId/reactions`
 *      User-driven 👍 / 👎 / ⭐ / 📝 stored in the LAYER 2 profile slice
 *      (~/.mathran/profile/reactions.jsonl, schema shipped in Phase 1).
 *      Idempotent: re-clicking the same reaction is a no-op; switching
 *      reaction (like → dislike) replaces the prior entry on the same
 *      paper id.
 *
 * Why one route file: paper rendering and reactions are tightly
 * coupled in UX — the PaperCard needs both metadata and the user's
 * own reaction state — so keeping them in one file matches the SPA's
 * data-fetching pattern (one composite GET per card).
 *
 * 2026-06-26.
 */

import type { Hono } from "hono";
import { ZodError } from "zod";

import {
  getPaper,
  getPaperByArxiv,
  getPaperByDoi,
  ingestPaper,
} from "../core/paper-graph/fs-store.js";
import type { PaperNode } from "../core/paper-graph/types.js";
import {
  parseArxivAtom,
  ARXIV_SEARCH_URL,
} from "../core/agents/init-project/crawlers.js";

import {
  defaultProfileDir,
  ReactionEntrySchema,
  readReactions,
  type ReactionEntry,
} from "../core/profile/index.js";
import { atomicWriteFile } from "../core/chat/atomic-write.js";
import { withFileLock } from "../core/chat/store.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Identifier scheme accepted by /api/papers/by-id/:scheme/:id. */
type IdScheme = "arxiv" | "doi" | "node";

/** Validate the scheme path param; returns null when invalid. */
function asScheme(s: string): IdScheme | null {
  return s === "arxiv" || s === "doi" || s === "node" ? s : null;
}

/**
 * Fetch arXiv metadata for a single paper by id and convert to the
 * shape ingestPaper expects. Returns null on any failure (network,
 * 404, malformed XML) so the caller can show "could not load" UX
 * without server logs filling up.
 *
 * 2026-06-26 — extracted from searchArxiv: that one expects a search
 * query; we want a precise id lookup, which arxiv's `id_list` param
 * does much faster (no relevance ranking).
 */
async function fetchArxivById(arxivId: string): Promise<{
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  url?: string;
  categories?: string[];
} | null> {
  try {
    const params = new URLSearchParams({
      id_list: arxivId,
      max_results: "1",
    });
    const res = await fetch(`${ARXIV_SEARCH_URL}?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const parsed = parseArxivAtom(xml);
    if (parsed.length === 0) return null;
    const e = parsed[0];
    return {
      title: e.title,
      authors: e.authors,
      year: e.year,
      abstract: e.abstract,
      url: e.url,
      categories: e.categories,
    };
  } catch {
    return null;
  }
}

function reactionsFile(profileDir: string): string {
  return path.join(profileDir, "reactions.jsonl");
}

async function writeReactions(
  profileDir: string,
  entries: ReactionEntry[],
): Promise<void> {
  const file = reactionsFile(profileDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body =
    entries.map((r) => JSON.stringify(r)).join("\n") +
    (entries.length > 0 ? "\n" : "");
  await atomicWriteFile(file, body);
}

/**
 * Add or replace the user's reaction on a paper. The store is keyed by
 * (paperId, reaction): clicking 👍 twice is a no-op, clicking 👎 after
 * 👍 replaces the entry. Notes (reaction === "note") are append-only
 * since each note is meant to be a distinct thought.
 *
 * Returns the entry that ended up persisted (either the new one or
 * the pre-existing one on no-op), so the SPA can update its local
 * state without a refetch.
 */
async function upsertReaction(
  profileDir: string,
  input: ReactionEntry,
): Promise<{ created: boolean; entry: ReactionEntry }> {
  const entry = ReactionEntrySchema.parse(input);
  const file = reactionsFile(profileDir);
  return await withFileLock(file, async () => {
    const existing = await readReactions(profileDir);
    if (entry.reaction === "note") {
      // Notes always append — each one is a distinct user thought.
      await writeReactions(profileDir, [...existing, entry]);
      return { created: true, entry };
    }
    const idx = existing.findIndex(
      (e) =>
        e.paperId === entry.paperId &&
        e.reaction !== "note" &&
        e.reaction === entry.reaction,
    );
    if (idx !== -1) {
      // Same paper + same reaction — no-op (idempotent click).
      return { created: false, entry: existing[idx] };
    }
    // Different non-note reaction on the same paper REPLACES the prior
    // sentiment (you can't simultaneously like and dislike the same
    // paper; star is independent and isn't touched here).
    const next = existing.filter((e) => {
      if (e.paperId !== entry.paperId) return true;
      if (e.reaction === "note") return true; // keep notes
      if (entry.reaction === "save" || e.reaction === "save") {
        // 'save' is orthogonal to like/dislike — never replace either.
        return true;
      }
      // like ↔ dislike replace each other.
      return false;
    });
    next.push(entry);
    await writeReactions(profileDir, next);
    return { created: true, entry };
  });
}

async function removeReaction(
  profileDir: string,
  paperId: string,
  reaction: ReactionEntry["reaction"],
  noteIdx?: number,
): Promise<boolean> {
  const file = reactionsFile(profileDir);
  return await withFileLock(file, async () => {
    const existing = await readReactions(profileDir);
    if (reaction === "note" && noteIdx !== undefined) {
      // Note delete is positional within this paper's notes.
      const notesOfPaper: number[] = [];
      existing.forEach((e, i) => {
        if (e.paperId === paperId && e.reaction === "note") notesOfPaper.push(i);
      });
      if (noteIdx < 0 || noteIdx >= notesOfPaper.length) return false;
      const removeAt = notesOfPaper[noteIdx];
      const next = existing.filter((_, i) => i !== removeAt);
      await writeReactions(profileDir, next);
      return true;
    }
    const next = existing.filter(
      (e) => !(e.paperId === paperId && e.reaction === reaction),
    );
    if (next.length === existing.length) return false;
    await writeReactions(profileDir, next);
    return true;
  });
}

export function registerPaperRoutes(app: Hono, workspace: string): void {
  const profileDir = defaultProfileDir();

  /**
   * Look up a paper by arxiv|doi|node id from the LOCAL paper graph.
   * 404 when not found — callers (the SPA) should follow up with
   * POST /api/papers/ingest if they want metadata pulled from arXiv.
   */
  app.get("/api/papers/by-id/:scheme/:id", async (c) => {
    const scheme = asScheme(c.req.param("scheme"));
    const id = c.req.param("id");
    if (!scheme) return c.json({ error: "scheme must be arxiv|doi|node" }, 400);
    if (!id) return c.json({ error: "missing id" }, 400);
    let paper: PaperNode | null;
    switch (scheme) {
      case "arxiv":
        paper = await getPaperByArxiv(workspace, id);
        break;
      case "doi":
        paper = await getPaperByDoi(workspace, id);
        break;
      case "node":
        paper = await getPaper(workspace, id);
        break;
    }
    if (!paper) return c.json({ error: "paper not found" }, 404);
    return c.json({ paper });
  });

  /**
   * Ingest a paper from arXiv given just an id. Used by the SPA's
   * PaperCard when it sees an `arXiv:` link the local graph doesn't
   * know about yet. Returns the (now-persisted) PaperNode.
   *
   * Body: { arxivId: string } — DOI ingestion is not implemented in
   * this phase (no crossref crawler yet).
   */
  app.post("/api/papers/ingest", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const arxivId = typeof body?.arxivId === "string" ? body.arxivId.trim() : "";
    if (!arxivId) {
      return c.json({ error: "body.arxivId is required" }, 400);
    }
    // Fast path — already ingested.
    const existing = await getPaperByArxiv(workspace, arxivId);
    if (existing) return c.json({ paper: existing, ingested: false });

    const meta = await fetchArxivById(arxivId);
    if (!meta) {
      return c.json(
        { error: `arXiv lookup failed for id '${arxivId}' (network / 404 / malformed)` },
        502,
      );
    }
    const nodeId = await ingestPaper(workspace, {
      arxivId,
      title: meta.title,
      authors: meta.authors,
      year: meta.year,
      abstract: meta.abstract,
      url: meta.url,
      categories: meta.categories,
    });
    if (!nodeId) {
      return c.json({ error: "ingestion failed" }, 500);
    }
    const paper = await getPaper(workspace, nodeId);
    if (!paper) {
      return c.json({ error: "ingest returned an id but node is unreadable" }, 500);
    }
    return c.json({ paper, ingested: true }, 201);
  });

  // ── Reactions ─────────────────────────────────────────────────────

  /**
   * Get all reactions for one paper. Used by the PaperCard to render
   * the current 👍 / 👎 / ⭐ state and any notes the user has attached.
   * Returns `{ reactions: ReactionEntry[] }` — empty array when there
   * are none.
   */
  app.get("/api/papers/:paperId/reactions", async (c) => {
    const paperId = c.req.param("paperId");
    if (!paperId) return c.json({ error: "missing paperId" }, 400);
    const all = await readReactions(profileDir);
    return c.json({ reactions: all.filter((e) => e.paperId === paperId) });
  });

  /**
   * POST a new reaction. Body matches ReactionEntrySchema except
   * `timestamp` is server-set so the SPA can't lie about ordering.
   *
   * Returns `{ created, entry }`. `created: false` means the reaction
   * was already present (idempotent click) — useful so the SPA can
   * still confirm its local state matches the server.
   */
  app.post("/api/papers/:paperId/reactions", async (c) => {
    const paperId = c.req.param("paperId");
    if (!paperId) return c.json({ error: "missing paperId" }, 400);
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const merged = {
      paperId,
      reaction: body?.reaction,
      conversationId:
        typeof body?.conversationId === "string" ? body.conversationId : undefined,
      bubbleIdx:
        typeof body?.bubbleIdx === "number" ? body.bubbleIdx : undefined,
      body: typeof body?.body === "string" ? body.body : undefined,
      timestamp: new Date().toISOString(),
    };
    try {
      const r = await upsertReaction(profileDir, merged);
      return c.json(r, r.created ? 201 : 200);
    } catch (err) {
      if (err instanceof ZodError) {
        return c.json(
          {
            error: "reaction failed validation",
            issues: err.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
          400,
        );
      }
      return c.json(
        { error: `failed to add: ${(err as Error)?.message ?? err}` },
        500,
      );
    }
  });

  /**
   * DELETE a reaction. For 👍 / 👎 / ⭐ the (paperId, reaction) pair is
   * unique so the query param `reaction=like|dislike|save` is enough.
   * For notes use `reaction=note&noteIdx=N` (0-indexed within that
   * paper's notes).
   */
  app.delete("/api/papers/:paperId/reactions", async (c) => {
    const paperId = c.req.param("paperId");
    const reactionParam = c.req.query("reaction") ?? "";
    if (!["like", "dislike", "save", "note"].includes(reactionParam)) {
      return c.json(
        { error: "query 'reaction' must be like|dislike|save|note" },
        400,
      );
    }
    const reaction = reactionParam as ReactionEntry["reaction"];
    const noteIdxRaw = c.req.query("noteIdx");
    const noteIdx =
      noteIdxRaw !== undefined && noteIdxRaw !== ""
        ? Number(noteIdxRaw)
        : undefined;
    if (reaction === "note" && (noteIdx === undefined || !Number.isInteger(noteIdx))) {
      return c.json(
        { error: "deleting a note requires integer noteIdx" },
        400,
      );
    }
    const removed = await removeReaction(profileDir, paperId, reaction, noteIdx);
    return c.json({ removed });
  });
}
