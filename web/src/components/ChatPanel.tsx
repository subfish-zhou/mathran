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
import {
  streamChat,
  rerunChat,
  truncateChat,
  fetchAnnotations,
  patchAnnotation,
  toggleReaction,
  type ChatEvent,
  type ConversationAnnotations,
  type MessageAnnotation,
} from "../lib/chat.ts";
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
import ToolCallGroup from "./ToolCallGroup.tsx";

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
  // Abort controller for the in-flight chat stream. `send` / `reRun` set it
  // before kicking off pumpSSE; the Stop button calls `.abort()` to interrupt.
  // Cleared in `runChatStream`'s finally block so the next turn starts fresh.
  const abortRef = useRef<AbortController | null>(null);
  // Bubble index currently being edited in-place (null = no inline editor).
  // Only user bubbles are editable; committing the edit truncates history at
  // that bubble and re-streams with the new prompt body via `rerunChat`.
  const [editingBubbleIdx, setEditingBubbleIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  // ─── Annotations (v0.16 §2) ────────────────────────────────────────
  // Per-message reactions/pin/note/replyTo. Loaded once per conversation
  // change; mutated optimistically by reaction/pin/note handlers.
  const [annotations, setAnnotations] = useState<ConversationAnnotations>({
    version: 1,
    byBubbleIdx: {},
  });
  // Which message we're replying to (the next send carries it forward).
  const [replyTarget, setReplyTarget] = useState<
    | { bubbleIdx: number; snippet: string }
    | null
  >(null);
  // Open emoji picker: bubbleIdx of the message currently showing the
  // picker, or null when nothing is open. Closed on emoji pick or outside
  // click.
  const [pickerOpenFor, setPickerOpenFor] = useState<number | null>(null);
  // Inline note editor target. Same idea as editingBubbleIdx but for the
  // per-message margin note instead of the prompt text itself.
  const [noteEditingIdx, setNoteEditingIdx] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // Whether the pinned-only filter sidebar drawer is open.
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);
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
      setAnnotations({ version: 1, byBubbleIdx: {} });
      setReplyTarget(null);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    // Parallel load: history + annotations. Annotation failures are
    // non-fatal (the SPA renders without them) so we swallow that branch.
    Promise.all([
      api.getChatHistory(scope, conversationId),
      fetchAnnotations(scope, conversationId).catch(() => ({
        version: 1 as const,
        byBubbleIdx: {} as Record<string, MessageAnnotation>,
      })),
    ])
      .then(([data, ann]) => {
        if (cancelled) return;
        setBubbles(historyToBubbles(data.history));
        setAnnotations(ann);
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

  // ─── Stream runner (shared by send + reRun) ───────────────────────────
  //
  // Both flows take a `streamPromise` that drives the SSE pump and pipe its
  // events through the same bubble-mutating handler. Extracting this keeps
  // re-run's UX (token streaming, tool bubbles, error surface, usage meter)
  // identical to a fresh send without duplicating the event tape.
  const runChatStream = useCallback(
    async (driver: (onEvent: (ev: ChatEvent) => void, signal: AbortSignal) => Promise<void>) => {
      // Wire up a fresh AbortController for this stream so the Stop button has
      // something to .abort(). Stash on a ref so React state churn doesn't
      // invalidate it mid-stream.
      const controller = new AbortController();
      abortRef.current = controller;

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
        await driver(onEvent, controller.signal);
      } catch (err) {
        // AbortError is the Stop button doing its job, not a real failure.
        const e = err as Error;
        if (e?.name !== "AbortError") setError(e.message);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
        // Trim a trailing empty assistant bubble that can linger when the
        // stream errors out (or is stopped) before any tokens land. Without
        // this the user sees an ellipsis-only "…" bubble that they can't
        // get rid of.
        setBubbles((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === "assistant" && last.text === "") return prev.slice(0, -1);
          return prev;
        });
        void refreshUsage();
        void refreshList(); // pick up the brand-new conv in the sidebar
      }
    },
    [refreshUsage, refreshList],
  );

  // ─── Stop the in-flight stream (v0.16 §1) ────────────────────────────────────
  // Calling .abort() rejects the in-flight fetch with AbortError, which
  // bubbles up through pumpSSE -> runChatStream's catch (silenced) and
  // triggers the finally block above. Partial assistant text already in the
  // bubble list survives; the server-side flush still runs because the SSE
  // handler's `finally` calls store.flush() before returning.
  function stop() {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }

  // ─── Send a message ────────────────────────────────────────────────────
  async function send(e: React.FormEvent) {
    e.preventDefault();
    const rawText = input.trim();
    if (!rawText || busy) return;
    setInput("");
    setError(null);
    setBusy(true);

    // ─── Reply quoting (v0.16 §2) ────────────────────────────────────
    // When replying, we prepend a markdown blockquote so the LLM sees the
    // context inline. We *also* drop a replyTo annotation on the new user
    // bubble so the SPA renders an "↩ replying to… [jump]" badge that's
    // separate from the prompt body.
    const reply = replyTarget;
    const promptText = reply
      ? `> ${reply.snippet.replace(/\n/g, "\n> ")}\n\n${rawText}`
      : rawText;
    setReplyTarget(null);

    // Record the bubble index of the user message we're about to add so
    // we can PATCH its annotation once the SSE round trip starts.
    const userBubbleIdx = bubbles.length;
    setBubbles((b) => [
      ...b,
      { kind: "user", text: rawText },
      { kind: "assistant", text: "" },
    ]);

    // Fire the annotation PATCH in parallel — it doesn't need to block
    // the stream. Server resolves conversationId lazily; if conversationId
    // is still null at this point the PATCH would 400, so we only fire
    // when we already have one (i.e. follow-up turns).
    if (reply && conversationId) {
      void patchAnnotation(scope, conversationId, userBubbleIdx, {
        replyTo: reply,
      }).catch(() => {
        /* annotation is best-effort — stream is what matters */
      });
      // Optimistic local update so the badge shows immediately.
      setAnnotations((prev) => {
        const next = { ...prev.byBubbleIdx };
        next[String(userBubbleIdx)] = {
          ...(next[String(userBubbleIdx)] ?? {}),
          replyTo: reply,
        };
        return { version: 1, byBubbleIdx: next };
      });
    }

    await runChatStream((onEvent, signal) =>
      streamChat(scope, promptText, conversationId ?? undefined, model || undefined, onEvent, signal),
    );
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

  // ─── Render rows: cluster adjacent tool bubbles into one ToolCallGroup
  // (v0.14 §1). A row is either a single non-tool bubble or a run of one
  // or more consecutive tool bubbles.
  type NonToolBubble = Extract<Bubble, { kind: "user" } | { kind: "assistant" }>;
  type Row =
    | { kind: "single"; bubble: NonToolBubble; bubbleIdx: number }
    | { kind: "tools"; tools: ToolBubble[] };
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let buffer: ToolBubble[] = [];
    const flushTools = () => {
      if (buffer.length > 0) {
        out.push({ kind: "tools", tools: buffer });
        buffer = [];
      }
    };
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      // v0.16 §2: when filtering to pinned-only, drop both tool bubbles
      // (they're never standalone-meaningful) and any single bubble that
      // doesn't have pinned=true in its annotation. The data-bubble-idx
      // attribute keeps jumpToBubble() working off the original index.
      if (showPinnedOnly) {
        if (b.kind === "tool") continue;
        if (!annotations.byBubbleIdx[String(i)]?.pinned) continue;
        out.push({ kind: "single", bubble: b, bubbleIdx: i });
        continue;
      }
      if (b.kind === "tool") {
        buffer.push(b);
      } else {
        flushTools();
        // Carry the original `bubbles` index so per-row actions (re-run
        // in particular) can locate the bubble without an O(n) lookup.
        out.push({ kind: "single", bubble: b, bubbleIdx: i });
      }
    }
    flushTools();
    return out;
  }, [bubbles, showPinnedOnly, annotations]);

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

  // ─── Per-message actions (v0.14 §2) ─────────────────────────────────────────────────
  // Copy = single message to clipboard.
  // Re-run = restage the user's prompt as if they just typed it (useful when
  // the assistant's previous reply was bad and you want a fresh sample).
  async function copyOneMessage(text: string) {
    const ok = await copyToClipboard(text);
    setCopyFeedback(ok ? "Copied!" : "Copy failed");
  }

  // Re-run = truncate the conversation to this user prompt and re-stream a
  //          fresh assistant reply server-side. Old behavior ("paste back
  //          into the composer") was wrong: it forced an extra Send click,
  //          kept the stale assistant reply in history, and double-counted
  //          the prompt's tokens. The new path:
  //            1. Find this bubble's index in the bubble list.
  //            2. Count user-text bubbles before it (== the 0-based
  //               ordinal the server uses to locate the prompt in on-disk
  //               history; matches POST .../rerun).
  //            3. Trim the bubble view to everything up to and including
  //               the clicked user bubble (so the user *keeps* their
  //               prompt on screen) and append an empty assistant bubble
  //               that the SSE handler will fill in token-by-token.
  //            4. Drive the shared stream runner against `rerunChat`.
  async function reRun(bubbleIdx: number) {
    if (busy) return;
    const bubble = bubbles[bubbleIdx];
    if (!bubble || bubble.kind !== "user") return;
    if (!conversationId) {
      // Without a server-side conversation there is no history to
      // truncate -- fall back to staging the text in the composer so the
      // user can hit Send. This only triggers if reRun is wired into a
      // transient, never-flushed bubble list.
      setInput(bubble.text);
      return;
    }

    // Count user-text bubbles strictly before `bubbleIdx`. Tool bubbles
    // do not have `kind: "user"`, so this naturally matches the server's
    // history walk (which skips system / assistant / tool messages).
    let userMessageIndex = 0;
    for (let i = 0; i < bubbleIdx; i++) {
      if (bubbles[i].kind === "user") userMessageIndex++;
    }

    setError(null);
    setBusy(true);
    // Keep the clicked prompt visible; drop everything after it (the
    // stale assistant reply, follow-up tool calls, later turns). Append
    // a fresh empty assistant bubble that the stream will hydrate.
    setBubbles((prev) => [
      ...prev.slice(0, bubbleIdx + 1),
      { kind: "assistant", text: "" },
    ]);

    await runChatStream((onEvent, signal) =>
      rerunChat(
        scope,
        conversationId,
        userMessageIndex,
        model || undefined,
        onEvent,
        signal,
        undefined,
        bubbleIdx,
      ),
    );
  }

  // ─── Edit a user prompt + re-stream (v0.16 §1) ────────────────────────────
  // Click ✏ Edit on a user bubble -> inline <textarea> swaps in. Hitting
  // Save commits the new text by piggy-backing on /rerun's truncate-then-
  // resend pipeline with overrideText set. Cancel just drops the editor.
  function beginEditBubble(bubbleIdx: number) {
    const bubble = bubbles[bubbleIdx];
    if (!bubble || bubble.kind !== "user") return;
    setEditingBubbleIdx(bubbleIdx);
    setEditDraft(bubble.text);
  }

  function cancelEditBubble() {
    setEditingBubbleIdx(null);
    setEditDraft("");
  }

  async function commitEditBubble() {
    if (editingBubbleIdx === null) return;
    const bubbleIdx = editingBubbleIdx;
    const newText = editDraft.trim();
    if (!newText) return; // empty edit = no-op; user should hit Cancel
    const bubble = bubbles[bubbleIdx];
    if (!bubble || bubble.kind !== "user") {
      cancelEditBubble();
      return;
    }
    if (!conversationId) {
      // No server conversation yet: just rewrite the local bubble. The user
      // would have to hit Send themselves, but this branch is unreachable
      // in normal use because the Edit button only renders after a turn
      // has streamed (which mints a conversationId).
      setBubbles((prev) => {
        const next = [...prev];
        next[bubbleIdx] = { kind: "user", text: newText };
        return next;
      });
      cancelEditBubble();
      return;
    }

    let userMessageIndex = 0;
    for (let i = 0; i < bubbleIdx; i++) {
      if (bubbles[i].kind === "user") userMessageIndex++;
    }

    setError(null);
    setBusy(true);
    cancelEditBubble();
    // Replace the clicked bubble's text optimistically + drop everything
    // after it. The server will push the new (override) prompt back into
    // history when session.send fires, so on-disk and on-screen agree.
    setBubbles((prev) => [
      ...prev.slice(0, bubbleIdx),
      { kind: "user", text: newText },
      { kind: "assistant", text: "" },
    ]);
    // Same annotation cleanup as deleteFromHere: bubbles >= bubbleIdx are
    // about to be replaced, so their old reactions/pins shouldn't carry
    // over.
    setAnnotations((prev) => {
      const next: Record<string, MessageAnnotation> = {};
      for (const [k, v] of Object.entries(prev.byBubbleIdx)) {
        if (Number(k) < bubbleIdx) next[k] = v;
      }
      return { version: 1, byBubbleIdx: next };
    });

    await runChatStream((onEvent, signal) =>
      rerunChat(
        scope,
        conversationId,
        userMessageIndex,
        model || undefined,
        onEvent,
        signal,
        newText,
        bubbleIdx,
      ),
    );
  }

  // ─── Delete from here (v0.16 §1) ────────────────────────────────────────────────
  // Drop a user bubble *and* every message that came after it (the stale
  // assistant reply, tool calls, later turns). Uses /truncate which writes
  // to disk synchronously — no SSE, no new turn.
  async function deleteFromHere(bubbleIdx: number) {
    if (busy) return;
    const bubble = bubbles[bubbleIdx];
    if (!bubble || bubble.kind !== "user") return;
    if (!conversationId) {
      // Local-only conversation: just trim the bubble list.
      setBubbles((prev) => prev.slice(0, bubbleIdx));
      return;
    }
    if (!confirm("Delete this message and every reply after it? This rewrites the conversation history.")) {
      return;
    }

    let userMessageIndex = 0;
    for (let i = 0; i < bubbleIdx; i++) {
      if (bubbles[i].kind === "user") userMessageIndex++;
    }

    setError(null);
    setBusy(true);
    try {
      await truncateChat(
        scope,
        conversationId,
        userMessageIndex,
        "include",
        undefined,
        bubbleIdx,
      );
      // Drop locally-cached annotations for the bubbles we just removed,
      // so reaction/pin/etc don't ghost forward if the next turn reuses
      // a now-vacant idx.
      setAnnotations((prev) => {
        const next: Record<string, MessageAnnotation> = {};
        for (const [k, v] of Object.entries(prev.byBubbleIdx)) {
          if (Number(k) < bubbleIdx) next[k] = v;
        }
        return { version: 1, byBubbleIdx: next };
      });
      // Optimistically prune the bubble list. Note we go *to* bubbleIdx,
      // not bubbleIdx+1, because the user message itself is being deleted.
      setBubbles((prev) => prev.slice(0, bubbleIdx));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      void refreshUsage();
      void refreshList();
    }
  }

  // ─── Reaction / Pin / Note / Reply handlers (v0.16 §2) ────────────────────────

  // Toggle an emoji reaction on a bubble. Optimistic flip locally + POST
  // to /react which is the server-side flip. We trust the server's
  // response shape as the source of truth in case of races.
  async function handleToggleReaction(bubbleIdx: number, emoji: string) {
    if (!conversationId) return;
    setPickerOpenFor(null);
    // Optimistic update: mutate the annotation map immediately so the UI
    // doesn't lag while the round trip happens.
    setAnnotations((prev) => {
      const next: Record<string, MessageAnnotation> = { ...prev.byBubbleIdx };
      const existing = { ...(next[String(bubbleIdx)] ?? {}) };
      const reactions = { ...(existing.reactions ?? {}) };
      if (reactions[emoji]) delete reactions[emoji];
      else reactions[emoji] = 1;
      if (Object.keys(reactions).length === 0) delete existing.reactions;
      else existing.reactions = reactions;
      if (Object.keys(existing).length === 0) delete next[String(bubbleIdx)];
      else next[String(bubbleIdx)] = existing;
      return { version: 1, byBubbleIdx: next };
    });
    try {
      const reactions = await toggleReaction(
        scope,
        conversationId,
        bubbleIdx,
        emoji,
      );
      // Reconcile with the server's view in case our optimistic flip
      // raced with another tab.
      setAnnotations((prev) => {
        const next = { ...prev.byBubbleIdx };
        const existing = { ...(next[String(bubbleIdx)] ?? {}) };
        if (Object.keys(reactions).length === 0) delete existing.reactions;
        else existing.reactions = reactions;
        if (Object.keys(existing).length === 0) delete next[String(bubbleIdx)];
        else next[String(bubbleIdx)] = existing;
        return { version: 1, byBubbleIdx: next };
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Pin / unpin a bubble. "Pin" here means "raise to a saved-messages
  // view" — it doesn't move the message in history.
  async function handleTogglePin(bubbleIdx: number) {
    if (!conversationId) return;
    const current = annotations.byBubbleIdx[String(bubbleIdx)] ?? {};
    const nextPinned = !current.pinned;
    // Optimistic
    setAnnotations((prev) => {
      const next = { ...prev.byBubbleIdx };
      const existing = { ...(next[String(bubbleIdx)] ?? {}) };
      if (nextPinned) existing.pinned = true;
      else delete existing.pinned;
      if (Object.keys(existing).length === 0) delete next[String(bubbleIdx)];
      else next[String(bubbleIdx)] = existing;
      return { version: 1, byBubbleIdx: next };
    });
    try {
      await patchAnnotation(scope, conversationId, bubbleIdx, {
        pinned: nextPinned ? true : null,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function beginNote(bubbleIdx: number) {
    setNoteEditingIdx(bubbleIdx);
    setNoteDraft(
      annotations.byBubbleIdx[String(bubbleIdx)]?.note ?? "",
    );
  }

  function cancelNote() {
    setNoteEditingIdx(null);
    setNoteDraft("");
  }

  async function commitNote() {
    if (noteEditingIdx === null || !conversationId) return;
    const bubbleIdx = noteEditingIdx;
    const text = noteDraft.trim();
    cancelNote();
    // Optimistic
    setAnnotations((prev) => {
      const next = { ...prev.byBubbleIdx };
      const existing = { ...(next[String(bubbleIdx)] ?? {}) };
      if (text) existing.note = text;
      else delete existing.note;
      if (Object.keys(existing).length === 0) delete next[String(bubbleIdx)];
      else next[String(bubbleIdx)] = existing;
      return { version: 1, byBubbleIdx: next };
    });
    try {
      await patchAnnotation(scope, conversationId, bubbleIdx, {
        note: text || null,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Start a reply: set the target so the next composer send picks it up.
  // The actual quote prepend happens in `send`.
  function beginReply(bubbleIdx: number) {
    const bubble = bubbles[bubbleIdx];
    if (!bubble) return;
    const text =
      bubble.kind === "user" || bubble.kind === "assistant" ? bubble.text : "";
    const snippet = text.slice(0, 120) + (text.length > 120 ? "…" : "");
    setReplyTarget({ bubbleIdx, snippet });
  }

  function clearReply() {
    setReplyTarget(null);
  }

  // Jump-to-message: scrolls to the bubble and briefly highlights it.
  // Used both by the pinned-only drawer and by reply preview links.
  function jumpToBubble(bubbleIdx: number) {
    const el = document.querySelector<HTMLElement>(
      `[data-bubble-idx="${bubbleIdx}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-amber-400");
    setTimeout(() => el.classList.remove("ring-2", "ring-amber-400"), 1500);
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
            list="mathran-model-suggestions"
            className="w-64 rounded-md border border-slate-300 px-2 py-1 text-xs font-mono outline-none focus:border-slate-500"
          />
          <datalist id="mathran-model-suggestions">
            {/* Common model strings the LLM router accepts. Free-form input
                remains allowed — this is a datalist (suggestions), not a
                <select> (exhaustive). v0.14 §3. */}
            <option value="copilot/gpt-5.5" />
            <option value="copilot/gpt-5.6" />
            <option value="copilot/claude-opus-4.7" />
            <option value="copilot/claude-opus-4.8" />
            <option value="copilot/claude-sonnet-4.5" />
            <option value="copilot/o1" />
            <option value="copilot/o1-mini" />
            <option value="copilot/o3-mini" />
          </datalist>
          {/* ─── Pinned-only toggle (v0.16 §2) ────────────────────────
              Compact button in the chat header; flips the rows filter
              below to render only pinned bubbles. Useful for jumping
              back to saved fragments without scrolling. Hidden when
              there's nothing pinned. */}
          {(() => {
            const pinnedCount = Object.values(annotations.byBubbleIdx).filter(
              (a) => a.pinned,
            ).length;
            if (pinnedCount === 0 && !showPinnedOnly) return null;
            return (
              <button
                type="button"
                onClick={() => setShowPinnedOnly((v) => !v)}
                className={`ml-2 shrink-0 rounded-md border px-2 py-1 text-xs ${
                  showPinnedOnly
                    ? "border-amber-400 bg-amber-100 text-amber-900"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
                title={
                  showPinnedOnly
                    ? "Show all messages"
                    : `Filter to pinned messages (${pinnedCount})`
                }
              >
                📌 {showPinnedOnly ? "All" : `Pinned (${pinnedCount})`}
              </button>
            );
          })()}
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
          {rows.map((row, i) =>
            row.kind === "tools" ? (
              <ToolCallGroup key={`g${i}`} tools={row.tools} />
            ) : (
              <div
                key={i}
                data-bubble-idx={row.bubbleIdx}
                className={`group/msg flex ${row.bubble.kind === "user" ? "justify-end" : "justify-start"} rounded-md transition`}
              >
                <div className="flex max-w-2xl flex-col">
                  {/* ─── Reply-target badge (v0.16 §2) ───────────────────────
                      Shows above a user bubble when it's a reply to an
                      earlier message. Click jumps to the referenced bubble. */}
                  {(() => {
                    const ann = annotations.byBubbleIdx[String(row.bubbleIdx)];
                    if (!ann?.replyTo) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => jumpToBubble(ann.replyTo!.bubbleIdx)}
                        className="mb-0.5 self-end max-w-[28rem] truncate rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-0.5 text-left text-[10px] text-slate-600 hover:bg-amber-100"
                        title="Jump to the message this was replying to"
                      >
                        ↩ replying to: <span className="text-slate-500">{ann.replyTo.snippet}</span>
                      </button>
                    );
                  })()}

                  {editingBubbleIdx === row.bubbleIdx && row.bubble.kind === "user" ? (
                    // ─── Inline editor (v0.16 §1) ────────────────────────
                    <div className="w-[36rem] max-w-[80vw] rounded-lg border border-slate-300 bg-white p-2">
                      <textarea
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEditBubble();
                          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void commitEditBubble();
                          }
                        }}
                        rows={Math.min(12, Math.max(2, editDraft.split("\n").length))}
                        className="w-full resize-y rounded border border-slate-200 p-2 text-sm text-slate-900 outline-none focus:border-slate-500"
                      />
                      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                        <span>⌘/Ctrl + Enter to save · Esc to cancel</span>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={cancelEditBubble}
                            className="rounded px-2 py-0.5 hover:bg-slate-100"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={!editDraft.trim() || busy}
                            onClick={() => void commitEditBubble()}
                            className="rounded bg-slate-900 px-2 py-0.5 text-white disabled:opacity-50"
                          >
                            Save & Re-run
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`relative rounded-lg px-4 py-2 text-sm ${
                        row.bubble.kind === "user"
                          ? "bg-slate-900 text-white"
                          : "border border-slate-200 bg-white"
                      } ${
                        annotations.byBubbleIdx[String(row.bubbleIdx)]?.pinned
                          ? "ring-1 ring-amber-400"
                          : ""
                      }`}
                    >
                      {/* Pin indicator nipple in the upper corner. */}
                      {annotations.byBubbleIdx[String(row.bubbleIdx)]?.pinned && (
                        <span
                          className="absolute -top-1 -right-1 rounded-full bg-amber-400 px-1 py-px text-[9px] text-amber-900"
                          title="Pinned"
                        >
                          📌
                        </span>
                      )}
                      {row.bubble.kind === "assistant" ? (
                        <div
                          className="md"
                          dangerouslySetInnerHTML={{
                            __html: marked.parse(row.bubble.text || "…") as string,
                          }}
                        />
                      ) : (
                        <span className="whitespace-pre-wrap">{row.bubble.text}</span>
                      )}
                    </div>
                  )}

                  {/* ─── Reactions strip (v0.16 §2) ───────────────────────────
                      One pill per emoji with current count. Click to toggle. */}
                  {(() => {
                    const reactions =
                      annotations.byBubbleIdx[String(row.bubbleIdx)]?.reactions;
                    if (!reactions || Object.keys(reactions).length === 0) return null;
                    return (
                      <div
                        className={`mt-0.5 flex gap-1 ${
                          row.bubble.kind === "user" ? "justify-end" : "justify-start"
                        }`}
                      >
                        {Object.entries(reactions).map(([emoji, count]) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => void handleToggleReaction(row.bubbleIdx, emoji)}
                            className="rounded-full border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-[11px] hover:bg-slate-100"
                            title="Click to remove your reaction"
                          >
                            <span>{emoji}</span>
                            {count > 1 && <span className="ml-0.5 text-slate-500">{count}</span>}
                          </button>
                        ))}
                      </div>
                    );
                  })()}

                  {/* ─── Inline note (v0.16 §2) ─────────────────────────────────
                      Private user-attached note. Editing in-place when
                      noteEditingIdx matches; otherwise renders the saved
                      note text (if any). */}
                  {noteEditingIdx === row.bubbleIdx ? (
                    <div
                      className={`mt-1 flex flex-col gap-1 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] ${
                        row.bubble.kind === "user" ? "self-end" : "self-start"
                      } w-[28rem] max-w-[80vw]`}
                    >
                      <textarea
                        autoFocus
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") cancelNote();
                          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commitNote();
                        }}
                        rows={Math.min(6, Math.max(2, noteDraft.split("\n").length))}
                        placeholder="Private note (not sent to LLM)…"
                        className="w-full resize-y rounded border border-amber-300 bg-white p-1 text-slate-900 outline-none focus:border-amber-500"
                      />
                      <div className="flex justify-between text-[10px] text-slate-500">
                        <span>⌘/Ctrl + Enter to save · Esc to cancel</span>
                        <div className="flex gap-1">
                          <button type="button" onClick={cancelNote} className="rounded px-2 py-0.5 hover:bg-amber-100">
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void commitNote()}
                            className="rounded bg-amber-500 px-2 py-0.5 text-white"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    (() => {
                      const note = annotations.byBubbleIdx[String(row.bubbleIdx)]?.note;
                      if (!note) return null;
                      return (
                        <button
                          type="button"
                          onClick={() => beginNote(row.bubbleIdx)}
                          className={`mt-1 max-w-[28rem] whitespace-pre-wrap rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-left text-[11px] text-slate-700 hover:bg-amber-100 ${
                            row.bubble.kind === "user" ? "self-end" : "self-start"
                          }`}
                          title="Click to edit this private note"
                        >
                          📝 {note}
                        </button>
                      );
                    })()
                  )}

                  {/* ─── Per-message action bar (v0.16 §2 expansion) ──────────────
                      Hidden during inline edit and during in-flight streams
                      to avoid racing setBubbles against the SSE pump. */}
                  {editingBubbleIdx !== row.bubbleIdx && noteEditingIdx !== row.bubbleIdx && (
                    <div className="mt-0.5 flex justify-end gap-1 text-[10px] text-slate-400 opacity-0 transition group-hover/msg:opacity-100">
                      {/* React picker: tiny inline emoji row, no library. */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() =>
                            setPickerOpenFor(
                              pickerOpenFor === row.bubbleIdx ? null : row.bubbleIdx,
                            )
                          }
                          className="rounded px-1 py-0.5 hover:bg-slate-200"
                          title="Add a reaction"
                        >
                          😊 React
                        </button>
                        {pickerOpenFor === row.bubbleIdx && (
                          <div className="absolute right-0 bottom-full z-10 mb-1 flex gap-0.5 rounded-md border border-slate-200 bg-white p-1 shadow-md">
                            {["👍", "❤️", "😂", "🔥", "🤔", "✅", "❌", "🧠", "⚠️", "💫"].map((emoji) => (
                              <button
                                key={emoji}
                                type="button"
                                onClick={() => void handleToggleReaction(row.bubbleIdx, emoji)}
                                className="rounded px-1 text-base hover:bg-slate-100"
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleTogglePin(row.bubbleIdx)}
                        className="rounded px-1 py-0.5 hover:bg-slate-200"
                        title="Pin/unpin this message"
                      >
                        {annotations.byBubbleIdx[String(row.bubbleIdx)]?.pinned ? "📌 Unpin" : "📌 Pin"}
                      </button>
                      <button
                        type="button"
                        onClick={() => beginNote(row.bubbleIdx)}
                        className="rounded px-1 py-0.5 hover:bg-slate-200"
                        title="Attach a private note (not sent to LLM)"
                      >
                        📝 Note
                      </button>
                      <button
                        type="button"
                        onClick={() => beginReply(row.bubbleIdx)}
                        className="rounded px-1 py-0.5 hover:bg-slate-200"
                        title="Reply to this message: the next prompt will quote it"
                      >
                        ↩ Reply
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyOneMessage(row.bubble.text)}
                        className="rounded px-1 py-0.5 hover:bg-slate-200"
                        title="Copy this message to clipboard"
                      >
                        📋 Copy
                      </button>
                      {row.bubble.kind === "user" && !busy && (
                        <>
                          <button
                            type="button"
                            onClick={() => void reRun(row.bubbleIdx)}
                            className="rounded px-1 py-0.5 hover:bg-slate-200"
                            title="Re-run this prompt: truncate history here and stream a fresh assistant reply"
                          >
                            🔁 Re-run
                          </button>
                          <button
                            type="button"
                            onClick={() => beginEditBubble(row.bubbleIdx)}
                            className="rounded px-1 py-0.5 hover:bg-slate-200"
                            title="Edit this prompt and re-run with the new text"
                          >
                            ✏ Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteFromHere(row.bubbleIdx)}
                            className="rounded px-1 py-0.5 text-red-500 hover:bg-red-50"
                            title="Delete this message and everything after it"
                          >
                            🗑 Delete from here
                          </button>
                        </>
                      )}
                    </div>
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

        {/* ─── Reply preview banner (v0.16 §2) ─────────────────────────
            Sits just above the composer when the user has clicked Reply
            on a bubble. Click × to cancel, click the snippet to jump to
            the referenced message. */}
        {replyTarget && (
          <div className="mx-4 mb-2 flex items-start gap-2 rounded border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-xs">
            <button
              type="button"
              onClick={() => jumpToBubble(replyTarget.bubbleIdx)}
              className="flex-1 truncate text-left text-slate-700 hover:underline"
              title="Jump to the message you're replying to"
            >
              <span className="font-medium text-amber-700">↩ Replying to:</span>{" "}
              <span>{replyTarget.snippet}</span>
            </button>
            <button
              type="button"
              onClick={clearReply}
              className="shrink-0 rounded px-1 py-0.5 text-slate-500 hover:bg-amber-100"
              title="Cancel reply"
            >
              ×
            </button>
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
          {busy ? (
            // Stop swaps in for Send while a stream is open. Calling stop()
            // .abort()s the underlying fetch so the SSE pump tears down and
            // runChatStream's finally block flips `busy` back to false.
            <button
              type="button"
              onClick={stop}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              title="Stop generating"
            >
              ⏹ Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
