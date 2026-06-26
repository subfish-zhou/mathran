/**
 * MemoryPanel — read-only display of `<workspace>/.mathran/memory/<topic>.md`.
 *
 * Mathran's `memory_*` tools let the model persist long-lived notes across
 * sessions, but until 2026-06-26 there was no UI to see what got written.
 * This panel is the user-distillation Phase 0 foundation: before we add
 * any "profile" surface that pretends to model the user's taste, the user
 * needs to see what mathran is already storing in plain memory. Otherwise
 * all subsequent profile work is black-box.
 *
 * Behaviour:
 *   - Two-pane layout. Left = topic list (sorted newest-first), right =
 *     body of the selected topic (markdown rendered via safeRenderMarkdown).
 *   - "Refresh" button — until we wire memory writes through SSE, the
 *     user nudges the panel after a turn to see new topics.
 *   - Empty state explains what memory is + how it gets written (so a
 *     fresh workspace doesn't look broken).
 *
 * Not in scope (Phase 0): edit / delete topic from the SPA, search,
 * topic-write detection via SSE. Those land in later phases.
 */

import { useEffect, useState } from "react";

import { safeRenderMarkdown } from "../lib/safe-markdown.ts";
import {
  fetchMemoryTopicBody,
  useMemoryTopics,
  type MemoryTopicBody,
} from "../lib/memory.ts";

export function MemoryPanel(): JSX.Element {
  const { state, refresh } = useMemoryTopics();
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [body, setBody] = useState<MemoryTopicBody | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);

  // Auto-select the newest topic on first load — the most common thing a
  // user wants to see when they open the panel is "what did mathran just
  // write?". Persists nothing across sessions; trivially refreshable.
  useEffect(() => {
    if (state.status !== "ok") return;
    if (selectedTopic !== null) return;
    if (state.topics.length === 0) return;
    setSelectedTopic(state.topics[0].topic);
  }, [state, selectedTopic]);

  // Load body when selection changes.
  useEffect(() => {
    if (!selectedTopic) {
      setBody(null);
      setBodyError(null);
      return;
    }
    let cancelled = false;
    setBodyLoading(true);
    setBodyError(null);
    void (async () => {
      try {
        const result = await fetchMemoryTopicBody(selectedTopic);
        if (cancelled) return;
        setBody(result);
        if (result === null) setBodyError("topic no longer exists");
      } catch (err: any) {
        if (cancelled) return;
        setBodyError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setBodyLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedTopic]);

  const isEmpty = state.status === "ok" && state.topics.length === 0;
  const isError = state.status === "error";

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Memory</h2>
          <p className="text-xs text-slate-500">
            {state.status === "loading"
              ? "Loading…"
              : `${state.topics.length} topic${state.topics.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
          title="Re-fetch the topic list (mathran writes memory via tools — refresh after a turn)"
        >
          Refresh
        </button>
      </div>

      {isError && (
        <p className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          Failed to list memory topics: {state.error}
        </p>
      )}

      {isEmpty ? (
        <div className="flex-1 p-4 text-sm text-slate-600">
          <p className="mb-2 font-medium">No memory topics yet.</p>
          <p className="mb-2">
            Memory is mathran's cross-session scratch space. The model writes
            here when it wants to remember something for next time —
            preferences, conventions, project state — using the{" "}
            <code className="rounded bg-slate-100 px-1">memory_write</code> /{" "}
            <code className="rounded bg-slate-100 px-1">memory_append</code>{" "}
            tools.
          </p>
          <p>
            New topics will appear here. Hit{" "}
            <strong>Refresh</strong> after a chat turn to see them, or open the
            panel later — the list reloads on mount.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-48 shrink-0 overflow-y-auto border-r border-slate-200">
            {state.topics.map((meta) => {
              const active = meta.topic === selectedTopic;
              return (
                <button
                  key={meta.topic}
                  type="button"
                  onClick={() => setSelectedTopic(meta.topic)}
                  className={`block w-full border-b border-slate-100 px-3 py-2 text-left text-xs hover:bg-slate-50 ${
                    active ? "bg-amber-50" : ""
                  }`}
                  title={meta.preview || meta.topic}
                >
                  <div className="truncate font-medium text-slate-800">
                    {meta.topic}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-500">
                    <span>{formatBytes(meta.bytes)}</span>
                    <span>{formatRelativeTime(meta.modifiedAt)}</span>
                  </div>
                  {meta.preview && (
                    <div className="mt-0.5 truncate text-[11px] text-slate-500">
                      {meta.preview}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {bodyLoading ? (
              <p className="text-xs text-slate-400">Loading…</p>
            ) : bodyError ? (
              <p className="text-xs text-rose-700">{bodyError}</p>
            ) : body ? (
              <article
                className="prose prose-sm max-w-none"
                // safeRenderMarkdown is XSS-safe (DOMPurify wrap, audited D1)
                dangerouslySetInnerHTML={{
                  __html: safeRenderMarkdown(body.body),
                }}
              />
            ) : (
              <p className="text-xs text-slate-400">
                Select a topic on the left to view its contents.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  return new Date(iso).toLocaleDateString();
}
