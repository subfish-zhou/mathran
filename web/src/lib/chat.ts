// SSE client for the scoped chat endpoints. EventSource only supports GET, so
// we read the streamed response body manually and parse the `event:` / `data:`
// frames that Hono's streamSSE emits.

import { chatScopeBase, type ChatScopeSpec } from "./api.ts";

/**
 * v0.17 mathub parity W2: attachment ref the composer forwards alongside
 * the prompt body. Server reads each file, inlines text under `[Attachment:
 * …]`, emits `[Image: … @ path]` markers for images, or `[Binary: …]`
 * metadata for everything else. See `src/server/chat-attachments.ts`.
 */
export interface ChatAttachmentRef {
  /** Absolute path returned by `POST /api/uploads`. Workspace-internal
   *  (under `<workspace>/.mathran/uploads/`); server re-validates it on
   *  every send so the SPA can re-forward it across turns. */
  path: string;
  filename: string;
  mimeType: string;
}

// ─────────────────────────────────────────────────────────────────
// v0.17 mathub parity W12: in-conversation TODO tracker.
//
// Mirrored from `src/core/chat/tools/todo-write.ts`. The on-disk schema is
// versioned (`version: 1`) so the SPA can stay forward-compatible if the
// server bumps it later.
// ─────────────────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TodoList {
  version: 1;
  items: TodoItem[];
  updatedAt: string;
}

export type ChatEvent =
  | { type: "session"; sessionId: string; conversationId: string; resumedFromAsk?: boolean }
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: string }
  | { type: "tool-result"; id: string; name: string; ok: boolean; content: string }
  | {
      /** v0.16 §11 — the model called `ask_user`. The serve stream emits
       *  this just before closing; the SPA renders an inline answer box
       *  on the matching tool bubble. Resume the round via
       *  {@link streamAnswerAsk}. */
      type: "ask_user";
      id: string;
      name: string;
      question: string;
    }
  | {
      /** v0.17 mathub parity W7 — emitted by the *goal* runner at the
       *  top of every goal round (NOT by plain chat). The SPA's
       *  AgentStatusPanel uses it to render `🔄 Step N/MAX · ⏱ Xs` as
       *  soon as the round begins. `maxRounds` is omitted when the goal
       *  has no round-budget cap. */
      type: "round-start";
      round: number;
      maxRounds?: number;
    }
  | {
      /** v0.17 mathub parity W9 — emitted whenever a queued steer is
       *  picked up at a round boundary inside `ChatSession.runRounds`.
       *  The SPA uses it to dismiss its "⏳ Steer queued…" toast and
       *  attach a "📣 Steered: …" badge to the next round bubble. The
       *  injected `[Steer from user: …]` user message also appears in
       *  the persisted history so a tab reload sees what the user
       *  actually steered with. */
      type: "steer-received";
      text: string;
    }
  | {
      /** v0.17 mathub parity W12 — emitted by the host SSE layer after
       *  every successful `todo_write` tool call. The kernel can't yield
       *  arbitrary events from inside a tool, so `serve.ts` synthesises
       *  this frame right after the `tool-result` event by reading the
       *  freshly-persisted file from disk. Carries the *current* full
       *  list — the SPA replaces its local state with `list.items`
       *  rather than trying to diff. */
      type: "todos";
      list: TodoList;
    }
  | {
      /** v0.17 follow-up P2 — emitted by the host SSE layer after a
       *  successful `propose_goal` tool result. Carries the freshly-
       *  created goal's id + objective + budget so the SPA can render
       *  an inline "goal created" notification and (when
       *  `autoRun === true`) auto-navigate to the goal page.
       *
       *  scope mirrors the chat's own scope so the goal page can be
       *  opened at the right `/goals/:id` route under the right
       *  project / effort. */
      type: "goal-proposed";
      goalId: string;
      objective: string;
      maxRounds: number;
      tokensCap: number | null;
      scope: { kind: "global" | "project" | "effort"; projectSlug?: string; effortSlug?: string };
      autoRun: boolean;
    }
  | {
      /** v0.17 follow-up P2 sibling — emitted after a successful
       *  `propose_plan` tool result. Plan mode is workspace-rooted (no
       *  per-scope plans store today) so we don't repeat the scope on
       *  the wire — the SPA just navigates to `/plans/:planId`. */
      type: "plan-proposed";
      planId: string;
      objective: string;
      autoRun: boolean;
    }
  | { type: "done"; finishReason: string }
  | { type: "error"; message: string };

