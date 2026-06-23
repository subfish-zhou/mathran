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
import { useNavigate, useSearchParams } from "react-router-dom";
import { marked } from "marked";
// v0.17 follow-up: KaTeX + LLM-math-delimiter preprocess registration
// has moved to `lib/markdown.ts` which is imported once from `main.tsx`.
// This component no longer needs to register it (was a duplicate /
// load-ordering trap).
import {
  streamChat,
  rerunChat,
  truncateChat,
  streamAnswerAsk,
  fetchAnnotations,
  fetchTodos,
  patchAnnotation,
  patchUiState,
  toggleReaction,
  findGoalForConversation,
  runGoalRound,
  steerChatConversation,
  type ChatEvent,
  type ChatAttachmentRef,
  type ConversationAnnotations,
  type MessageAnnotation,
  type GoalRow,
  type TodoList,
} from "../lib/chat.ts";
import GoalControls from "./GoalControls.tsx";
import {
  AUTO_RUN_TICK_MS,
  autoRunCountdownSeconds,
  shouldAutoRunNextRound,
} from "../lib/goal-auto-run.ts";
import GoalRunStatusPanel from "./GoalRunStatusPanel.tsx";
import GoalAutonomyCard from "./GoalAutonomyCard.tsx";
import { TodoListPanel } from "./TodoListPanel.tsx";
import PlanRunOverlay from "./PlanRunOverlay.tsx";
import ApprovalDialog from "./ApprovalDialog.tsx";
import {
  postApprovalDecision,
  type ApprovalRequest,
  type ApprovalDecision,
} from "../lib/approval-client.ts";
import { AgentStatusPanel, type ChatEventPhase } from "./AgentStatusPanel.tsx";
import { api, chatScopeBase, type ChatScopeSpec, type ConversationSummary, type UsageStats } from "../lib/api.ts";
import {
  historyToBubbles,
  type Bubble,
  type ToolBubble,
} from "../lib/history-to-bubbles.ts";
import { shouldRenderAskPending } from "../lib/ask-pending-guard.ts";
import {
  buildConversationLatex,
  buildConversationMarkdown,
  copyToClipboard,
  downloadMarkdown,
  downloadText,
  type ExportTimelineItem,
} from "../lib/chat-export.ts";
import UsageSparkline from "./UsageSparkline.tsx";
import ContextMeter from "./ContextMeter.tsx";
import ToolCallGroup from "./ToolCallGroup.tsx";
import { ThreadDrawer } from "./ThreadDrawer.tsx";
import { SubagentTreePanel } from "./SubagentTreePanel.tsx";
import { BackgroundAgentsPanel } from "./BackgroundAgentsPanel.tsx";
import type { SubagentCompletedFrame } from "../lib/subagents.ts";
import SlashSuggester from "./SlashSuggester.tsx";
import {
  parseSlashInput,
  activeSlashPrefix,
  buildSuggesterItems,
  filterCommands,
  moveSelection,
  fetchSlashCommands,
  fetchSkills,
  fetchActiveAgents,
  postChatSlash,
  parseCdTarget,
  buildCustomPromptFromItem,
  REVIEW_FALLBACK_PROMPT,
  type SuggesterItem,
} from "../lib/slash-commands.ts";

/**
 * Build the `GET /api/uploads/<encoded-path>` URL for a persisted
 * attachment ref (v0.17 mathub parity). The on-disk `path` is absolute
 * (workspace-internal), so we encodeURIComponent the whole thing and let
 * the server re-validate the prefix. Used for both `<img src>` and `<a
 * href>` chip targets, so a single helper keeps the wire contract in one
 * place.
 */
