/**
 * Scoped chat panel: drives one conversation inside a given `ChatScopeSpec`
 * (global / project / effort).
 *
 * v0.12.x changes:
 *   - Adds a per-scope conversation sidebar (list / new / select / delete).
 *   - URL `?c=<id>` persists the active conversation so a hard refresh
 *     re-hydrates the same chat (previously refresh = blank new chat).
 *   - Selecting / refreshing an existing conversation fetches its history
 *     via `api.getChatHistory()` and reconstructs `Bubble[]` from the
 *     persisted `LLMMessage[]`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { marked } from "marked";
import { streamChat, type ChatEvent } from "../lib/chat.ts";
import { api, type ChatScopeSpec, type ConversationSummary, type UsageStats } from "../lib/api.ts";
import {
  historyToBubbles,
  type Bubble,
  type ToolBubble,
} from "../lib/history-to-bubbles.ts";
import {
  buildConversationLatex,
  buildConversationMarkdown,
  copyToClipboard,
  downloadMarkdown,
  downloadText,
  type ExportTimelineItem,
} from "../lib/chat-export.ts";
import ContextMeter from "./ContextMeter.tsx";
import { ToolCallDisplay } from "./ToolCallDisplay.tsx";

export default function ChatPanel({
  scope,
  scopeLabel,
}: {
  scope: ChatScopeSpec;
  scopeLabel: string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlConvId = searchParams.get("c");

  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(urlConvId);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ─── Conversation list ─────────────────────────────────────────────────
  const refreshList = useCallback(async () => {
    try {
      const list = await api.listChats(scope);
      setConversations(list);
    } catch {
      // Silent — the list is best-effort.
    }
  }, [scope.kind, (scope as any).projectSlug, (scope as any).effortSlug]);

  // ─── Scope change: reset everything, then reload list + selected conv ──
  useEffect(() => {
    setBubbles([]);
    setError(null);
    setInput("");
    setUsage(null);
    setConversationId(urlConvId);
    void refreshList();
    // We intentionally re-run when scope changes; urlConvId is read once per
    // scope switch (URL state is per-scope independent anyway).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.kind, (scope as any).projectSlug, (scope as any).effortSlug]);

  // ─── Selection change (URL?c=…): hydrate history if not blank ──────────
  useEffect(() => {
    if (!conversationId) {
      setBubbles([]);
      setUsage(null);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    api
      .getChatHistory(scope, conversationId)
      .then((data) => {
        if (cancelled) return;
        setBubbles(historyToBubbles(data.history));
      })
      .catch((err) => {
        if (cancelled) return;
        // 404 = brand-new id not yet on disk; fine, leave empty.
        if (!/404|not found/i.test((err as Error).message)) {
          setError((err as Error).message);
        }
        setBubbles([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, scope.kind, (scope as any).projectSlug, (scope as any).effortSlug]);

  // ─── Selection change: keep URL in sync ────────────────────────────────
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (conversationId) {
      if (next.get("c") !== conversationId) {
        next.set("c", conversationId);
        setSearchParams(next, { replace: true });
      }
    } else {
      if (next.has("c")) {
        next.delete("c");
        setSearchParams(next, { replace: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // ─── Default model from /api/providers ─────────────────────────────────
  useEffect(() => {
    api
      .getProviders()
      .then((p) => {
        if (p.defaultModel) setModel(p.defaultModel);
      })
      .catch(() => {});
  }, []);

  // ─── Auto-scroll on new bubbles ────────────────────────────────────────
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles]);

  // ─── Usage meter: refetch whenever conversationId changes ──────────────
  const refreshUsage = useCallback(async () => {
    if (!conversationId) return;
    try {
      const u = await api.getChatUsage(scope, conversationId, model || undefined);
      setUsage(u);
    } catch {
      // Meter is decorative; never break the chat surface.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, scope.kind, model]);

  useEffect(() => {
    if (!conversationId) return;
    void refreshUsage();
  }, [conversationId, refreshUsage]);

  // ─── Send a message ────────────────────────────────────────────────────
  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setBubbles((b) => [...b, { kind: "user", text }, { kind: "assistant", text: "" }]);

    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "session") {
        setConversationId(ev.conversationId);
        return;
      }
      setBubbles((prev) => {
        const next = [...prev];
        if (ev.type === "text") {
          const last = next[next.length - 1];
          if (last && last.kind === "assistant") {
            next[next.length - 1] = { ...last, text: last.text + ev.delta };
          } else {
            next.push({ kind: "assistant", text: ev.delta });
          }
        } else if (ev.type === "tool-call") {
          next.push({ kind: "tool", id: ev.id, name: ev.name, args: ev.args });
        } else if (ev.type === "tool-result") {
          const idx = next.findIndex(
            (x) => x.kind === "tool" && (x as ToolBubble).id === ev.id,
          );
          if (idx !== -1) {
            next[idx] = { ...(next[idx] as ToolBubble), result: ev.content, ok: ev.ok };
          } else {
            next.push({ kind: "tool", id: ev.id, name: ev.name, result: ev.content, ok: ev.ok });
          }
          next.push({ kind: "assistant", text: "" });
        } else if (ev.type === "error") {
          setError(ev.message);
        }
        return next;
      });
    };

    try {
      await streamChat(scope, text, conversationId ?? undefined, model || undefined, onEvent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setBubbles((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === "assistant" && last.text === "") return prev.slice(0, -1);
        return prev;
      });
      void refreshUsage();
      void refreshList(); // pick up the brand-new conv in the sidebar
    }
  }

  // ─── New / Select / Delete ─────────────────────────────────────────────
  function newChat() {
    setConversationId(null);
    setBubbles([]);
    setError(null);
    setUsage(null);
  }

  function selectConv(id: string) {
    if (id === conversationId) return;
    setConversationId(id);
    setError(null);
  }

  async function deleteConv(id: string) {
    if (!confirm(`Delete conversation "${id}"? This cannot be undone.`)) return;
    try {
      await api.dropChat(scope, id);
      await refreshList();
      if (id === conversationId) newChat();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ─── Export ───────────────────────────────────────────────────────────
  //
  // mathran chats are math-heavy and we (subfish, 2026-06-19) want both a quick
  // copy-to-clipboard for re-posting and a clean LaTeX dump for archival. The
  // helpers come from `lib/chat-export.ts` (adapted from mathub) which already
  // handles math/CJK fidelity (see chat-export.test.ts).
  const exportItems = useMemo<ExportTimelineItem[]>(() => {
    const now = new Date();
    // Tool bubbles are intentionally excluded — they're scaffolding, not chat.
    return bubbles
      .filter((b): b is Exclude<Bubble, ToolBubble> => b.kind !== "tool")
      .map((b) => ({ role: b.kind, content: b.text, createdAt: now }));
  }, [bubbles]);

  const exportTitle = useMemo(() => {
    const conv = conversations.find((c) => c.id === conversationId);
    return conv?.title || scopeLabel || "Mathran chat";
  }, [conversations, conversationId, scopeLabel]);

  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  useEffect(() => {
    if (!copyFeedback) return;
    const t = window.setTimeout(() => setCopyFeedback(null), 1500);
    return () => window.clearTimeout(t);
  }, [copyFeedback]);

  async function onCopyMarkdown() {
    if (exportItems.length === 0) return;
    const md = buildConversationMarkdown(exportTitle, exportItems);
    const ok = await copyToClipboard(md);
    setCopyFeedback(ok ? "Copied!" : "Copy failed");
  }

  function onDownloadMarkdown() {
    if (exportItems.length === 0) return;
    downloadMarkdown(exportTitle, buildConversationMarkdown(exportTitle, exportItems));
  }

  function onDownloadLatex() {
    if (exportItems.length === 0) return;
    downloadText(
      exportTitle,
      buildConversationLatex(exportTitle, exportItems),
      "tex",
      "text/x-tex;charset=utf-8",
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full">
      {/* ─── Conversation sidebar ─────────────────────────────────────── */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {scopeLabel}
          </div>
          <button
            type="button"
            onClick={newChat}
            className="w-full rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
          >
            + New chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.length === 0 && (
            <p className="px-2 py-3 text-xs text-slate-400">No chats yet.</p>
          )}
          <ul className="space-y-1">
            {conversations.map((c) => {
              const active = c.id === conversationId;
              return (
                <li key={c.id}>
                  <div
                    className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs transition ${
                      active
                        ? "bg-slate-900 text-white"
                        : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectConv(c.id)}
                      className="min-w-0 flex-1 truncate text-left"
                      title={`${c.title}\n${c.messageCount} message${c.messageCount === 1 ? "" : "s"} · ${new Date(c.lastUsedAt).toLocaleString()}`}
                    >
                      <div className="truncate font-medium">{c.title || c.id}</div>
                      <div
                        className={`truncate text-[10px] ${
                          active ? "text-slate-300" : "text-slate-400"
                        }`}
                      >
                        {c.messageCount} msg · {new Date(c.lastUsedAt).toLocaleDateString()}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteConv(c.id)}
                      className={`shrink-0 rounded px-1 py-0.5 text-[10px] opacity-0 transition group-hover:opacity-100 ${
                        active
                          ? "text-slate-300 hover:bg-slate-700"
                          : "text-slate-400 hover:bg-red-100 hover:text-red-700"
                      }`}
                      title="Delete this conversation"
                      aria-label={`Delete ${c.id}`}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      {/* ─── Chat surface ─────────────────────────────────────────────── */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Chat</h2>
            <p className="truncate text-xs text-slate-400">
              {scopeLabel}
              {conversationId && (
                <>
                  {" "}
                  · <span className="font-mono">{conversationId}</span>
                </>
              )}
            </p>
          </div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model (e.g. copilot/gpt-5.5)"
            className="w-64 rounded-md border border-slate-300 px-2 py-1 text-xs font-mono outline-none focus:border-slate-500"
          />
        </div>

        {/* ─── Export toolbar ─── */}
        {exportItems.length > 0 && (
          <div className="flex items-center gap-1 border-b border-slate-200 bg-slate-50 px-6 py-1.5 text-xs">
            <span className="mr-1 text-slate-500">Export:</span>
            <button
              type="button"
              onClick={() => void onCopyMarkdown()}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
              title="Copy the whole conversation to clipboard as Markdown"
            >
              📋 Copy MD
            </button>
            <button
              type="button"
              onClick={onDownloadMarkdown}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
              title="Download as a .md file"
            >
              ⬇ .md
            </button>
            <button
              type="button"
              onClick={onDownloadLatex}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 hover:bg-slate-100"
              title="Download as XeLaTeX (math + CJK safe)"
            >
              ⬇ .tex
            </button>
            {copyFeedback && (
              <span className="ml-2 text-emerald-600">{copyFeedback}</span>
            )}
          </div>
        )}

        {usage ? (
          <ContextMeter
            tokens={usage.tokens}
            contextWindow={usage.contextWindow}
            warning={usage.warning}
            percentage={usage.percentage}
          />
        ) : conversationId ? (
          <ContextMeter
            tokens={0}
            contextWindow={200_000}
            warning={null}
            percentage={0}
            loading
          />
        ) : null}

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-6">
          {loadingHistory && (
            <p className="text-sm text-slate-400">Loading history…</p>
          )}
          {!loadingHistory && bubbles.length === 0 && (
            <p className="text-sm text-slate-400">
              {conversationId
                ? "Empty conversation. Send a message to start."
                : "Ask a math or Lean question to start a new chat."}
            </p>
          )}
          {bubbles.map((b, i) =>
            b.kind === "tool" ? (
              <ToolCallDisplay key={i} toolCall={b} />
            ) : (
              <div
                key={i}
                className={`flex ${b.kind === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-2xl rounded-lg px-4 py-2 text-sm ${
                    b.kind === "user"
                      ? "bg-slate-900 text-white"
                      : "border border-slate-200 bg-white"
                  }`}
                >
                  {b.kind === "assistant" ? (
                    <div
                      className="md"
                      dangerouslySetInnerHTML={{ __html: marked.parse(b.text || "…") as string }}
                    />
                  ) : (
                    <span className="whitespace-pre-wrap">{b.text}</span>
                  )}
                </div>
              </div>
            ),
          )}
        </div>

        {error && (
          <div className="mx-6 mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={send} className="flex gap-2 border-t border-slate-200 bg-white p-4">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message…"
            disabled={busy}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "…" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