/**
 * Stream a single user message through one of the three chat scopes.
 *
 * `conversationId` is optional — the backend mints one when omitted, and the
 * caller can pick it up from the first `session` event so subsequent turns can
 * reuse it (BUG #6 multi-turn fix).
 *
 * `attachments` (v0.17 mathub parity W2) forwards composer-upload refs so the
 * server can inline file contents / emit `[Image: …]` markers in the user
 * message. Omit or pass `[]` for plain text-only sends — the wire shape stays
 * backward-compatible with prior callers.
 */
export async function streamChat(
  scope: ChatScopeSpec,
  message: string,
  conversationId: string | undefined,
  model: string | undefined,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
  attachments?: ChatAttachmentRef[],
): Promise<void> {
  const body: Record<string, unknown> = { message };
  if (conversationId) body.conversationId = conversationId;
  if (model) body.model = model;
  if (attachments && attachments.length > 0) body.attachments = attachments;

  await pumpSSE(
    chatScopeBase(scope),
    body,
    onEvent,
    signal,
  );
}

/**
 * Re-run a prior user prompt by ordinal. The server truncates history to
 * everything before that user message, replays it into the session, then
 * streams the new assistant turn using the same SSE envelope as `streamChat`,
 * so callers can reuse one event handler for both flows.
 *
 * `userMessageIndex` is the 0-based ordinal *among user messages only*
 * (matches the server's counting in `POST .../rerun`). The SPA derives it by
 * counting `kind: "text"` + `role: "user"` bubbles up to the clicked bubble.
 *
 * `overrideText` (optional) lets callers replace the prompt body without
 * needing a separate "edit + resend" endpoint. The server still truncates to
 * the same position; only the text fed into `session.send()` changes.
 */
export async function rerunChat(
  scope: ChatScopeSpec,
  conversationId: string,
  userMessageIndex: number,
  model: string | undefined,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
  overrideText?: string,
  pruneFromBubbleIdx?: number,
): Promise<void> {
  const body: Record<string, unknown> = { userMessageIndex };
  if (model) body.model = model;
  if (overrideText !== undefined) body.overrideText = overrideText;
  // Tell the server how far to wipe the annotations sidecar. Without this,
  // re-running an old prompt would leave reactions/pins from the now-stale
  // assistant reply attached to whatever takes its slot.
  if (Number.isInteger(pruneFromBubbleIdx) && (pruneFromBubbleIdx as number) >= 0) {
    body.pruneFromBubbleIdx = pruneFromBubbleIdx;
  }
  const url = `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/rerun`;
  await pumpSSE(url, body, onEvent, signal);
}

/**
 * v0.16 §11 — reply to a pending `ask_user` call and resume the round.
 *
 * Streams the resumed turn over SSE using the same envelope as
 * {@link streamChat} / {@link rerunChat}, so the SPA's existing event
 * reducer handles it without a special branch (besides clearing the
 * pending-ask UI on the first event — typically `session`).
 *
 * `callId` is the tool-call id of the placeholder; the server cross-checks
 * it against the conversation's persisted `pendingAsk` slot to guard
 * against stale tabs answering an already-resolved question.
 */
export async function streamAnswerAsk(
  scope: ChatScopeSpec,
  conversationId: string,
  callId: string,
  answer: string,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = { answer, callId };
  const url = `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/answer-ask`;
  await pumpSSE(url, body, onEvent, signal);
}

/**
 * Drop a tail of a conversation's history (server-side; no SSE).
 *
 * `mode: "include"` (default) wipes the target user message + everything
 * after it. `mode: "after"` keeps the target user message and only drops
 * what comes after it (used by "Delete this reply").
 *
 * Returns the new history length so callers can refresh meters. The SPA
 * keeps its bubble list in sync optimistically.
 */