function uploadsUrlFor(ref: ChatAttachmentRef): string {
  return `/api/uploads/${encodeURIComponent(ref.path)}`;
}

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
  // v0.17 mathub parity W9 — Live Steering. `steerToast` holds the most
  // recently queued steer text while the SPA waits for the server's
  // `steer-received` SSE frame; it clears on receipt. `steerLastReceived`
  // is a one-shot badge text the next round bubble renders to show what
  // the user steered with (mirrors mathub's "📣 Steered: …" hint).
  const [steerToast, setSteerToast] = useState<string | null>(null);
  const [steerLastReceived, setSteerLastReceived] = useState<string | null>(null);
  // The composer doubles as the steer textarea: while `busy`, the
  // Send button is replaced by Stop + Steer, and submitting via
  // Steer sends the current `input` as a steer instead of a new turn.
  // v0.16 §4: bump to force the conversation-load effect to re-run when the
  // id didn't change but the underlying history did (e.g. after a goal
  // round on the *same* conversation).
  const [reloadTick, setReloadTick] = useState(0);
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  // v0.16 §8: rolling token-usage history for an inline sparkline. Each
  // entry is a snapshot of `tokens` recorded after a successful refresh.
  // Capped at 50 points; reset on conversation switch (it's a glance
  // metric, not load-bearing data, so no need to persist).
  const [usageHistory, setUsageHistory] = useState<number[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Abort controller for the in-flight chat stream. `send` / `reRun` set it
  // before kicking off pumpSSE; the Stop button calls `.abort()` to interrupt.
  // Cleared in `runChatStream`'s finally block so the next turn starts fresh.
  const abortRef = useRef<AbortController | null>(null);

  // ─── AgentStatusPanel state (v0.17 mathub parity W7) ─────────────────
  //
  // We mirror the SSE event tape into a compact set of presentational
  // signals so the panel can render a `🧠 thinking / 🔧 calling tool / 🔄
  // Step N/M / ⏱ Xs` strip without re-walking the bubble array on every
  // tick. All four states reset to their idle values in `runChatStream`'s
  // `finally` block, alongside `setBusy(false)`, so the panel disappears
  // the moment the stream ends — no stale `⏱ 12s` left dangling.
  const [latestEventType, setLatestEventType] = useState<ChatEventPhase>(null);
  // Active tool calls: `tool-call` id -> name. We need a map (not a
  // plain count) because tool-result events come back keyed by id and
  // we have to remove the right entry, not the most-recent one.
  const [activeToolCalls, setActiveToolCalls] = useState<Record<string, string>>({});
  // True while at least one of the in-flight tool calls is a sub-agent
  // dispatch. The renderer flips the phase pill to `🌿 Sub-agent
  // running` to make it obvious the parent agent isn't stuck.
  const [subAgentActive, setSubAgentActive] = useState(false);
  // Unix ms when the current stream began (set in `runChatStream`'s
  // controller setup, cleared on stream end). Drives `⏱ elapsed`.
  const sendStartMsRef = useRef<number>(0);
  const [sendStartMs, setSendStartMs] = useState<number>(0);
  // Goal-mode round counter, fed from the `round-start` SSE event.
  // `null` for plain chat (which never emits round-start) so the
  // panel hides its `Step N/M` segment.
  const [round, setRound] = useState<{ current: number; max?: number } | null>(null);
  // Tick state for the 1Hz elapsed-time refresh while `busy` is true.
  // Without this React would only re-render when an SSE event arrives,
  // so a slow tool call would freeze the `⏱ Xs` counter visually.
  const [statusTick, setStatusTick] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setStatusTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);
  // Reading `statusTick` here keeps it from being a dead state — React
  // strips unused setters in production builds but the read makes the
  // dependency intent explicit for any future eslint sweep.
  void statusTick;

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
  // Picker removed in v0.16 §4: reactions simplified to 👍/👎, the
  // hover bar now toggles directly without a popup.
  // Inline note editor target. Same idea as editingBubbleIdx but for the
  // per-message margin note instead of the prompt text itself.
  const [noteEditingIdx, setNoteEditingIdx] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // Whether the pinned-only filter sidebar drawer is open.
  const [showPinnedOnly, setShowPinnedOnly] = useState(false);
  // v0.16 §6: in-conversation search. Empty string = inactive (no filter,
  // no highlight). When set, bubble matches are highlighted via a wrap
  // <mark> at render time and the pinned-only filter is bypassed (the user
  // wants to find a thing, not also be filtered).
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  // v0.16 §7: long-conversation compaction. When a conversation grows
  // past COMPACT_THRESHOLD bubbles we collapse the early prefix into a
  // single "📜 N earlier turns" strip; clicking it sets this to true
  // and the prefix renders inline. Reset on conversation switch so we
  // don't bleed state across tabs.
  const [compactionExpanded, setCompactionExpanded] = useState(false);
  // ─── Thread / goal-mode state (v0.16 §3) ───────────────────────────
  // owningGoal is non-null when this conversation is the primary one of a
  // Goal. spawn_sub_goal tool-calls inside it become clickable thread
  // anchors that open ThreadDrawer. threadStack is a navigation history
  // (parent→child→grandchild) for the drawer's Back button; top is what's
  // currently shown.
  const [owningGoal, setOwningGoal] = useState<GoalRow | null>(null);
  const [threadStack, setThreadStack] = useState<string[]>([]);
  // W10 (v0.17 mathub parity): SubagentTreePanel collapse state.
  // Default-collapsed so the goal-control row stays compact; users opt
  // in by clicking the "🌳 Sub-agent tree (N)" button when they want
  // the bird's-eye view across the whole forest.
  const [subagentTreeOpen, setSubagentTreeOpen] = useState(false);
  // #3 Background Agents — latest `subagent-completed` SSE frame, fed to the
  // BackgroundAgentsPanel so a finishing detached run flips to its terminal
  // colour ahead of the panel's next poll.
  const [bgCompletedFrame, setBgCompletedFrame] =
    useState<SubagentCompletedFrame | null>(null);
  // goal-defaults-timer (commit 6/7): auto-run state.
  //   * lastKeystrokeTsRef avoids a re-render storm on every keystroke.
  //     The 1Hz countdown ticker (autoRunNowMs) re-renders cheaply
  //     enough that we don't need the keystroke timestamp itself to
  //     be a useState.
  //   * nextAutoRunAt is the wall-clock unix-ms the timer expects to
  //     fire next; reset every time the timer (re)installs.
  //   * autoRunNowMs is bumped 1×/sec so the badge counts down
  //     smoothly even while the goal is otherwise idle.
  const lastKeystrokeTsRef = useRef<number>(0);
  const [nextAutoRunAt, setNextAutoRunAt] = useState<number>(0);
  const [autoRunNowMs, setAutoRunNowMs] = useState<number>(() => Date.now());
  // Auto-run driver. Only installs while we're in a goal-mode chat
  // that's currently in "active" status — paused / terminal goals
  // (complete / failed / cancelled / exhausted) tear it down via the
  // effect's cleanup. The interval CALLBACK still consults the gate
  // (shouldAutoRunNextRound) on every tick, so a transient busy / the
  // user typing simply skips a tick without restarting the interval.
  //
  // We deliberately do NOT include `busy` or `input.length` in the
  // deps array: doing so would tear down and re-install the timer on
  // every keystroke, which would (a) reset the cadence (b) thrash
  // setNextAutoRunAt on every render. Keeping the deps narrow means
  // the same 120s rhythm persists; only goal-status changes (which
  // are rare — once per round at most) re-anchor it.
  useEffect(() => {
    if (!owningGoal || owningGoal.status !== "active") {
      setNextAutoRunAt(0);
      return;
    }
    let cancelled = false;
    setNextAutoRunAt(Date.now() + AUTO_RUN_TICK_MS);
    const id = setInterval(() => {
      if (cancelled) return;
      // Read live values via closure — these refs/state are mutated
      // outside this effect's dep array, which is exactly why we need
      // a fresh read on every tick instead of stale captures.
      const fire = shouldAutoRunNextRound({
        owningGoal,
        busy,
        unsentTextLength: input.trim().length,
        lastKeystrokeTs: lastKeystrokeTsRef.current,
        now: Date.now(),
      });
      setNextAutoRunAt(Date.now() + AUTO_RUN_TICK_MS);
      if (!fire) return;
      // Fire-and-forget; the onRoundRan-equivalent handling matches
      // the manual "Next round" button below: refresh owningGoal +
      // pull in the new history.
      runGoalRound(owningGoal.id)
        .then((r) => {
          if (cancelled) return;
          setOwningGoal(r.goal);
          if (r.goal.conversationIds[0]) {
            if (r.goal.conversationIds[0] !== conversationId) {
              setConversationId(r.goal.conversationIds[0]);
            } else {
              setReloadTick((t) => t + 1);
            }
          }
        })
        .catch((e) => {
          if (cancelled) return;
          setError(String((e as Error).message ?? e));
        });
    }, AUTO_RUN_TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      setNextAutoRunAt(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owningGoal?.id, owningGoal?.status]);
  // 1Hz refresh just for the auto-run countdown badge. Skipped when
  // there's no countdown to display (saves an idle interval on plain
  // chat). Coalesces with the existing busy-status ticker visually
  // (both 1Hz) but lives separately because the gates are different.
  useEffect(() => {
    if (!nextAutoRunAt) return;
    const id = setInterval(() => setAutoRunNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nextAutoRunAt]);
  // v0.17 mathub parity W12: in-conversation TODO tracker maintained by
  // the `todo_write` built-in tool. Seeded by `fetchTodos` whenever the
  // active conversation changes, then live-updated by `todos` SSE frames
  // synthesised in the host layer after every successful tool call.
  // We keep collapsed state in a separate slot so it survives state
  // churn within one conversation but resets on conversation switch.
  const [todos, setTodos] = useState<TodoList | null>(null);
  const [todosCollapsed, setTodosCollapsed] = useState(false);
  // v0.17 P2 — the most-recent propose_goal confirmation. Cleared by
  // user dismiss (X button) or by a scope/conversation reset. When
  // `autoRun=true` the banner also triggers a 800-ms-delayed page
  // navigate (handled in the goal-proposed event branch below).
  const [goalProposed, setGoalProposed] = useState<null | {
    goalId: string;
    objective: string;
    maxRounds: number;
    tokensCap: number | null;
    autoRun: boolean;
  }>(null);
  // v0.17 P2 sibling — propose_plan banner state.
  const [planProposed, setPlanProposed] = useState<null | {
    planId: string;
    objective: string;
    autoRun: boolean;
  }>(null);
  // v0.16 §9 audit #2: plan-mode overlay state. Lives outside the chat
  // bubble stream so a plan run never pollutes conversation history; only
  // a transient "Plan saved to <path>" toast surfaces back here.
  const [planOverlayOpen, setPlanOverlayOpen] = useState(false);
  // Approval Policy 矩阵 — the in-flight tool approval prompt (if any), driven
  // by `approval_request` / `approval_resolved` SSE events. `approvalSubmitting`
  // guards the buttons while the decision POST is in flight; `approvalError`
  // surfaces a failed POST inline so the user can retry without losing the modal.
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(
    null,
  );
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [planSavedToast, setPlanSavedToast] = useState<string | null>(null);
  // outcomes 收尾 C-2 — transient toast surfaced when a background self-grade
  // round lands a `goal-graded` SSE frame ("📊 Goal graded: X/5").
  const [goalGradedToast, setGoalGradedToast] = useState<string | null>(null);
  // #3 — transient toast when a background subagent finishes.
  const [bgSubagentToast, setBgSubagentToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // W4 (v0.17 mathub parity): composer is a multi-line <textarea> that
  // auto-grows from 1 to 8 rows. We keep a ref so the IME composition
  // guard can read .isComposing without prop drilling, and so we can
  // call form.requestSubmit() for the Enter-to-send shortcut (which
  // routes through the normal <form onSubmit={send}> path, preserving
  // disabled-while-busy + reply/quote semantics for free).
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // IME guard: while a composition is active (e.g. typing Chinese,
  // Japanese, Korean) Enter should commit the candidate, not submit
  // the form. Browsers also dispatch a final Enter keydown after
  // compositionend whose `isComposing` is false but `keyCode === 229`,
  // which we filter below in the keydown handler.
  const isComposingRef = useRef(false);

  // ─── Composer attachments (v0.17 mathub parity W2) ─────────────────
  // Each PendingAttachment tracks one file from picker / drag-drop / paste.
  // Status flows uploading → ready → (optionally) error. Ready entries
  // carry the server-returned `path`/`mimeType`/`size`; we forward those
  // three fields verbatim to `streamChat` on send.
  //
  // Why a uuid-ish `id` per entry? React keys + the ✖-remove handler
  // need a stable identity even before the upload resolves a path. We
  // also don't trust filename to be unique (user can drop two `notes.txt`).
  type PendingAttachment =
    | { id: string; status: "uploading"; filename: string }
    | {
        id: string;
        status: "ready";
        filename: string;
        path: string;
        mimeType: string;
        size: number;
      }
    | { id: string; status: "error"; filename: string; error: string };
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // ─── Slash commands (SPA Slash Commands task) ──────────────────────────
  // Full builtin+custom suggester list, fetched once on mount (best-effort).
  const [slashItems, setSlashItems] = useState<SuggesterItem[]>([]);
  // Highlighted row index within the *filtered* suggester list.
  const [slashSelected, setSlashSelected] = useState(0);
  const navigate = useNavigate();
  // Lightbox state for clicking an image chip in a user bubble. Holds the
  // attachment ref we're previewing; null = closed. Escape / backdrop
  // click clears it. Decoupled from the chip render so any image chip,
  // from any bubble, can drive the same modal.
  const [lightbox, setLightbox] = useState<ChatAttachmentRef | null>(null);
  // Hidden <input type="file"> the 📎 button triggers. Kept off-screen so
  // we can style the button freely.
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Stable id minter for PendingAttachment.id. crypto.randomUUID is
  // available in every browser the SPA targets (no IE fallback).
  const nextAttachId = useCallback(() => {
    try {
      return crypto.randomUUID();
    } catch {
      return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
  }, []);

  /**
   * Kick off uploads for a batch of `File`s and track each one's lifecycle
   * in `attachments` state. Per file:
   *   1. Insert a `uploading` chip right away (the user sees it on screen
   *      before the network round-trip starts).
   *   2. POST to `/api/uploads` with the file as the `file` field.
   *   3. On 2xx: flip the chip to `ready` carrying `path/mimeType/size`.
   *   4. On non-2xx or network error: flip to `error` with a short reason.
   *
   * Errors don't bubble — the chip turns red and the rest of the batch
   * keeps going. The user can ✖ a failed chip to retry by re-attaching.
   */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const entries = files.map((f) => ({ id: nextAttachId(), file: f }));
      setAttachments((prev) => [
        ...prev,
        ...entries.map(
          (e): PendingAttachment => ({
            id: e.id,
            status: "uploading",
            filename: e.file.name,
          }),
        ),
      ]);
      await Promise.all(
        entries.map(async ({ id, file }) => {
          const form = new FormData();
          form.set("file", file, file.name);
          try {
            const res = await fetch("/api/uploads", { method: "POST", body: form });
            if (!res.ok) {
              let msg = `upload failed (${res.status})`;
              try {
                const data = await res.json();
                if (data?.error) msg = String(data.error);
              } catch { /* ignore */ }
              setAttachments((prev) =>
                prev.map((a) =>
                  a.id === id
                    ? { id, status: "error", filename: file.name, error: msg }
                    : a,
                ),
              );
              return;
            }
            const data = (await res.json()) as {
              path: string;
              filename: string;
              mimeType: string;
              size: number;
            };
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === id
                  ? {
                      id,
                      status: "ready",
                      // Use the server-sanitised filename so the chip and
                      // the server-side rendering agree.
                      filename: data.filename,
                      path: data.path,
                      mimeType: data.mimeType,
                      size: data.size,
                    }
                  : a,
              ),
            );
          } catch (err: unknown) {
            setAttachments((prev) =>
              prev.map((a) =>
                a.id === id
                  ? {
                      id,
                      status: "error",
                      filename: file.name,
                      error: (err as Error)?.message ?? "network error",
                    }
                  : a,
              ),
            );
          }
        }),
      );
    },
    [nextAttachId],
  );

  /** Remove a single chip (✖ button or successful send). */
  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /** Are we still waiting on any uploads? Used to disable Send. */
  const hasUploadingAttachment = attachments.some((a) => a.status === "uploading");

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
    setUsageHistory([]);
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
      setUsageHistory([]);
      setAnnotations({ version: 1, byBubbleIdx: {} });
      setReplyTarget(null);
      setOwningGoal(null);
      setThreadStack([]);
      // v0.17 mathub parity W12 — clear TODO list when no conversation
      // is selected so the panel doesn't show stale items from a prior
      // selection while the sidebar loads.
      setTodos(null);
      setTodosCollapsed(false);
      // v0.17 P2 — scope/conversation reset also clears the banner.
      setGoalProposed(null);
      setPlanProposed(null);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    // Parallel load: history + annotations + owning-goal lookup.
    // Annotation failures are non-fatal (the SPA renders without them).
    // Goal lookup 404s on plain (non-goal) chats — we treat that as
    // "no thread anchors needed" and degrade silently.
    Promise.all([
      api.getChatHistory(scope, conversationId),
      fetchAnnotations(scope, conversationId).catch<ConversationAnnotations>(() => ({
        version: 1 as const,
        byBubbleIdx: {} as Record<string, MessageAnnotation>,
      })),
      findGoalForConversation(conversationId).catch(() => null),
      // v0.17 W12: seed the TODO panel before any stream runs. Empty
      // list on first-ever load is normal; failures are non-fatal.
      fetchTodos(scope, conversationId).catch<TodoList | null>(() => null),
    ])
      .then(([data, ann, goalLookup, todoList]) => {
        if (cancelled) return;
        // v0.16 §11: if the conversation paused on an `ask_user`, the
        // sidecar carries the pending question keyed by tool-call id.
        // Re-stamp `askPending` onto the matching tool bubble so the
        // inline answer UI renders on reload (the original SSE event
        // was consumed by a since-closed stream).
        const initialBubbles = historyToBubbles(data.history);
        const pending = ann.pendingAsk;
        // v0.17 W14 fix: goal-mode rounds auto-resolve `ask_user` (see
        // src/core/goal/runner.ts builtinTools.ask_user), so the server
        // will never have pending state to satisfy a /answer-ask POST.
        // Guard against re-stamping a stale sidecar slot left over from a
        // pre-goal chat round to avoid the "no pending ask_user" toast.
        const owningGoalFromLookup = !!(goalLookup && goalLookup.goal);
        if (
          shouldRenderAskPending({ pending, owningGoal: owningGoalFromLookup })
        ) {
          for (let i = 0; i < initialBubbles.length; i++) {
            const b = initialBubbles[i];
            if (b.kind === "tool" && b.id === pending!.callId) {
              // v0.19 Codex parity — forward every structured field the
              // sidecar carries so a tab reload after the SSE stream
              // closed still renders the button list / countdown /
              // default hint, not just the bare question.
              const askPending: NonNullable<ToolBubble["askPending"]> = {
                question: pending!.question,
              };
              if (pending!.options !== undefined) askPending.options = pending!.options;
              if (pending!.default !== undefined) askPending.default = pending!.default;
              if (pending!.timeoutSeconds !== undefined) {
                askPending.timeoutSeconds = pending!.timeoutSeconds;
              }
              if (pending!.allowCustom !== undefined) {
                askPending.allowCustom = pending!.allowCustom;
              }
              if (pending!.timeoutAt !== undefined) {
                askPending.timeoutAt = pending!.timeoutAt;
              }
              initialBubbles[i] = { ...b, askPending };
              break;
            }
          }
        }
        setBubbles(initialBubbles);
        setAnnotations(ann);
        setOwningGoal(goalLookup ? goalLookup.goal : null);
        // v0.17 W12 — seed the TODO panel from disk. Reset the
        // collapsed flag too so switching to a fresh conversation
        // starts with the panel visible (matches first-load UX).
        setTodos(todoList ?? null);
        setTodosCollapsed(false);
        // v0.16 §4: restore persisted UI state. Apply scroll on the next
        // animation frame so the bubbles have laid out first; otherwise
        // scrollTop would clamp to (smaller) prior content height.
        const ui = ann.uiState;
        if (ui) {
          if (typeof ui.showPinnedOnly === "boolean") setShowPinnedOnly(ui.showPinnedOnly);
          if (typeof ui.scrollTop === "number") {
            requestAnimationFrame(() => {
              if (cancelled) return;
              if (scrollRef.current) scrollRef.current.scrollTop = ui.scrollTop!;
            });
          }
        } else {
          // Conversation has no persisted UI state — reset filter so a
          // previously open "Pinned only" state doesn't bleed across.
          setShowPinnedOnly(false);
        }
        // v0.16 §7: always collapse compaction on conversation switch.
        // "Always show full history" isn't a per-conversation preference
        // — it's a per-glance decision.
        setCompactionExpanded(false);
        // Reset any open thread on conversation switch — stale ids are
        // worse than no ids.
        setThreadStack([]);

        // v0.16 §4: deep-link via `#bubble-N`. Hash wins over the
        // restored scrollTop — the user explicitly pointed us at a
        // bubble, that's a stronger signal than "resume where you left
        // off". Two RAFs so layout settles + content height stabilises
        // before we measure the bubble offset.
        if (typeof window !== "undefined") {
          const m = /^#bubble-(\d+)$/.exec(window.location.hash);
          if (m) {
            const target = Number(m[1]);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (cancelled) return;
                const el = document.querySelector<HTMLElement>(`[data-bubble-idx="${target}"]`);
                if (!el) return;
                el.scrollIntoView({ behavior: "auto", block: "center" });
                el.classList.add("ring-2", "ring-amber-400");
                setTimeout(() => el.classList.remove("ring-2", "ring-amber-400"), 1500);
              });
            });
          }
        }
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
  }, [conversationId, scope.kind, (scope as any).projectSlug, (scope as any).effortSlug, reloadTick]);

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

  // ─── Persist UI state (v0.16 §4) ────────────────────────────────
  // Scroll: throttle via a trailing-edge timer; the user can scroll fast,
  // we don't want a fetch per pixel. The timer ref survives renders and
  // is cleared on conversation switch so a stale write can't trample the
  // next conversation's restored scroll.
  const scrollPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChatScroll = useCallback(() => {
    if (!conversationId) return;
    if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current);
    scrollPersistTimerRef.current = setTimeout(() => {
      const top = scrollRef.current?.scrollTop ?? 0;
      patchUiState(scope, conversationId, { scrollTop: top }).catch(() => undefined);
    }, 600);
  }, [conversationId, scope]);
  useEffect(() => {
    return () => {
      if (scrollPersistTimerRef.current) clearTimeout(scrollPersistTimerRef.current);
    };
  }, [conversationId]);

  // showPinnedOnly: write-through; one fetch per click is fine, no throttle.
  // Skip the very first run after conversation switch because that's the
  // *restore* path, not a user action.
  const showPinnedFirstRunRef = useRef(true);
  useEffect(() => {
    if (!conversationId) return;
    if (showPinnedFirstRunRef.current) {
      showPinnedFirstRunRef.current = false;
      return;
    }
    patchUiState(scope, conversationId, { showPinnedOnly }).catch(() => undefined);
  }, [showPinnedOnly, conversationId, scope]);
  useEffect(() => {
    showPinnedFirstRunRef.current = true;
  }, [conversationId]);

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

      // v0.17 mathub parity W7: reset AgentStatusPanel state for the new
      // turn. We pin the start timestamp on a ref AND in state because
      // the panel re-renders on every `statusTick` (1Hz) and needs a
      // stable wall-clock origin, while the ref keeps the timestamp
      // available to the SSE callback without re-reading state.
      const startedAt = Date.now();
      sendStartMsRef.current = startedAt;
      setSendStartMs(startedAt);
      setLatestEventType(null);
      setActiveToolCalls({});
      setSubAgentActive(false);
      setRound(null);

      const onEvent = (ev: ChatEvent) => {
        if (ev.type === "session") {
          setConversationId(ev.conversationId);
          return;
        }

        // v0.17 mathub parity W7: feed AgentStatusPanel state from the
        // SAME event tape that drives the bubble list. We do this
        // BEFORE the setBubbles call so a re-render that picks up the
        // new bubble also picks up the new phase pill in one paint.
        if (
          ev.type === "text" ||
          ev.type === "tool-call" ||
          ev.type === "tool-result" ||
          ev.type === "round-start" ||
          ev.type === "ask_user"
        ) {
          setLatestEventType(ev.type);
        }
        if (ev.type === "round-start") {
          setRound({
            current: ev.round,
            ...(typeof ev.maxRounds === "number" ? { max: ev.maxRounds } : {}),
          });
        }
        // v0.17 mathub parity W9 — the server confirms it consumed our
        // queued steer at a round boundary. Dismiss the "⏳ Steer
        // queued…" toast and stash the text on `steerLastReceived` so
        // the next round bubble can render a "📣 Steered" badge. We
        // don't push the steer into the bubble list ourselves — the
        // synthetic `[Steer from user: …]` message lives in history
        // already, and a reload picks it up naturally. The badge is a
        // one-shot affordance for the live session.
        if (ev.type === "steer-received") {
          setSteerToast(null);
          setSteerLastReceived(ev.text);
          // Auto-clear after a few seconds so the badge doesn't stick
          // forever; mirrors mathub's "toast" approach.
          window.setTimeout(() => {
            setSteerLastReceived((cur) => (cur === ev.text ? null : cur));
          }, 6000);
        }
        // v0.17 mathub parity W12 — the host SSE layer synthesises one
        // `todos` frame after every successful `todo_write` tool call.
        // We replace state outright (the payload is the *full* current
        // list, not a delta) so a partial in-flight stream that was
        // dropped + retried still converges to the right view.
        if (ev.type === "todos") {
          setTodos(ev.list);
        }
        // Approval Policy 矩阵 — a tool call needs sign-off. Park the request so
        // the ApprovalDialog renders; the server stream stays open awaiting our
        // POST. `approval_resolved` (or the decision POST success) clears it.
        if (ev.type === "approval_request") {
          setPendingApproval(ev.request);
          setApprovalError(null);
          setApprovalSubmitting(false);
        }
        if (ev.type === "approval_resolved") {
          setPendingApproval((cur) => (cur && cur.id === ev.id ? null : cur));
          setApprovalSubmitting(false);
          setApprovalError(null);
        }
        // v0.17 P2 — propose_goal confirmation produced a real Goal.
        // Show a banner notification, and when the model + user opted
        // for autoRun, navigate the SPA to the goal page so they can
        // watch the round stream live. The goal-mode SSE pump is
        // separate from the chat SSE pump, so the page switch is the
        // honest way to surface progress without forking two streams.
        if (ev.type === "goal-proposed") {
          setGoalProposed({
            goalId: ev.goalId,
            objective: ev.objective,
            maxRounds: ev.maxRounds,
            tokensCap: ev.tokensCap,
            autoRun: ev.autoRun,
          });
          if (ev.autoRun) {
            const scopeQS =
              ev.scope.kind === "project"
                ? `?scope=project:${encodeURIComponent(ev.scope.projectSlug ?? "")}`
                : ev.scope.kind === "effort"
                  ? `?scope=effort:${encodeURIComponent(ev.scope.projectSlug ?? "")}/${encodeURIComponent(ev.scope.effortSlug ?? "")}`
                  : "";
            // Small delay so the user sees the banner update before the
            // navigation rips it away. 800 ms is empirically just long
            // enough to register the message without feeling sluggish.
            window.setTimeout(() => {
              window.location.assign(`/goals/${encodeURIComponent(ev.goalId)}${scopeQS}`);
            }, 800);
          }
        }
        // outcomes 收尾 C-2 — a background self-grade round finished and wrote
        // an Outcome. Surface a transient toast and bump the reload tick so any
        // outcomes-backed panel (and the history view) re-reads from disk. The
        // frame can arrive on ANY open stream, so we don't gate on goalId here
        // beyond display — every tab with a live stream shows its own toast.
        if (ev.type === "goal-graded") {
          const score = ev.outcome.averageScore.toFixed(1);
          const shortId = ev.goalId.slice(0, 8);
          setGoalGradedToast(`📊 Goal graded: ${score}/5 (${shortId})`);
          window.setTimeout(() => {
            setGoalGradedToast((cur) =>
              cur && cur.includes(shortId) ? null : cur,
            );
          }, 6000);
        }
        // #3 Background Agents — a detached background subagent finished.
        // Feed the panel (terminal-state reconcile) + toast briefly.
        if (ev.type === "subagent-completed") {
          setBgCompletedFrame({
            type: "subagent-completed",
            subagentId: ev.subagentId,
            status: ev.status,
            durationMs: ev.durationMs,
            ...(ev.result ? { result: ev.result } : {}),
          });
          const shortId = ev.subagentId.slice(0, 10);
          const emoji =
            ev.status === "done" ? "🟢" : ev.status === "failed" ? "🔴" : "⚪";
          setBgSubagentToast(`${emoji} Subagent ${ev.status} (${shortId})`);
          window.setTimeout(() => {
            setBgSubagentToast((cur) =>
              cur && cur.includes(shortId) ? null : cur,
            );
          }, 6000);
        }
        // v0.17 P2 sibling — plan-proposed banner + optional auto-navigate.
        if (ev.type === "plan-proposed") {          setPlanProposed({
            planId: ev.planId,
            objective: ev.objective,
            autoRun: ev.autoRun,
          });
          if (ev.autoRun) {
            window.setTimeout(() => {
              window.location.assign(`/plans/${encodeURIComponent(ev.planId)}`);
            }, 800);
          }
        }
        if (ev.type === "tool-call") {
          // Track the in-flight call by id so the matching tool-result
          // removes the right entry even if calls arrive interleaved.
          setActiveToolCalls((prev) => ({ ...prev, [ev.id]: ev.name }));
          if (ev.name === "dispatch_subagent" || ev.name === "spawn_sub_goal") {
            setSubAgentActive(true);
          }
        } else if (ev.type === "tool-result") {
          setActiveToolCalls((prev) => {
            if (!(ev.id in prev)) return prev;
            const next = { ...prev };
            delete next[ev.id];
            return next;
          });
          // Recompute sub-agent flag from the remaining in-flight set.
          // (We can't use the just-set `next` here because `setActiveToolCalls`
          // is async; instead we read the latest via a functional update.)
          setSubAgentActive((wasActive) => {
            if (!wasActive) return false;
            // Will be re-derived on the next render via activeToolCalls;
            // optimistically clear when the closed call was a sub-agent.
            return ev.name !== "dispatch_subagent" && ev.name !== "spawn_sub_goal";
          });
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
              // Clear any leftover askPending flag from a prior round that
              // happened to recycle this tool-call id (paranoia — the
              // server mints fresh ids per call, but cheap to defend).
              const prevTool = next[idx] as ToolBubble;
              const updated: ToolBubble = {
                ...prevTool,
                result: ev.content,
                ok: ev.ok,
              };
              delete updated.askPending;
              next[idx] = updated;
            } else {
              next.push({ kind: "tool", id: ev.id, name: ev.name, result: ev.content, ok: ev.ok });
            }
            next.push({ kind: "assistant", text: "" });
          } else if (ev.type === "ask_user") {
            // v0.16 §11: the round is paused waiting for the user's
            // reply. Mark the matching tool bubble (which arrived as a
            // `tool-call` SSE event a beat earlier) so the renderer
            // shows the inline answer box. If for any reason the
            // tool-call event didn't land first, synthesize a bubble
            // so the answer UI still shows up.
            //
            // v0.19 Codex parity — forward every structured field the
            // SSE event carries. Build the askPending object once and
            // reuse it whether we patch an existing bubble or
            // synthesize a new one. `timeoutAt` is derived locally from
            // `Date.now() + timeoutSeconds * 1000` since the SSE event
            // doesn't carry the deadline (the server-side timer was
            // started in the same tick that emitted the event — the
            // drift is sub-second).
            const livePending: ToolBubble["askPending"] = {
              question: ev.question,
            };
            if (ev.options !== undefined) livePending.options = ev.options;
            if (ev.default !== undefined) livePending.default = ev.default;
            if (ev.timeoutSeconds !== undefined) {
              livePending.timeoutSeconds = ev.timeoutSeconds;
              livePending.timeoutAt = Date.now() + ev.timeoutSeconds * 1000;
            }
            if (ev.allowCustom !== undefined) {
              livePending.allowCustom = ev.allowCustom;
            }
            const idx = next.findIndex(
              (x) => x.kind === "tool" && (x as ToolBubble).id === ev.id,
            );
            if (idx !== -1) {
              const prevTool = next[idx] as ToolBubble;
              next[idx] = {
                ...prevTool,
                askPending: livePending,
              };
            } else {
              next.push({
                kind: "tool",
                id: ev.id,
                name: ev.name,
                args: JSON.stringify({ question: ev.question }),
                askPending: livePending,
              });
            }
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
        // v0.17 mathub parity W7: clear AgentStatusPanel state once the
        // stream is over. The panel itself returns `null` when
        // `busy === false`, but we still reset so a subsequent turn
        // doesn't briefly flash `Step 3/8` from the prior round before
        // its own `round-start` lands.
        setLatestEventType(null);
        setActiveToolCalls({});
        setSubAgentActive(false);
        setRound(null);
        // Approval Policy 矩阵 — if the stream ended while a prompt was still
        // open (Stop pressed, or the server settled it as a fail-safe deny),
        // drop the modal so it doesn't dangle over a dead stream.
        setPendingApproval(null);
        setApprovalSubmitting(false);
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

  // Approval Policy 矩阵 — POST the user's decision for the open prompt. On
  // success we keep the modal until `approval_resolved` lands (the resumed
  // stream confirms it); on failure we surface the error inline and re-enable
  // the buttons for a retry.
  const handleApprovalDecide = useCallback(
    async (decision: ApprovalDecision) => {
      const request = pendingApproval;
      if (!request || !conversationId) return;
      setApprovalSubmitting(true);
      setApprovalError(null);
      try {
        await postApprovalDecision(scope, conversationId, request.id, decision);
      } catch (err) {
        setApprovalError((err as Error).message);
        setApprovalSubmitting(false);
      }
    },
    [pendingApproval, conversationId, scope],
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

  // ─── Send a Live Steer (v0.17 mathub parity W9) ────────────────────
  //
  // Queue a free-form nudge against the in-flight stream. The composer
  // is repurposed as the steer textarea while `busy === true`; this
  // handler POSTs the text to `<chatBase>/:cid/steer` (or the goal
  // wrapper when a goal is associated). The runner consumes the text
  // at the next round-top inside `ChatSession.runRounds`, injects a
  // synthetic `[Steer from user: …]` user message, and emits a
  // `steer-received` SSE frame; the SPA dismisses the toast on receipt
  // (see the SSE handler in `runChatStream` / `streamChat` callbacks).
  //
  // Failures we silently swallow: 409 (no in-flight stream — a race
  // where the agent finished between the click and the POST), and any
  // abort. Real network errors flip the toast text but don't surface
  // an error bubble — steering is best-effort.
  async function handleSteer() {
    const text = input.trim();
    if (!text || !busy || !conversationId) return;
    // Show toast immediately for snappy feedback; clear on receipt.
    setSteerToast(text);
    setInput("");
    try {
      await steerChatConversation(scope, conversationId, text);
    } catch (err: any) {
      if (err?.status === 409) {
        // The agent finished after we clicked; just drop the toast.
        setSteerToast(null);
      } else {
        setSteerToast(`⚠ Could not queue steer: ${err?.message ?? String(err)}`);
        window.setTimeout(() => setSteerToast(null), 4000);
      }
    }
  }

  // ─── Slash commands: load list, derive filter, dispatch ────────────────
  // Fetch builtin + custom commands once on mount. Best-effort: the lib
  // falls back to the builtin-only list if the endpoint is unreachable so
  // the suggester always works.
  useEffect(() => {
    let cancelled = false;
    void fetchSlashCommands().then((res) => {
      if (cancelled) return;
      setSlashItems(buildSuggesterItems(res.builtin, res.custom));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The prefix currently being typed after `/` (null once a space is typed
  // or the text isn't a slash invocation). Drives the suggester filter.
  const slashPrefix = activeSlashPrefix(input);
  const slashFiltered = useMemo(
    () => (slashPrefix === null ? [] : filterCommands(slashItems, slashPrefix)),
    [slashItems, slashPrefix],
  );
  // Open while typing a command name that matches ≥1 command, and not while
  // a stream is in flight (Enter steers when busy — see onKeyDown).
  const slashOpen = !busy && slashPrefix !== null && slashFiltered.length > 0;

  // Clamp the highlight whenever the filtered list shrinks/changes.
  useEffect(() => {
    setSlashSelected((s) => (s >= slashFiltered.length ? 0 : s));
  }, [slashFiltered.length]);

  // Set of command names the composer recognises (builtin + custom). Anything
  // else starting with `/` is treated as ordinary chat text.
  const recognizedSlashNames = useMemo(
    () => new Set(slashItems.map((i) => i.name)),
    [slashItems],
  );

  // Append a local, non-persisted info bubble (used by client-only query
  // commands like /skills, /agents, /context). These are informational and
  // intentionally not written to server history (MVP).
  const pushInfoBubble = useCallback((text: string) => {
    setBubbles((b) => [...b, { kind: "assistant", text }]);
  }, []);

  // Accept the highlighted suggester item: complete the composer to
  // `/<name> ` and keep focus so the user can type args.
  const acceptSlashItem = useCallback((item: SuggesterItem) => {
    setInput(`/${item.name} `);
    setSlashSelected(0);
    composerRef.current?.focus();
  }, []);

  /**
   * Handle a recognised slash command. Returns either `{ handled: true }`
   * (fully handled client-side — caller should stop) or
   * `{ handled: false, chatText }` (the command expands into a normal chat
   * turn the caller should send, e.g. custom commands and /review).
   *
   * MVP stubs (PLAN decision #2): /review sends a preset prompt, /diff shows
   * a toast, /effort only stores the level.
   */
  const dispatchSlashCommand = useCallback(
    async (
      name: string,
      args: string,
    ): Promise<{ handled: true } | { handled: false; chatText: string }> => {
      // Custom command → inject its body (with $ARGUMENTS) as a chat turn.
      const custom = slashItems.find((i) => i.source === "custom" && i.name === name);
      if (custom) {
        return { handled: false, chatText: buildCustomPromptFromItem(custom, args) };
      }

      switch (name) {
        case "skills": {
          setInput("");
          const skills = await fetchSkills();
          if (skills.length === 0) {
            pushInfoBubble("**/skills** — no skills found in any layer.");
          } else {
            const lines = skills
              .map((s) => `- \`${s.name}\` _(${s.layer})_${s.description ? ` — ${s.description}` : ""}`)
              .join("\n");
            pushInfoBubble(`**Skills (${skills.length})**\n\n${lines}`);
          }
          return { handled: true };
        }

        case "agents": {
          setInput("");
          const { kinds, active } = await fetchActiveAgents();
          const kindLine = kinds.length ? kinds.map((k) => `\`${k}\``).join(", ") : "_(none)_";
          const activeLine = active.length
            ? active.map((a) => `- ${a.id} (${a.type})${a.status ? ` — ${a.status}` : ""}`).join("\n")
            : "_(none running)_";
          pushInfoBubble(
            `**Sub-agents**\n\nAvailable kinds: ${kindLine}\n\nActive:\n${activeLine}`,
          );
          return { handled: true };
        }

        case "context": {
          setInput("");
          if (usage) {
            pushInfoBubble(
              `**Context** — ${usage.tokens.toLocaleString()} tokens / ` +
                `${usage.contextWindow.toLocaleString()} window (**${usage.percentage}%**)` +
                (usage.warning ? `\n\n⚠ ${usage.warning}` : ""),
            );
          } else {
            pushInfoBubble("**Context** — usage data not available yet (send a message first).");
          }
          return { handled: true };
        }

        case "diff": {
          // /diff + checkpoint/rewind: server-rendered checkpoint list or a
          // single checkpoint's diff. Mirrors the CLI `/diff` output.
          setInput("");
          try {
            const res = await postChatSlash(conversationId ?? "global", "diff", args);
            pushInfoBubble("```diff\n" + (res.text ?? "(no output)") + "\n```");
          } catch (err) {
            pushInfoBubble(`**/diff** — ${(err as Error).message}`);
          }
          return { handled: true };
        }

        case "rewind": {
          // /diff + checkpoint/rewind: restore files to before a checkpoint
          // (or the newest N). The server applies the rollback + appends a
          // `[Rewound …]` system note; we re-read history to show it.
          setInput("");
          try {
            const res = await postChatSlash(conversationId ?? "global", "rewind", args);
            pushInfoBubble("```\n" + (res.text ?? "(no output)") + "\n```");
            setReloadTick((t) => t + 1);
          } catch (err) {
            pushInfoBubble(`**/rewind** — ${(err as Error).message}`);
          }
          return { handled: true };
        }

        case "plan": {
          // Open the existing plan runner; seed its objective with the args.
          if (args) setInput(args);
          else setInput("");
          setPlanOverlayOpen(true);
          return { handled: true };
        }

        case "compact": {
          setInput("");
          if (!conversationId) {
            pushInfoBubble("**/compact** — start a conversation first.");
            return { handled: true };
          }
          try {
            const k = Number.parseInt(args, 10);
            const res = await fetch(`${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/compact`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(Number.isFinite(k) && k > 0 ? { keepRecentRounds: k } : {}),
            });
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error((body as { error?: string }).error ?? `failed (${res.status})`);
            }
            setReloadTick((t) => t + 1);
          } catch (err) {
            setError(`compact failed: ${(err as Error).message}`);
          }
          return { handled: true };
        }

        case "effort": {
          setInput("");
          const level = args.trim().toLowerCase();
          if (!["low", "med", "medium", "high"].includes(level)) {
            pushInfoBubble("**/effort** — usage: `/effort <low|medium|high|max>`");
            return { handled: true };
          }
          // Best-effort persist on the server session (MVP: stored only).
          if (conversationId) {
            try {
              await postChatSlash(conversationId, "effort", level);
            } catch {
              /* best-effort — still confirm locally */
            }
          }
          pushInfoBubble(
            `**/effort** — reasoning effort set to \`${level === "medium" ? "med" : level}\` ` +
              "_(MVP: stored only; model router unchanged)_",
          );
          return { handled: true };
        }

        case "review": {
          setInput("");
          // MVP stub: send a preset review prompt as a normal chat turn.
          let prompt = REVIEW_FALLBACK_PROMPT;
          if (conversationId) {
            try {
              const res = await postChatSlash(conversationId, "review", "");
              if (res.prompt) prompt = res.prompt;
            } catch {
              /* fall back to the local preset */
            }
          }
          return { handled: false, chatText: prompt };
        }

        case "cd": {
          setInput("");
          const parsed = parseCdTarget(args);
          if ("error" in parsed) {
            setError(parsed.error);
            return { handled: true };
          }
          // Strict sandbox: the slug must be an existing project directory.
          try {
            const projects = await api.listProjects();
            if (!projects.some((p) => p.slug === parsed.slug)) {
              setError(`/cd: project "${parsed.slug}" not found under projects/`);
              return { handled: true };
            }
          } catch {
            setError("/cd: could not verify projects (server unreachable)");
            return { handled: true };
          }
          navigate(`/projects/${parsed.slug}/chat`);
          return { handled: true };
        }

        case "outcomes": {
          // outcomes 收尾 C-2 — server-rendered list/detail/delete. Mirrors
          // the CLI REPL `/outcomes` output; the SPA just renders the text the
          // server formats so both surfaces stay byte-identical.
          setInput("");
          try {
            const res = await postChatSlash(conversationId ?? "global", "outcomes", args);
            pushInfoBubble("```\n" + (res.text ?? "(no output)") + "\n```");
          } catch (err) {
            pushInfoBubble(`**/outcomes** — ${(err as Error).message}`);
          }
          return { handled: true };
        }

        default:
          // /memory, /system, /model live in the CLI). Show a hint rather
          // than silently sending to the LLM.
          setInput("");
          pushInfoBubble(`**/${name}** is a CLI-only command and isn't available in the web composer.`);
          return { handled: true };
      }
    },
    [slashItems, usage, scope, conversationId, navigate, pushInfoBubble],
  );

  // ─── Send a message ────────────────────────────────────────────────────
  async function send(e: React.FormEvent) {
    e.preventDefault();
    let rawText = input.trim();

    // Slash-command interception (SPA Slash Commands task). Only fires for
    // recognised builtin/custom names; unknown `/...` text falls through to
    // ordinary chat. Never while busy (Enter steers instead).
    if (!busy) {
      const parsed = parseSlashInput(rawText);
      if (parsed && recognizedSlashNames.has(parsed.name)) {
        const result = await dispatchSlashCommand(parsed.name, parsed.args);
        if (result.handled) return;
        // Command expands into a normal chat turn (custom command / review).
        rawText = result.chatText.trim();
        if (!rawText) return;
      }
    }

    // v0.17 mathub parity W2: Send is enabled when there's text OR at
    // least one ready attachment. Uploading attachments block the
    // send (we don't want to ship `path:undefined` to the server).
    const readyAttachments = attachments.filter(
      (a): a is Extract<PendingAttachment, { status: "ready" }> =>
        a.status === "ready",
    );
    if ((!rawText && readyAttachments.length === 0) || busy) return;
    if (hasUploadingAttachment) return; // wait for in-flight uploads

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

    // The wire-shape attachments the server consumes — just the three
    // fields the chat-attachment renderer needs. Local `id`/`size` are
    // SPA-only and don't cross the wire.
    const wireAttachments: ChatAttachmentRef[] = readyAttachments.map((a) => ({
      path: a.path,
      filename: a.filename,
      mimeType: a.mimeType,
    }));

    // Render the user bubble with a small inline summary of the
    // attachments (one line per chip) so the conversation log reflects
    // what the user shipped, not just the typed text. This is local-only
    // — the server independently inlines the file contents into the user
    // message it persists to the LLM history.
    // The user bubble text is just the typed message body — the chip
    // strip below the bubble (v0.17 mathub parity, rendered from
    // `bubble.attachments`) carries the filename badges, so we no
    // longer need the inline `📎 filename` summary that earlier W2
    // sketches put inside the bubble text. Keeping the bubble body
    // verbatim also matches what `historyToBubbles()` will produce on
    // reload, so a tab refresh and a live send render identically.
    const bubbleText = rawText;

    // Record the bubble index of the user message we're about to add so
    // we can PATCH its annotation once the SSE round trip starts.
    const userBubbleIdx = bubbles.length;
    setBubbles((b) => [
      ...b,
      wireAttachments.length > 0
        ? { kind: "user", text: bubbleText, attachments: wireAttachments }
        : { kind: "user", text: bubbleText },
      { kind: "assistant", text: "" },
    ]);

    // Clear the chip tray now that the refs are committed to the wire.
    setAttachments([]);

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
      streamChat(
        scope,
        promptText,
        conversationId ?? undefined,
        model || undefined,
        onEvent,
        signal,
        wireAttachments.length > 0 ? wireAttachments : undefined,
      ),
    );
  }

  // v0.16 §11: submit a reply to a paused `ask_user` call. Routed through
  // the same SSE driver so the UI behaves identically to a fresh send —
  // tokens stream, tool calls show up, the usage meter refreshes — while
  // the placeholder tool message gets patched server-side before the
  // resumed round runs. No-op if the conversation id isn't pinned yet
  // (shouldn't happen because the ask round itself minted it, but defend).
  const handleAnswerAsk = useCallback(
    async (callId: string, answer: string) => {
      if (!conversationId) return;
      // Clear the askPending flag optimistically so the textarea unmounts
      // immediately on Send — if the resume itself produces a *new*
      // ask_user, the SSE handler will re-stamp the flag on the fresh
      // tool-call bubble.
      setBubbles((prev) =>
        prev.map((b) => {
          if (b.kind === "tool" && b.id === callId && b.askPending) {
            const updated: ToolBubble = { ...b, result: answer, ok: true };
            delete updated.askPending;
            return updated;
          }
          return b;
        }),
      );
      await runChatStream((onEvent, signal) =>
        streamAnswerAsk(scope, conversationId, callId, answer, onEvent, signal),
      );
    },
    [conversationId, runChatStream, scope],
  );

  // /diff + checkpoint/rewind: handle the CheckpointChip actions on
  // write_file / edit_file tool cards. Targets the checkpoint by tool-call id
  // (the store keys checkpoints by it) and renders the server-formatted text.
  const handleCheckpointAction = useCallback(
    async (action: "diff" | "rewind", toolCallId: string) => {
      const cid = conversationId ?? "global";
      try {
        const res = await postChatSlash(cid, action, toolCallId);
        if (action === "diff") {
          pushInfoBubble("```diff\n" + (res.text ?? "(no output)") + "\n```");
        } else {
          pushInfoBubble("```\n" + (res.text ?? "(no output)") + "\n```");
          setReloadTick((t) => t + 1);
        }
      } catch (err) {
        pushInfoBubble(`**/${action}** — ${(err as Error).message}`);
      }
    },
    [conversationId, pushInfoBubble],
  );

  // ─── New / Select / Delete ─────────────────────────────────────────────
  function newChat() {
    setConversationId(null);
    setBubbles([]);
    setError(null);
    setUsage(null);
    setUsageHistory([]);
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
    | { kind: "tools"; tools: ToolBubble[] }
    // v0.16 §7: collapsed-prefix marker. `count` = bubble count hidden,
    // `until` = exclusive bubble index where the visible tail starts.
    | { kind: "compact"; count: number; until: number };
  // Compaction kicks in past this many bubbles. Picked empirically: any
  // less and short chats get a useless toggle; any more and a research
  // session starts feeling laggy to scroll. Easily tweakable.
  const COMPACT_THRESHOLD = 60;
  const COMPACT_TAIL = 20;
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let buffer: ToolBubble[] = [];
    const flushTools = () => {
      if (buffer.length > 0) {
        out.push({ kind: "tools", tools: buffer });
        buffer = [];
      }
    };
    const q = searchQuery.trim().toLowerCase();
    // v0.16 §7: Compaction only when not searching / not filtering and the
    // user hasn't manually expanded. We hide the *prefix*, keeping the last
    // COMPACT_TAIL bubbles + any pinned bubble visible — pinned messages are
    // exactly the "important enough to keep in sight" signal.
    let compactSkipUntil = -1;
    if (
      !q &&
      !showPinnedOnly &&
      !compactionExpanded &&
      bubbles.length > COMPACT_THRESHOLD
    ) {
      compactSkipUntil = bubbles.length - COMPACT_TAIL;
      // Count of bubbles we'll actually hide (some pinned ones in the prefix
      // are still rendered, so report the *effective* hidden count for the
      // strip's label).
      let hidden = 0;
      for (let i = 0; i < compactSkipUntil; i++) {
        if (!annotations.byBubbleIdx[String(i)]?.pinned) hidden++;
      }
      if (hidden > 0) {
        out.push({ kind: "compact", count: hidden, until: compactSkipUntil });
      }
    }
    const matchesSearch = (b: Bubble): boolean => {
      if (!q) return true;
      if (b.kind === "tool") {
        // Match tool name + args + result text. Useful when looking for
        // "that lean_check that mentioned Frobenius".
        return (
          b.name.toLowerCase().includes(q) ||
          JSON.stringify(b.args).toLowerCase().includes(q) ||
          (b.result ?? "").toLowerCase().includes(q)
        );
      }
      return b.text.toLowerCase().includes(q);
    };
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      // v0.16 §7: in compacted prefix, hide everything except pinned
      // bubbles (which stay visible as anchors).
      if (
        i < compactSkipUntil &&
        !annotations.byBubbleIdx[String(i)]?.pinned
      ) {
        // Still flush any buffered tool bubbles so a tool group doesn't
        // straddle the compact boundary in a confusing way.
        if (b.kind === "tool") continue;
        flushTools();
        continue;
      }
      // v0.16 §6: when searching, drop non-matching bubbles. Search
      // overrides the pinned filter — the user wants to find a thing.
      if (q && !matchesSearch(b)) continue;
      // v0.16 §2: when filtering to pinned-only, drop both tool bubbles
      // (they're never standalone-meaningful) and any single bubble that
      // doesn't have pinned=true in its annotation. The data-bubble-idx
      // attribute keeps jumpToBubble() working off the original index.
      if (showPinnedOnly && !q) {
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
  }, [bubbles, showPinnedOnly, annotations, searchQuery, compactionExpanded]);

  // v0.16 §6: visible row count (single bubbles only) for the search
  // "N matches" indicator. Tool groups count as one row but are
  // usually 1–6 calls; users care about “how many bubbles I see” here,
  // not exact tool count.
  const visibleMatchCount = useMemo(
    () => rows.filter((r) => r.kind === "single").length,
    [rows],
  );

  // v0.16 §6: global Ctrl/Cmd+F to open the in-chat search. We capture
  // before the browser's native find so the user gets *our* search
  // (which knows about pinned, scope, tool args) instead of just the
  // DOM text. Esc inside the search box closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isFind = (e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F");
      if (!isFind) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // v0.17 mathub parity: Esc closes the image lightbox even when no
  // element inside the modal has focus (the backdrop click works too,
  // but Esc is the standard exit shortcut and screen-readers expect
  // it). Only attached while a lightbox is open so we don't shadow
  // Esc handling in other modals.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // ─── spawn_sub_goal → sub-goal id mapping (v0.16 §3) ───────────────────
  // Walk all tool bubbles in chronological order and zip them against
  // the parent goal's `subGoalIds[]`. The Nth spawn_sub_goal call in
  // history maps to subGoalIds[N]. We choose this rule over scraping
  // the tool-result text because:
  //   1) it works even before the result comes back (mid-stream the
  //      thread button can already point at the right id, since the
  //      sub-goal record is created by sub-goal-tool BEFORE the round
  //      loop starts);
  //   2) the result text format isn't a stable contract.
  // When subGoalIds is shorter than the count of spawn_sub_goal calls
  // (race during recovery, etc.) the tail calls get no id and the
  // thread button stays hidden — acceptable degradation.
  const subGoalIdByToolId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (!owningGoal?.subGoalIds || owningGoal.subGoalIds.length === 0) return map;
    let n = 0;
    for (const b of bubbles) {
      if (b.kind !== "tool") continue;
      if (b.name !== "spawn_sub_goal") continue;
      const id = owningGoal.subGoalIds[n];
      if (id) map[b.id] = id;
      n++;
    }
    return map;
  }, [bubbles, owningGoal]);

  const handleOpenThread = useCallback((goalId: string) => {
    setThreadStack((prev) => [...prev, goalId]);
  }, []);
  const handleCloseThread = useCallback(() => {
    setThreadStack([]);
  }, []);
  const handleBackThread = useCallback(() => {
    setThreadStack((prev) => prev.slice(0, -1));
  }, []);
  const currentThreadGoalId =
    threadStack.length > 0 ? threadStack[threadStack.length - 1] : null;

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
    // v0.16 §4: picker was removed; no popup to close here.
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
  // v0.16 §4: also updates `location.hash` so the address bar mirrors
  // the position — paste-able into chat / docs as a permalink.
  function jumpToBubble(bubbleIdx: number) {
    const el = document.querySelector<HTMLElement>(
      `[data-bubble-idx="${bubbleIdx}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-amber-400");
    setTimeout(() => el.classList.remove("ring-2", "ring-amber-400"), 1500);
    // Use replaceState so the back button doesn't fill with every nav jump.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.hash = `bubble-${bubbleIdx}`;
      window.history.replaceState(null, "", url.toString());
    }
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
          {/* v0.16 §6: in-conversation search. Toggle with the 🔍 button
              or Ctrl/Cmd+F when the chat panel has focus. Live-filters
              visible bubbles + highlights matches inside the bubble text. */}
          <div className="ml-2 flex shrink-0 items-center">
            {searchOpen ? (
              <div className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-1 py-0.5">
                <input
                  autoFocus
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setSearchOpen(false);
                      setSearchQuery("");
                    }
                  }}
                  placeholder="Search this chat…"
                  className="w-44 rounded px-1 py-0.5 text-xs focus:outline-none"
                />
                {searchQuery && (
                  <span className="text-[10px] text-slate-500">
                    {visibleMatchCount}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(false);
                    setSearchQuery("");
                  }}
                  className="rounded px-1 text-slate-500 hover:bg-slate-100"
                  title="Close search (Esc)"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                title="Search this conversation (Ctrl/Cmd+F)"
              >
                🔍
              </button>
            )}
          </div>
          {/* v0.16 §3: "this conversation is a Goal" indicator. Clicking
              opens the primary thread (i.e. the goal's own conversation)
              — useful entry point when you want to see goal status / end
              reason / round count without scrolling. Hidden when not a
              goal-mode chat. */}
          {/* v0.16 §9 audit #2: 📋 Plan button. Spawns a plan-mode run in a
              modal overlay; the user can Accept (writes the plan to
              .mathran/plans/) or Reject without touching this chat. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => setPlanOverlayOpen(true)}
            className="ml-2 shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            title="Draft a read-only plan (Approach / Steps / Key files / Risks / Acceptance) before doing the work"
          >
            📋 Plan
          </button>
          {/* v0.16 §4: GoalControls handles BOTH non-goal (Start) and goal
              (Run / Interrupt / Cancel / budget meter) states. The thread
              shortcut is kept as a separate button so users can pop the
              drawer without disturbing run controls. */}
          <GoalControls
            scope={scope}
            goal={owningGoal}
            defaultModel={model}
            busy={busy}
            onGoalCreated={(g) => {
              // Switch to the new goal's primary conversation. The goal
              // record's conversationIds[0] is created the first time a
              // round runs; until then we just stash the goal so the
              // header reflects status. We also kick the first round
              // immediately on the user's behalf — fits "Start goal"
              // semantics better than landing in an empty chat.
              setOwningGoal(g);
              // Fire-and-forget; round completion will refresh history.
              runGoalRound(g.id)
                .then((r) => {
                  setOwningGoal(r.goal);
                  // Switch into the conversation the goal just produced.
                  if (r.goal.conversationIds[0]) {
                    setConversationId(r.goal.conversationIds[0]);
                  }
                })
                .catch((e) => setError(String((e as Error).message ?? e)));
            }}
            onRoundRan={(r) => {
              setOwningGoal(r.goal);
              // Refresh the conversation history so new bubbles appear.
              if (r.goal.conversationIds[0]) {
                if (r.goal.conversationIds[0] !== conversationId) {
                  setConversationId(r.goal.conversationIds[0]);
                } else {
                  setReloadTick((t) => t + 1);
                }
              }
            }}
          />
          {owningGoal && (
            <button
              type="button"
              onClick={() => handleOpenThread(owningGoal.id)}
              className="ml-1 shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
              title={`Open thread · ${owningGoal.objective}`}
            >
              📂 Thread{owningGoal.subGoalIds && owningGoal.subGoalIds.length > 0
                ? ` · ${owningGoal.subGoalIds.length} sub${owningGoal.subGoalIds.length === 1 ? "" : "s"}`
                : ""}
            </button>
          )}
          {/* goal-defaults-timer (commit 6/7): auto-run countdown badge.
              Only surfaces when the gate is currently open (active goal,
              not busy, not typing) — hidden state means "timer paused".
              Mirrors the existing busy ticker's 1Hz cadence so the
              countdown decrements smoothly. */}
          {owningGoal && (() => {
            const secs = autoRunCountdownSeconds({
              owningGoal,
              busy,
              unsentTextLength: input.trim().length,
              lastKeystrokeTs: lastKeystrokeTsRef.current,
              now: autoRunNowMs,
              nextTickAt: nextAutoRunAt,
            });
            if (secs === null) return null;
            return (
              <span
                className="ml-1 shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
                title="Next goal round runs automatically in this many seconds. Typing in the composer or pausing the goal stops the timer."
              >
                🕒 Auto-run in {secs}s
              </span>
            );
          })()}
          {/* W10 (v0.17 mathub parity): forest view toggle. Only surfaces
              when the goal has at least one sub-goal — a leaf goal has
              nothing to see in tree form. */}
          {owningGoal && owningGoal.subGoalIds && owningGoal.subGoalIds.length > 0 && (
            <button
              type="button"
              onClick={() => setSubagentTreeOpen((v) => !v)}
              className="ml-1 shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
              title={subagentTreeOpen ? "Hide sub-agent tree" : "Show sub-agent tree"}
              aria-expanded={subagentTreeOpen}
            >
              🌳 Sub-agent tree ({owningGoal.subGoalIds.length})
              <span className="ml-1 text-slate-400">{subagentTreeOpen ? "▾" : "▸"}</span>
            </button>
          )}
        </div>
        {owningGoal && subagentTreeOpen && (
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-2">
            <SubagentTreePanel
              scope={scope}
              rootGoalId={owningGoal.id}
              onOpenThread={(goalId) => handleOpenThread(goalId)}
            />
          </div>
        )}

        {/* #3 Background Agents — flat list of detached background subagents
            running across the workspace. Self-hides when none are active. */}
        <div className="border-b border-slate-200 bg-slate-50 px-6 py-2 empty:hidden">
          <BackgroundAgentsPanel completedFrame={bgCompletedFrame} />
        </div>

        {/* v0.17 W11: per-scope goal-autonomy defaults card. Collapsed
            by default; expands inline so the user can pin autonomy /
            budget defaults without leaving the chat surface. */}
        <div className="border-b border-slate-200 bg-slate-50 px-6 py-1.5">
          <GoalAutonomyCard scope={scope} />
        </div>

        {/* v0.17 W8: mathub-parity status strip. Only mounts when this
            conversation is the primary one of a goal-loop — plain chats
            don't need a status panel. The panel polls /api/goals/:id/status
            every 3s for round counters, budget pressure, heartbeat
            freshness, and the latest plan/text summary, and exposes
            Abort / Resume so the user can steer the loop without
            opening the thread drawer. */}
        {owningGoal && (
          <div className="border-b border-slate-200 bg-slate-50 px-6 py-1.5">
            <GoalRunStatusPanel
              goalId={owningGoal.id}
              pollKey={reloadTick}
              onStatus={(s) => {
                // Keep the in-memory goal row's status field roughly in
                // sync with the panel — GoalControls reads `goal.status`
                // to decide which buttons to surface. We only flip the
                // local copy when the projected status actually changed.
                setOwningGoal((prev) => {
                  if (!prev) return prev;
                  if (prev.status === s.status) return prev;
                  return { ...prev, status: s.status, endReason: s.endReason ?? prev.endReason };
                });
              }}
            />
          </div>
        )}

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
          <div className="flex items-center gap-2">
            <ContextMeter
              tokens={usage.tokens}
              contextWindow={usage.contextWindow}
              warning={usage.warning}
              percentage={usage.percentage}
            />
            {/* v0.16 §8: tiny token-usage sparkline. Shows the trajectory of
                this chat's token count across recent refreshes — lets you
                see at a glance whether the conversation is creeping toward
                the context window. Hidden until ≥2 points so a brand-new
                chat doesn't render a useless dot. */}
            {usageHistory.length >= 2 && (
              <UsageSparkline points={usageHistory} contextWindow={usage.contextWindow} />
            )}
          </div>
        ) : conversationId ? (
          <ContextMeter
            tokens={0}
            contextWindow={200_000}
            warning={null}
            percentage={0}
            loading
          />
        ) : null}

        <div ref={scrollRef} onScroll={onChatScroll} className="flex-1 space-y-3 overflow-y-auto p-6">
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
          {rows.map((row, i) => {
            if (row.kind === "tools") {
              return (
                <ToolCallGroup
                  key={`g${i}`}
                  tools={row.tools}
                  subGoalIdByToolId={subGoalIdByToolId}
                  onOpenThread={handleOpenThread}
                  onAnswerAsk={handleAnswerAsk}
                  onCheckpointAction={handleCheckpointAction}
                />
              );
            }
            if (row.kind === "compact") {
              // v0.16 §7: collapsed-prefix strip. One click expands the
              // entire conversation — the user explicitly chose to see
              // history, so we don't ask twice.
              return (
                <button
                  key={`c${i}`}
                  type="button"
                  onClick={() => setCompactionExpanded(true)}
                  className="flex w-full items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                  title="Show the earlier turns of this conversation"
                >
                  <span>📜</span>
                  <span>
                    {row.count} earlier turn{row.count === 1 ? "" : "s"} hidden — click to show
                  </span>
                  <span className="ml-auto text-slate-400">▾</span>
                </button>
              );
            }
            return (
              <div
                key={i}
                data-bubble-idx={row.bubbleIdx}
                className={`group/msg flex ${row.bubble.kind === "user" ? "justify-end" : "justify-start"} rounded-md transition`}
              >
                <div className={`flex flex-col ${row.bubble.kind === "user" ? "max-w-2xl" : "w-full"}`}>
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
                  ) : row.bubble.kind === "assistant" && row.bubble.text === "" ? (
                    /* ─── Streaming-thinking pill (v0.16 §10) ──────────────────
                       Before any tokens land we used to render a markdown bubble
                       containing a single horizontal-ellipsis fallback, which
                       looked like a giant empty card sitting between tool
                       cards. Replace with a Mathub-style compact status pill:
                       a spinning loader + a soft "Thinking…" caption in the
                       violet palette. No border, no padding-block, no markdown
                       container — it should feel like a transient status line,
                       not a chat bubble that demands acknowledgement. */
                    <div
                      role="status"
                      aria-live="polite"
                      className="inline-flex items-center gap-2 rounded-full bg-violet-50/70 px-3 py-1 text-xs text-violet-700"
                    >
                      <svg
                        className="h-3 w-3 animate-spin text-violet-500"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                        <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                      <span className="font-medium">Thinking</span>
                      <span className="inline-flex gap-0.5" aria-hidden="true">
                        <span className="inline-block h-1 w-1 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.3s]" />
                        <span className="inline-block h-1 w-1 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.15s]" />
                        <span className="inline-block h-1 w-1 animate-bounce rounded-full bg-violet-400" />
                      </span>
                    </div>
                  ) : row.bubble.kind === "user" &&
                    row.bubble.text === "" &&
                    row.bubble.attachments &&
                    row.bubble.attachments.length > 0 ? (
                    /* Attachment-only user send (v0.17 mathub parity):
                       the composer permits Send with empty text when at
                       least one file is queued. Skip the empty slate pill
                       so the chip strip below stands on its own; otherwise
                       we'd render an awkward zero-width black rectangle. */
                    null
                  ) : (
                    /* ─── Message body (v0.16 §11) ──────────────────────────
                       User messages stay as a slate pill on the right (chat-
                       app convention), but assistant messages now render
                       full-width with no border/bubble, matching Mathub /
                       ChatGPT. The visual asymmetry is intentional: the
                       assistant’s response is the document, the user’s line
                       is just a label of "who asked what". */
                    <div
                      className={`relative text-sm ${
                        row.bubble.kind === "user"
                          ? "rounded-lg bg-slate-900 px-4 py-2 text-white"
                          : "px-1 py-1 text-slate-800"
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
                            __html: marked.parse(row.bubble.text) as string,
                          }}
                        />
                      ) : (
                        <span className="whitespace-pre-wrap">{row.bubble.text}</span>
                      )}
                    </div>
                  )}

                  {/* ─── Attachment chips strip (v0.17 mathub parity) ────────
                      Renders below the user bubble whenever the persisted
                      message carried an `attachments:[…]` array. Two flavours:
                        - image/* → 80×80 thumbnail; click opens a modal
                          lightbox so the user can see the full-res image
                          without leaving the conversation.
                        - everything else → small `📎 filename` text chip;
                          click downloads (the link `download` attribute
                          + matching Content-Disposition on the server side
                          would be ideal, but the immutable Cache-Control on
                          the GET makes a plain anchor good enough).
                      We hide this whole block when the bubble has no
                      attachments so streaming-edit cases (no attachments)
                      stay visually identical to pre-v0.17 ChatPanel. */}
                  {row.bubble.kind === "user" &&
                  row.bubble.attachments &&
                  row.bubble.attachments.length > 0 ? (
                    <div className="mt-1 flex flex-wrap justify-end gap-1">
                      {row.bubble.attachments.map((att, ai) => {
                        const url = uploadsUrlFor(att);
                        const isImage = att.mimeType.startsWith("image/");
                        if (isImage) {
                          return (
                            <button
                              key={`${att.path}-${ai}`}
                              type="button"
                              onClick={() => setLightbox(att)}
                              className="overflow-hidden rounded border border-slate-300 bg-slate-50 hover:opacity-90"
                              title={att.filename}
                            >
                              <img
                                src={url}
                                alt={att.filename}
                                className="block h-20 w-20 object-cover"
                                loading="lazy"
                              />
                            </button>
                          );
                        }
                        return (
                          <a
                            key={`${att.path}-${ai}`}
                            href={url}
                            download={att.filename}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex max-w-[20rem] items-center gap-1 truncate rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700 hover:bg-slate-100"
                            title={`${att.filename} — click to download`}
                          >
                            <span aria-hidden="true">📎</span>
                            <span className="truncate">{att.filename}</span>
                          </a>
                        );
                      })}
                    </div>
                  ) : null}

                  {/* ─── Reactions strip (v0.16 §2; simplified §4) ─────────────
                      Sticky 👍/👎 indicators that stay visible after the
                      hover bar fades — so a thumbs-down on a bad answer
                      remains obvious when you scroll past. Click to clear. */}
                  {(() => {
                    const reactions =
                      annotations.byBubbleIdx[String(row.bubbleIdx)]?.reactions;
                    const entries = reactions ? Object.entries(reactions).filter(([, n]) => n > 0) : [];
                    if (entries.length === 0) return null;
                    return (
                      <div
                        className={`mt-0.5 flex gap-1 ${
                          row.bubble.kind === "user" ? "justify-end" : "justify-start"
                        }`}
                      >
                        {entries.map(([emoji]) => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => void handleToggleReaction(row.bubbleIdx, emoji)}
                            className={`rounded-full border px-1.5 py-0.5 text-[11px] hover:opacity-80 ${
                              emoji === "👍"
                                ? "border-emerald-300 bg-emerald-50"
                                : emoji === "👎"
                                  ? "border-red-300 bg-red-50"
                                  : "border-slate-300 bg-slate-50"
                            }`}
                            title="Click to clear"
                          >
                            {emoji}
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
                      {/* 👍 / 👎 thumbs (v0.16 §4 simplification).
                          Replaced the 10-emoji picker; this is a personal
                          research log, the only useful signal is "good answer"
                          vs "bad answer". State is rendered live from
                          annotations so the pressed look is sticky across
                          sessions / tabs. */}
                      {(() => {
                        const r = annotations.byBubbleIdx[String(row.bubbleIdx)]?.reactions ?? {};
                        const upActive = (r["👍"] ?? 0) > 0;
                        const downActive = (r["👎"] ?? 0) > 0;
                        return (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleToggleReaction(row.bubbleIdx, "👍")}
                              className={`rounded px-1 py-0.5 hover:bg-slate-200 ${
                                upActive ? "bg-emerald-100 text-emerald-700" : ""
                              }`}
                              title={upActive ? "Remove thumbs up" : "Thumbs up"}
                            >
                              👍
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleReaction(row.bubbleIdx, "👎")}
                              className={`rounded px-1 py-0.5 hover:bg-slate-200 ${
                                downActive ? "bg-red-100 text-red-700" : ""
                              }`}
                              title={downActive ? "Remove thumbs down" : "Thumbs down"}
                            >
                              👎
                            </button>
                          </>
                        );
                      })()}
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
            );
          })}
        </div>

        {/* ─── TodoListPanel (v0.17 mathub parity W12) ─────────────────────────
            In-conversation TODO tracker maintained by the `todo_write`
            built-in tool. Seeded from disk on conversation load, then
            live-updated by `todos` SSE frames during a stream. The
            panel is self-hiding when the list is empty, so simple Q&A
            turns stay quiet. We render it ABOVE AgentStatusPanel so it
            stays visible between turns (the status panel disappears
            when `busy === false`). */}
        <TodoListPanel
          list={todos}
          collapsed={todosCollapsed}
          onToggleCollapsed={() => setTodosCollapsed((c) => !c)}
        />

        {/* ─── AgentStatusPanel (v0.17 mathub parity W7) ─────────────────────────
            Compact status strip rendered just BELOW the bubble list
            while the chat / goal round is streaming. Hides itself when
            `busy === false` so the chat surface stays clean between
            turns. Phase / tools / sub-agent / round / elapsed all wire
            off the same SSE event tape that fills `bubbles`, so a
            single source of truth drives both views. */}
        <AgentStatusPanel
          busy={busy}
          latestEventType={latestEventType}
          activeTools={Object.values(activeToolCalls)}
          subAgentActive={subAgentActive}
          elapsedMs={sendStartMs > 0 ? Date.now() - sendStartMs : 0}
          round={round}
        />

        {/* ─── GoalProposalBanner (v0.17 follow-up P2) ───────────────────────────
            Shown immediately after a successful `propose_goal` tool
            result. When `autoRun=true` the banner also signals an
            imminent navigate (the chat handler triggers a 800-ms-
            delayed location.assign to the goal page). Manual mode (no
            autoRun) shows a plain link so the user can open the goal
            on their schedule. */}
        {goalProposed && (
          <div className="mx-6 mb-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="font-medium">
                  🎯 Goal created
                  {goalProposed.autoRun && (
                    <span className="ml-2 inline-block rounded-full bg-emerald-200 px-2 py-0.5 text-xs font-normal">
                      auto-starting…
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-emerald-800">
                  <span className="font-medium">{goalProposed.objective}</span>
                  {" · "}
                  maxRounds {goalProposed.maxRounds}
                  {goalProposed.tokensCap ? `, tokensCap ${goalProposed.tokensCap}` : ", unbounded tokens"}
                </div>
                <a
                  href={`/goals/${encodeURIComponent(goalProposed.goalId)}`}
                  className="mt-1 inline-block text-xs underline hover:no-underline"
                >
                  {goalProposed.autoRun ? "Open goal now" : "Open goal page"}
                </a>
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setGoalProposed(null)}
                className="shrink-0 rounded p-1 text-emerald-700 hover:bg-emerald-100"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* ─── PlanProposalBanner (v0.17 follow-up P2 sibling) ──────────────
            Shown after a successful `propose_plan` tool result. Plan
            mode runs are one-shot and short — `autoRun=true` is the
            default, so the banner is almost always a brief "opening
            plan…" before the SPA navigates. */}
        {planProposed && (
          <div className="mx-6 mb-2 rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm text-indigo-900 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="font-medium">
                  📋 Plan reserved
                  {planProposed.autoRun && (
                    <span className="ml-2 inline-block rounded-full bg-indigo-200 px-2 py-0.5 text-xs font-normal">
                      auto-running…
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-indigo-800">
                  <span className="font-medium">{planProposed.objective}</span>
                </div>
                <a
                  href={`/plans/${encodeURIComponent(planProposed.planId)}`}
                  className="mt-1 inline-block text-xs underline hover:no-underline"
                >
                  {planProposed.autoRun ? "Open plan now" : "Open plan page"}
                </a>
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setPlanProposed(null)}
                className="shrink-0 rounded p-1 text-indigo-700 hover:bg-indigo-100"
              >
                ✕
              </button>
            </div>
          </div>
        )}

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

        {/* W2 (v0.17 mathub parity): drag-and-drop region wraps the
            entire composer area — chip tray + textarea + buttons — so
            dropping a file anywhere in the composer triggers an upload.
            The textarea separately handles paste; the 📎 button below
            opens the hidden file picker. Upload status is rendered as
            chips above the textarea. */}
        <div
          onDragOver={(e) => {
            // Only react to dragged *files*. Dragging selected text on
            // the page also fires dragover, but `types` won't include
            // "Files" — we don't want the composer to flash for that.
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (!dragOver) setDragOver(true);
            }
          }}
          onDragLeave={(e) => {
            // dragleave fires for every child element as the pointer
            // crosses internal boundaries, so we only clear when the
            // pointer leaves the composer wrapper entirely. `currentTarget`
            // is always the wrapper; relatedTarget is the element being
            // entered (or null on window exit).
            const next = e.relatedTarget as Node | null;
            if (!next || !e.currentTarget.contains(next)) {
              setDragOver(false);
            }
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragOver(false);
            const dropped = Array.from(e.dataTransfer.files);
            if (dropped.length > 0) void uploadFiles(dropped);
          }}
          className={
            "border-t border-slate-200 bg-white transition-colors " +
            (dragOver
              ? "border-violet-400 bg-violet-50/30 ring-2 ring-violet-300"
              : "")
          }
        >
          {/* Pending attachment chips. One row, wraps if it overflows.
              Only rendered when there's something to show — we don't
              want an empty 8px strip eating composer height. */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
              {attachments.map((a) => {
                const isUploading = a.status === "uploading";
                const isError = a.status === "error";
                const baseClass =
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs";
                const statusClass = isError
                  ? "border-red-300 bg-red-50 text-red-800"
                  : isUploading
                    ? "border-slate-300 bg-slate-50 text-slate-600 opacity-75 animate-pulse"
                    : "border-slate-300 bg-slate-50 text-slate-700";
                const tooltip = isError
                  ? `Upload failed: ${a.error}`
                  : isUploading
                    ? "Uploading…"
                    : `${a.filename}${
                        a.status === "ready"
                          ? ` (${a.mimeType}, ${Math.max(
                              1,
                              Math.round(a.size / 1024),
                            )} KB)`
                          : ""
                      }`;
                return (
                  <span key={a.id} className={`${baseClass} ${statusClass}`} title={tooltip}>
                    <span aria-hidden>📎</span>
                    <span className="max-w-[16ch] truncate">{a.filename}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      className="rounded-full px-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
                      title="Remove attachment"
                      aria-label={`Remove ${a.filename}`}
                    >
                      ✖
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          {/* Hidden file input the 📎 button triggers. `multiple`
              + un-restricted accept matches the server's allowlist gate
              (server returns 415 for disallowed types; we surface that
              as a red chip rather than restricting the picker, so the
              error story stays in one place). */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length > 0) void uploadFiles(picked);
              // Reset so picking the same file again still fires change.
              e.target.value = "";
            }}
          />

          <form onSubmit={send} className="flex items-end gap-2 p-4">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              className="rounded-md border border-slate-300 px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              title="Attach file"
              aria-label="Attach file"
            >
              📎
            </button>
            <div className="relative flex-1">
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                // goal-defaults-timer (commit 6/7): keystroke tracking
                // for the auto-run gate. Use a ref so we don't churn
                // renders on every character; the countdown badge
                // already re-renders at 1Hz via autoRunNowMs.
                lastKeystrokeTsRef.current = Date.now();
              }}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onPaste={(e) => {
                // W2: capture *image* files from clipboard (e.g.
                // screenshot pasted from a screenshot tool). Text pastes
                // pass through untouched — we only preventDefault when
                // we actually consumed image entries, otherwise the
                // browser's default paste-into-textarea must win.
                const items = e.clipboardData?.items;
                if (!items) return;
                const images: File[] = [];
                for (let i = 0; i < items.length; i++) {
                  const it = items[i];
                  if (it.kind === "file" && it.type.startsWith("image/")) {
                    const f = it.getAsFile();
                    if (f) images.push(f);
                  }
                }
                if (images.length > 0) {
                  e.preventDefault();
                  void uploadFiles(images);
                }
              }}
              onKeyDown={(e) => {
                // Slash suggester navigation takes priority while it's open.
                if (slashOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashSelected((s) => moveSelection(s, 1, slashFiltered.length));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashSelected((s) => moveSelection(s, -1, slashFiltered.length));
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    // Collapse the suggester without clearing the text by
                    // appending a space (moves past the command name).
                    setInput((t) => (activeSlashPrefix(t) !== null ? `${t} ` : t));
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const item = slashFiltered[slashSelected];
                    if (item) acceptSlashItem(item);
                    return;
                  }
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    !isComposingRef.current &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault();
                    const item = slashFiltered[slashSelected];
                    if (!item) return;
                    // If the full command name is already typed, Enter
                    // executes; otherwise Enter accepts the completion.
                    if (activeSlashPrefix(input) === item.name) {
                      e.currentTarget.form?.requestSubmit();
                    } else {
                      acceptSlashItem(item);
                    }
                    return;
                  }
                }
                // Enter sends, Shift+Enter inserts a newline. Skip while
                // an IME composition is active or while a stream is
                // running. keyCode 229 is the "composition in progress"
                // sentinel some browsers fire after compositionend.
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  !isComposingRef.current &&
                  e.keyCode !== 229
                ) {
                  e.preventDefault();
                  if (busy) {
                    // v0.17 mathub parity W9 — while a stream is open,
                    // Enter sends the input as a Live Steer instead of
                    // a brand-new turn. Mirrors clicking the 📣 Steer
                    // button.
                    void handleSteer();
                    return;
                  }
                  // requestSubmit() dispatches a real submit event so
                  // <form onSubmit={send}> handles preventDefault + the
                  // existing reply/quote/empty-trim logic.
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={
                busy
                  ? "Type a steer… (Enter to queue, Shift+Enter for newline)"
                  : "Type a message… (Shift+Enter for newline; drag/paste files to attach)"
              }
              // v0.17 mathub parity W9 — keep the textarea enabled while
              // busy so the user can type their Live Steer. The visual
              // "busy" cue is the button swap (Stop + Steer replacing
              // Send), not a greyed-out textarea.
              rows={Math.min(
                8,
                Math.max(1, input.split("\n").length),
              )}
              className="w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-50"
            />
            {slashOpen && (
              <SlashSuggester
                items={slashFiltered}
                selectedIndex={slashSelected}
                onSelect={acceptSlashItem}
                onHover={setSlashSelected}
              />
            )}
            </div>
            {busy ? (
              // While a stream is open the composer offers two actions:
              //   - Steer (v0.17 mathub parity W9): post the current
              //     `input` as a free-form nudge that the runner picks
              //     up at the next round boundary. Enabled iff there's
              //     text + a known conversationId. Doesn't cancel the
              //     stream.
              //   - Stop: .abort()s the underlying fetch so the SSE
              //     pump tears down and runChatStream's finally block
              //     flips `busy` back to false.
              <>
                <button
                  type="button"
                  onClick={() => void handleSteer()}
                  disabled={!input.trim() || !conversationId}
                  className="rounded-md bg-amber-500 px-3 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                  title={
                    !conversationId
                      ? "Waiting for stream…"
                      : !input.trim()
                        ? "Type a nudge first"
                        : "Queue this text as a steer for the in-flight stream"
                  }
                >
                  📣 Steer
                </button>
                <button
                  type="button"
                  onClick={stop}
                  className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
                  title="Stop generating"
                >
                  ⏹ Stop
                </button>
              </>
            ) : (
              <button
                type="submit"
                // Enable Send when there's text OR at least one ready
                // attachment, and no uploads are still in-flight.
                disabled={
                  hasUploadingAttachment ||
                  (!input.trim() &&
                    !attachments.some((a) => a.status === "ready"))
                }
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                title={
                  hasUploadingAttachment
                    ? "Waiting for uploads to finish…"
                    : undefined
                }
              >
                Send
              </button>
            )}
          </form>
        </div>
      </div>
      {/* v0.16 §3: side-panel thread drawer. Rendered once at the top
          level so its fixed-position overlay isn't trapped inside the
          scrollable conversation column. */}
      <ThreadDrawer
        goalId={currentThreadGoalId}
        onClose={handleCloseThread}
        onPushThread={handleOpenThread}
        canGoBack={threadStack.length > 1}
        onBack={handleBackThread}
      />
      {planOverlayOpen && (
        <PlanRunOverlay
          initialObjective={input}
          defaultModel={model || null}
          onAccepted={({ location }) => {
            // Surface the save location as a transient toast; "plan
            // mode lives outside chat history" per v0.16 §9, so we don't
            // inject a bubble. Auto-clears after 6s.
            setPlanSavedToast(`📋 Plan saved to ${location}`);
            window.setTimeout(() => setPlanSavedToast(null), 6000);
          }}
          onClose={() => setPlanOverlayOpen(false)}
        />
      )}
      {planSavedToast && (
        <div
          className="fixed bottom-4 right-4 z-50 max-w-sm rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 shadow"
          role="status"
        >
          {planSavedToast}
        </div>
      )}
      {/* outcomes 收尾 C-2 — goal-graded toast. Stacked above the steer toasts
          (bottom-28) so a grade landing mid-steer doesn't clobber either. */}
      {goalGradedToast && (
        <button
          type="button"
          onClick={() => setGoalGradedToast(null)}
          className="fixed bottom-28 right-4 z-50 max-w-sm rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-left text-xs text-sky-900 shadow hover:bg-sky-100"
          title="Click to dismiss"
        >
          {goalGradedToast}
        </button>
      )}
      {/* #3 Background Agents — subagent-completed toast. */}
      {bgSubagentToast && (
        <button
          type="button"
          onClick={() => setBgSubagentToast(null)}
          className="fixed bottom-36 right-4 z-50 max-w-sm rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-left text-xs text-emerald-900 shadow hover:bg-emerald-100"
          title="Click to dismiss"
        >
          {bgSubagentToast}
        </button>
      )}
      {/* v0.17 mathub parity W9 — Live Steering toasts.
          - `steerToast`: "⏳ Steer queued… «…first 80 chars»". Visible
            from the moment the user clicks Steer until the server
            confirms with `steer-received`.
          - `steerLastReceived`: "📣 Steered: …". One-shot confirmation
            shown for a few seconds after the runner picks up the
            steer. Stacked above `planSavedToast` when both are
            visible.
          Both are dismissible by clicking the toast. Bottom-right
          placement matches the existing plan toast so the user's eye
          isn't pulled away from the composer. */}
      {steerToast && (
        <button
          type="button"
          onClick={() => setSteerToast(null)}
          className="fixed bottom-16 right-4 z-50 max-w-sm rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900 shadow hover:bg-amber-100"
          title="Click to dismiss"
        >
          ⏳ Steer queued… “{steerToast.length > 80 ? steerToast.slice(0, 80) + "…" : steerToast}”
        </button>
      )}
      {steerLastReceived && !steerToast && (
        <button
          type="button"
          onClick={() => setSteerLastReceived(null)}
          className="fixed bottom-16 right-4 z-50 max-w-sm rounded-md border border-indigo-300 bg-indigo-50 px-3 py-2 text-left text-xs text-indigo-900 shadow hover:bg-indigo-100"
          title="Click to dismiss"
        >
          📣 Steered: “{steerLastReceived.length > 80 ? steerLastReceived.slice(0, 80) + "…" : steerLastReceived}”
        </button>
      )}

      {/* Approval Policy 矩阵 — tool-call approval modal. Rendered whenever a
          prompt is in flight; blocks nothing else but draws over the chat. */}
      {pendingApproval && (
        <ApprovalDialog
          request={pendingApproval}
          onDecide={handleApprovalDecide}
          pending={approvalSubmitting}
          error={approvalError}
        />
      )}

      {/* ─── Image lightbox (v0.17 mathub parity) ───────────────────
          A minimal modal: backdrop click or Escape closes; nothing else.
          Driven by `lightbox` state set when a user clicks an image
          attachment chip. We intentionally don't add zoom/pan/keyboard
          paging — the goal is "see the full image without a download",
          not a full-blown gallery. If multiple-image cycling is wanted
          later, it slots in here without touching the chip render. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setLightbox(null);
          }}
        >
          <img
            src={uploadsUrlFor(lightbox)}
            alt={lightbox.filename}
            className="max-h-[90vh] max-w-[90vw] rounded shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLightbox(null);
            }}
            className="absolute top-4 right-4 rounded-full bg-white/90 px-3 py-1 text-sm text-slate-900 shadow hover:bg-white"
            aria-label="Close image preview"
          >
            ✕ Close
          </button>
        </div>
      )}
    </div>
  );
}
