/**
 * Client for the `/api/memory` REST surface (2026-06-26 user-distillation
 * Phase 0). Read-only — listing topics and reading a topic body.
 *
 * Why a hook + a thunk: the panel lists topics (continuous data) and
 * needs to refresh after the model writes (event-driven). The body
 * fetch is one-shot on click. Splitting them lets the panel re-render
 * the list without re-reading every body.
 */

import { useCallback, useEffect, useState } from "react";

export interface MemoryTopicMeta {
  topic: string;
  bytes: number;
  modifiedAt: string;
  preview: string;
}

export interface MemoryTopicBody {
  topic: string;
  body: string;
  bytes: number;
  modifiedAt: string;
}

export type MemoryListState =
  | { status: "loading"; topics: MemoryTopicMeta[] }
  | { status: "ok"; topics: MemoryTopicMeta[] }
  | { status: "error"; topics: MemoryTopicMeta[]; error: string };

/**
 * Subscribe to the list of memory topics. Returns the current snapshot
 * plus a `refresh()` thunk the caller can fire after writes (e.g. when
 * the SSE pump indicates the model called memory_write).
 *
 * Keeps the previous topic list across reloads — avoids the panel
 * flashing empty during a refetch.
 */
export function useMemoryTopics(): {
  state: MemoryListState;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<MemoryListState>({
    status: "loading",
    topics: [],
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`);
        setState((prev) => ({ status: "error", topics: prev.topics, error: msg }));
        return;
      }
      const data = (await res.json()) as { topics?: MemoryTopicMeta[] };
      const topics = Array.isArray(data.topics) ? data.topics : [];
      setState({ status: "ok", topics });
    } catch (err: any) {
      setState((prev) => ({
        status: "error",
        topics: prev.topics,
        error: err?.message ?? String(err),
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { state, refresh };
}

/**
 * Fetch a single topic body. Returns null when the topic doesn't exist
 * (404) so the caller can render an empty state without an error toast.
 * Throws on network or 5xx so callers see real failures.
 */
export async function fetchMemoryTopicBody(
  topic: string,
): Promise<MemoryTopicBody | null> {
  const res = await fetch(`/api/memory/${encodeURIComponent(topic)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const msg = await res.text().catch(() => `HTTP ${res.status}`);
    throw new Error(`failed to load memory topic '${topic}': ${msg}`);
  }
  return (await res.json()) as MemoryTopicBody;
}