export async function truncateChat(
  scope: ChatScopeSpec,
  conversationId: string,
  userMessageIndex: number,
  mode: "include" | "after" = "include",
  signal?: AbortSignal,
  pruneFromBubbleIdx?: number,
): Promise<{ length: number; mode: "include" | "after" }> {
  const body: Record<string, unknown> = { userMessageIndex, mode };
  if (Number.isInteger(pruneFromBubbleIdx) && (pruneFromBubbleIdx as number) >= 0) {
    body.pruneFromBubbleIdx = pruneFromBubbleIdx;
  }
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/truncate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    },
  );
  if (!res.ok) {
    let msg = `truncate failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const data = (await res.json()) as { length: number; mode: "include" | "after" };
  return data;
}

/**
 * Shared SSE pump: POSTs `body` to `url` and dispatches `event:` / `data:`
 * frames as typed `ChatEvent`s through `onEvent`. Extracted from `streamChat`
 * so re-run (and any future chat-shaped endpoint) reuses the same parser.
 */
async function pumpSSE(
  url: string,
  body: Record<string, unknown>,
  onEvent: (ev: ChatEvent) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let msg = `chat request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    onEvent({ type: "error", message: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushFrame = (frame: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (eventName === "error") {
        onEvent({ type: "error", message: String(parsed.message ?? "error") });
      } else {
        onEvent({ type: eventName, ...parsed } as ChatEvent);
      }
    } catch {
      /* ignore unparseable frame */
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) flushFrame(frame);
    }
  }
  if (buffer.trim()) flushFrame(buffer);
}


// ─── Annotations sidecar (v0.16 §2) ─────────────────────────────────────────
// React / pin / note / reply-target. Indexed by *bubble* index — the SPA's
// renderer position — so the client never has to translate to history coords.

export interface MessageAnnotation {
  reactions?: Record<string, number>;
  pinned?: boolean;
  note?: string;
  replyTo?: { bubbleIdx: number; snippet: string };
}

export interface ConversationUiState {
  scrollTop?: number;
  expandedToolCallIds?: string[];
  showPinnedOnly?: boolean;
}

export interface ConversationAnnotations {
  version: 1;
  byBubbleIdx: Record<string, MessageAnnotation>;
  uiState?: ConversationUiState;
  /** v0.16 §11 — an `ask_user` round is paused waiting for the user's
   *  reply. The SPA renders an inline answer box keyed by `callId` on
   *  the matching tool bubble; submitting the reply hits
   *  `POST <chatBase>/:id/answer-ask` and clears this slot. Present
   *  on reload so a tab opened after the original SSE stream closed
   *  can still render the answer affordance. */
  pendingAsk?: PendingAskAnnotation;
}

export interface PendingAskAnnotation {
  question: string;
  callId: string;
  toolCallId: string;
  ts: number;
}

export async function fetchAnnotations(
  scope: ChatScopeSpec,
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationAnnotations> {
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/annotations`,
    { signal },
  );
  if (!res.ok) throw new Error(`fetchAnnotations failed (${res.status})`);
  return (await res.json()) as ConversationAnnotations;
}

/**
 * v0.17 mathub parity W12 — fetch the persisted TODO list for a conversation.
 *
 * Used to seed the ActivePlanPanel on conversation load / tab switch, before
 * any SSE stream has run. During an active stream the same panel is updated
 * in real time via the `todos` ChatEvent. An empty list is returned for
 * conversations that have never called `todo_write`.
 */
export async function fetchTodos(
  scope: ChatScopeSpec,
  conversationId: string,
  signal?: AbortSignal,
): Promise<TodoList> {
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/todos`,
    { signal },
  );
  if (!res.ok) throw new Error(`fetchTodos failed (${res.status})`);
  return (await res.json()) as TodoList;
}

/** PATCH a single bubble's annotation with a partial merge. Pass null in
 *  any field to clear it. Returns the post-merge annotation. */
