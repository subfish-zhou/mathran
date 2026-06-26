/**
 * Client for /api/papers and /api/papers/:id/reactions
 * (user-distillation Phase 2).
 *
 * Two hooks:
 *   - usePaperByRef(scheme, id) — fetch metadata (auto-ingest if the
 *     local graph doesn't know it yet)
 *   - useReactions(paperId)    — fetch + mutate reactions
 *
 * One module-level cache keyed by (scheme, id) so the same paper
 * mentioned twice in a conversation doesn't fire two arXiv requests.
 */

import { useCallback, useEffect, useState } from "react";
import type { PaperRefScheme } from "./paper-detector.ts";

export interface PaperNode {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  url?: string;
  arxivId?: string;
  doi?: string;
  categories?: string[];
  isSurvey?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReactionEntry {
  paperId: string;
  reaction: "like" | "dislike" | "save" | "note";
  conversationId?: string;
  bubbleIdx?: number;
  body?: string;
  timestamp: string;
}

type PaperFetchState =
  | { status: "loading"; paper: null }
  | { status: "ok"; paper: PaperNode }
  | { status: "error"; paper: null; error: string };

const paperCache = new Map<string, Promise<PaperNode>>();

function cacheKey(scheme: PaperRefScheme, id: string): string {
  return `${scheme}:${id}`;
}

/**
 * Fetch a paper by scheme/id. Auto-ingests when scheme=arxiv and the
 * local graph doesn't have it yet. Throws on failure so the caller
 * can render a fallback.
 */
async function loadPaper(scheme: PaperRefScheme, id: string): Promise<PaperNode> {
  const url = `/api/papers/by-id/${encodeURIComponent(scheme)}/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (res.ok) {
    const data = (await res.json()) as { paper: PaperNode };
    return data.paper;
  }
  if (res.status === 404 && scheme === "arxiv") {
    // Try ingesting — the paper may be valid but just not yet known.
    const ingest = await fetch("/api/papers/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ arxivId: id }),
    });
    if (!ingest.ok) {
      const text = await ingest.text().catch(() => `HTTP ${ingest.status}`);
      throw new Error(`ingest failed: ${text}`);
    }
    const data = (await ingest.json()) as { paper: PaperNode };
    return data.paper;
  }
  const text = await res.text().catch(() => `HTTP ${res.status}`);
  throw new Error(text);
}

/**
 * Look up a paper by scheme/id, cached across the page. Multiple
 * components rendering the same paper share one in-flight request.
 */
export function usePaperByRef(
  scheme: PaperRefScheme,
  id: string,
): PaperFetchState {
  const [state, setState] = useState<PaperFetchState>({
    status: "loading",
    paper: null,
  });
  useEffect(() => {
    let cancelled = false;
    const key = cacheKey(scheme, id);
    let promise = paperCache.get(key);
    if (!promise) {
      promise = loadPaper(scheme, id);
      paperCache.set(key, promise);
    }
    promise.then(
      (paper) => {
        if (!cancelled) setState({ status: "ok", paper });
      },
      (err: any) => {
        if (cancelled) return;
        // Drop failed entry so a retry / different paper isn't stuck on it.
        paperCache.delete(key);
        setState({
          status: "error",
          paper: null,
          error: err?.message ?? String(err),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scheme, id]);
  return state;
}

// ─── Reactions ───────────────────────────────────────────────────────

export interface ReactionsState {
  reactions: ReactionEntry[];
  loading: boolean;
  error: string | null;
}

export function useReactions(paperId: string | null): {
  state: ReactionsState;
  refresh: () => Promise<void>;
  toggleQuickReaction: (
    reaction: "like" | "dislike" | "save",
    ctx?: { conversationId?: string; bubbleIdx?: number },
  ) => Promise<void>;
  addNote: (
    body: string,
    ctx?: { conversationId?: string; bubbleIdx?: number },
  ) => Promise<void>;
} {
  const [state, setState] = useState<ReactionsState>({
    reactions: [],
    loading: paperId !== null,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!paperId) {
      setState({ reactions: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await fetch(
        `/api/papers/${encodeURIComponent(paperId)}/reactions`,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        setState({ reactions: [], loading: false, error: text });
        return;
      }
      const data = (await res.json()) as { reactions: ReactionEntry[] };
      setState({
        reactions: Array.isArray(data.reactions) ? data.reactions : [],
        loading: false,
        error: null,
      });
    } catch (err: any) {
      setState({
        reactions: [],
        loading: false,
        error: err?.message ?? String(err),
      });
    }
  }, [paperId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleQuickReaction = useCallback(
    async (
      reaction: "like" | "dislike" | "save",
      ctx: { conversationId?: string; bubbleIdx?: number } = {},
    ) => {
      if (!paperId) return;
      // If we already have this reaction, DELETE it (toggle off).
      const already = state.reactions.some(
        (r) => r.reaction === reaction,
      );
      if (already) {
        await fetch(
          `/api/papers/${encodeURIComponent(paperId)}/reactions?reaction=${reaction}`,
          { method: "DELETE" },
        );
      } else {
        await fetch(
          `/api/papers/${encodeURIComponent(paperId)}/reactions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reaction, ...ctx }),
          },
        );
      }
      await refresh();
    },
    [paperId, refresh, state.reactions],
  );

  const addNote = useCallback(
    async (
      body: string,
      ctx: { conversationId?: string; bubbleIdx?: number } = {},
    ) => {
      if (!paperId) return;
      const trimmed = body.trim();
      if (!trimmed) return;
      await fetch(`/api/papers/${encodeURIComponent(paperId)}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction: "note", body: trimmed, ...ctx }),
      });
      await refresh();
    },
    [paperId, refresh],
  );

  return { state, refresh, toggleQuickReaction, addNote };
}