export async function patchAnnotation(
  scope: ChatScopeSpec,
  conversationId: string,
  bubbleIdx: number,
  // Each field is either its normal value or `null` to clear. Modeled as a
  // mapped type so callers can mix-and-match (e.g. `{ pinned: true, note:
  // null }`) without union juggling at every call site.
  patch: { [K in keyof MessageAnnotation]?: MessageAnnotation[K] | null },
  signal?: AbortSignal,
): Promise<MessageAnnotation> {
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/annotations/${bubbleIdx}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      signal,
    },
  );
  if (!res.ok) {
    let msg = `patchAnnotation failed (${res.status})`;
    try { const d = await res.json(); if (d?.error) msg = d.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = (await res.json()) as { annotation: MessageAnnotation };
  return data.annotation;
}

/** v0.16 §4: persist per-conversation UI state (scroll, expanded tool
 *  cards, pinned-only filter) to the same sidecar so a reload resumes.
 *
 *  Fields omitted from `patch` keep their previous server-side value;
 *  `null` clears the field. Server returns the post-merge state. */
export async function patchUiState(
  scope: ChatScopeSpec,
  conversationId: string,
  patch: { [K in keyof ConversationUiState]?: ConversationUiState[K] | null },
  signal?: AbortSignal,
): Promise<ConversationUiState> {
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/uistate`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      signal,
    },
  );
  if (!res.ok) throw new Error(`patchUiState failed (${res.status})`);
  const data = (await res.json()) as { uiState: ConversationUiState };
  return data.uiState ?? {};
}

/** Toggle a single emoji reaction. Convenience wrapper around PATCH that
 *  does the flip server-side so two clicks racing don't blow each other
 *  away. Returns the post-toggle reactions record. */
export async function toggleReaction(
  scope: ChatScopeSpec,
  conversationId: string,
  bubbleIdx: number,
  emoji: string,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/annotations/${bubbleIdx}/react`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji }),
      signal,
    },
  );
  if (!res.ok) throw new Error(`toggleReaction failed (${res.status})`);
  const data = (await res.json()) as { reactions: Record<string, number> };
  return data.reactions ?? {};
}

/**
 * v0.17 mathub parity W9 — Live Steering.
 *
 * Queue a free-form steer text against a chat conversation whose SSE
 * stream is currently in flight. The server validates that there's an
 * active stream for the conversationId; the next round-top inside
 * `ChatSession.runRounds` consumes the text, injects a synthetic
 * `[Steer from user: …]` user message, and emits a `steer-received`
 * SSE frame the SPA can hook to dismiss its "queued" toast.
 *
 * Contract:
 *   - 200: `{ ok, queued: true, conversationId, scope }` — the steer is
 *     in the registry and will be picked up at the next round
 *     boundary.
 *   - 409: no in-flight stream → caller should ignore / surface a
 *     gentle error ("the agent is not currently thinking").
 *   - 400: empty / whitespace-only `text`.
 *
 * Mirrors `interruptChat` semantics (per-scope, per-conversationId).
 */
export interface SteerResult {
  ok: true;
  queued: true;
  conversationId: string;
  scope: unknown;
}
export async function steerChatConversation(
  scope: ChatScopeSpec,
  conversationId: string,
  text: string,
  signal?: AbortSignal,
): Promise<SteerResult> {
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/steer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    },
  );
  if (res.status === 409) {
    // Lifted to a typed error so callers can distinguish "no stream" from
    // network errors and silently no-op instead of toasting.
    const err = new Error("no in-flight stream to steer") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`steerChatConversation failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as SteerResult;
}

/**
 * v0.17 mathub parity W9 — goal-mode variant. The SPA's goal panel
 * doesn't track the inner conversationId, so this wrapper resolves it
 * server-side from the goal record. Same 200 / 409 / 400 contract.
 */
export async function steerGoal(
  goalId: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ ok: true; queued: true; goalId: string; conversationId: string }> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (res.status === 409) {
    const err = new Error("no in-flight round to steer") as Error & { status?: number };
    err.status = 409;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`steerGoal failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as { ok: true; queued: true; goalId: string; conversationId: string };
}

// ─── Thread / Goal-mode API (v0.16 §3) ─────────────────────────────────
// In goal mode the assistant may call `spawn_sub_goal` to start an autonomous
// research branch. That branch is a separate Goal record with its OWN chat
// conversation; the parent only sees a summary. The SPA navigates the tree
// by calling these endpoints — the goal record is the source of truth, the
// SPA doesn't reconstruct it from audit logs.

/** Shape mirrors `Goal` in src/core/goal/store.ts. Only the fields the SPA
 *  actually reads; the rest are passed through opaquely as `unknown`. */
export interface GoalRow {
  id: string;
  objective: string;
  scope: { kind: "global" | "project" | "effort"; projectSlug?: string; effortKey?: string };
  model: string;
  status: "active" | "paused" | "complete" | "failed" | "cancelled" | "exhausted";
  endReason?: string | null;
  parentGoalId?: string | null;
  subGoalIds?: string[];
  conversationIds: string[];
  summaryPath?: string | null;
  /** v0.16 §9 audit #4 (added W4): workspace-relative path to the active
   *  plan markdown file (`.mathran/goals/<id>.plan.md`). null/missing when
   *  bootstrap hasn't run, was skipped (sub-goal), or failed. The SPA uses
   *  presence of this field to decide whether to show the Active Plan
   *  section in ThreadDrawer. */
  planPath?: string | null;
  budget: { tokensMax: number | null; roundsMax: number | null };
  stats: { tokensUsed: number; roundsRun: number; toolCallCount: number };
  createdAt: string;
  updatedAt: string;
}

export interface SubGoalStub {
  id: string;
  objective: string;
  status: GoalRow["status"];
  parentGoalId: string | null;
  endReason: string | null;
  conversationId: string | null;
  roundsRun: number;
  tokensUsed: number;
}

export interface ThreadPayload {
  goal: GoalRow;
  primaryConversationId: string | null;
  history: unknown[];
  subGoals: SubGoalStub[];
}

/** Reverse lookup: is this conversation owned by a Goal? Returns null on 404
 *  (plain chat) and throws on other errors so the UI can degrade gracefully. */
export async function findGoalForConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<{ goalId: string; goal: GoalRow } | null> {
  const res = await fetch(`/api/goals/by-conversation/${encodeURIComponent(conversationId)}`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`findGoalForConversation failed (${res.status})`);
  return (await res.json()) as { goalId: string; goal: GoalRow };
}

/** Open a thread: goal record + history + shallow sub-goal stubs. Used when
 *  the user clicks "📂 Open thread" on a spawn_sub_goal tool-call. */
export async function fetchThread(goalId: string, signal?: AbortSignal): Promise<ThreadPayload> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/thread`, { signal });
  if (!res.ok) throw new Error(`fetchThread failed (${res.status})`);
  return (await res.json()) as ThreadPayload;
}

// ─── v0.16 §9 audit #6: active-plan fetch for the goal drawer ──────────────────
//
// `goal.planPath` is on every `GoalRow`, but the plan body lives in a file
// on the server's workspace — the SPA needs to fetch it separately. This
// is a passive read; the runner is the only writer (bootstrap + the
// `update_plan_item` tool), so a poll-on-status-change pattern in the
// drawer is plenty.

/** One parsed checklist item, mirrors `PlanStep` in src/core/goal/plan.ts. */
export interface GoalPlanStep {
  /** 1-based global index across the whole plan document. */
  index: number;
  status: "todo" | "done";
  text: string;
  /** Zero-based line in the source markdown body. */
  line: number;
}

export interface GoalPlanPayload {
  /** `false` when the goal has no `.plan.md` file on disk yet. */
  hasPlan: boolean;
  /** Workspace-relative path to the plan file when `hasPlan`, else null. */
  planPath: string | null;
  /** Raw markdown body of the plan (rendered as-is by the drawer), or null. */
  body: string | null;
  /** Parsed checklist steps. Empty when `hasPlan` is false or the plan has
   *  no checklist items (e.g. prose-only `## Approach`). */
  steps: GoalPlanStep[];
}

export async function fetchGoalPlan(
  goalId: string,
  signal?: AbortSignal,
): Promise<GoalPlanPayload> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/plan`, { signal });
  if (!res.ok) throw new Error(`fetchGoalPlan failed (${res.status})`);
  return (await res.json()) as GoalPlanPayload;
}

// ─── v0.16 §4: Goal-mode chat entry (create / run / interrupt / cancel) ──────
export interface CreateGoalInput {
  objective: string;
  /** Either { kind: "global" } or { kind: "project", projectSlug } /
   *  { kind: "effort", projectSlug, effortSlug } — matches the shape the
   *  server's parseGoalScope() expects. SPA forwards its ChatScopeSpec
   *  directly. */
  scope:
    | { kind: "global" }
    | { kind: "project"; projectSlug: string }
    | { kind: "effort"; projectSlug: string; effortSlug: string };
  model?: string;
  /** Hard token cap for the whole goal (sum across rounds). null/omitted
   *  = no cap. */
  budgetTokens?: number | null;
  /** Hard round cap. null/omitted = no cap. */
  maxRounds?: number | null;
}

export async function createGoal(input: CreateGoalInput): Promise<GoalRow> {
  const res = await fetch("/api/goals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`createGoal failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { goal: GoalRow };
  return data.goal;
}

/** Run one round of an active goal. Server returns the updated goal record
 *  + the round's summary text. The chat panel uses the goal's primary
 *  conversation as the surface, so the panel will refresh-load that
 *  conversation's history after the round completes. */
export interface GoalRoundResult {
  goal: GoalRow;
  /** Round transcript / summary text. May be empty when the round produced
   *  no assistant text (e.g. ended immediately on a tool error). */
  text?: string;
  /** Lifecycle flags emitted by the runner. `aborted` is set when the
   *  round was interrupted; the goal stays active. `completed`/`failed`/
   *  `exhausted` mean the goal itself ended (status moved to a terminal
   *  state) and the SPA should refresh its goal info. */
  completed?: boolean;
  failed?: boolean;
  exhausted?: boolean;
  aborted?: boolean;
  endReason?: string | null;
}

export async function runGoalRound(
  goalId: string,
  userMessage?: string,
  signal?: AbortSignal,
): Promise<GoalRoundResult> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(userMessage ? { message: userMessage } : {}),
    signal,
  });
  if (!res.ok) throw new Error(`runGoalRound failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as GoalRoundResult;
}

export async function interruptGoal(goalId: string): Promise<void> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/interrupt`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`interruptGoal failed (${res.status})`);
}

export async function cancelGoal(goalId: string): Promise<void> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`cancelGoal failed (${res.status})`);
}

// ─── v0.17 W8: GoalRunStatusPanel helpers ─────────────────────────────
//
// Backed by the `/api/goals/:id/status|abort|resume` routes the server
// added in the same task. `getGoalStatus` is the polling probe; the
// other two mutate the goal record.

/** Wire shape returned by `GET /api/goals/:id/status`. Stays narrow on
 *  purpose so a future schema change won't silently break the panel. */
export interface GoalStatus {
  id: string;
  objective: string;
  status: "active" | "paused" | "complete" | "failed" | "cancelled" | "exhausted";
  endReason: string | null;
  round: number;
  roundsMax: number | null;
  tokensUsed: number;
  tokensMax: number | null;
  toolCount: number;
  resumeCount: number;
  heartbeatAt: number | null;
  latestSummary: string | null;
  abortRequested: boolean;
  conversationId: string | null;
  summaryPath: string | null;
  planPath: string | null;
  parentGoalId: string | null;
  subGoalCount: number;
}

/** GET /api/goals/:id/status — cheap polling probe; never throws on 404
 *  (returns null so the panel can decide to stop polling). */
export async function getGoalStatus(
  goalId: string,
  signal?: AbortSignal,
): Promise<GoalStatus | null> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/status`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getGoalStatus failed (${res.status})`);
  return (await res.json()) as GoalStatus;
}

/** POST /api/goals/:id/abort — cooperative abort. The runner picks up the
 *  flag at the top of the next round; if a round is currently in-flight
 *  the server also calls its AbortController so the stream unwinds. */
export async function abortGoal(goalId: string): Promise<void> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/abort`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`abortGoal failed (${res.status})`);
}

/** POST /api/goals/:id/resume — clear a pending abortRequested flag and
 *  (if paused) flip the goal back to active so the caller can /run again. */
export async function resumeGoal(goalId: string): Promise<GoalRow> {
  const res = await fetch(`/api/goals/${encodeURIComponent(goalId)}/resume`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`resumeGoal failed (${res.status})`);
  const body = await res.json();
  return body.goal as GoalRow;
}
