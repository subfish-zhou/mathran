/**
 * Filesystem-backed Chat session store (T1-C).
 *
 * Mathub stores all chat as polymorphic `channels` rows in Postgres, scoped to
 * `projectId | programId | threadId | effortId`. We mirror that in mathran by
 * putting each chat conversation under one of three on-disk roots:
 *
 *   global:   <workspace>/.mathran/global-chat/<conversationId>.jsonl
 *   project:  <workspace>/projects/<projectSlug>/chat/<conversationId>.jsonl
 *   effort:   <workspace>/projects/<projectSlug>/efforts/<effortSlug>/chat/<conversationId>.jsonl
 *
 * Each `.jsonl` file stores one `LLMMessage` per line (replay-friendly).
 * Alongside the conversation files, `.index.json` carries a small per-scope
 * directory of conversations (title, createdAt, lastUsedAt, messageCount).
 *
 * Persistence model:
 *   - on first `getOrCreate(scope, conversationId)` we lazily rehydrate the
 *     jsonl into the kernel `ChatSession`,
 *   - after each `ChatSession.send()` finishes we re-serialise the session's
 *     `history()` to disk (full overwrite — small files, no risk of corruption
 *     from partial writes),
 *   - an in-memory LRU keeps recently-used sessions hot (avoiding rebuild on
 *     every request),
 *   - the on-disk file is the source of truth; the LRU is just a cache.
 */

import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { ChatSession } from "./session.js";
import type { LLMMessage } from "../providers/llm.js";
import { renderTranscriptMarkdown } from "./transcript.js";
import { atomicWriteFile } from "./atomic-write.js";
import { deleteConversationCheckpoints } from "../checkpoints/store.js";

export type ChatScopeKind = "global" | "project" | "effort";

/** Logical chat scope (parent), translated to disk path by `scopeDir()`. */
export interface ChatScope {
  kind: ChatScopeKind;
  projectSlug?: string;
  effortSlug?: string;
}

/** Stable string key for a scope. Drives the LRU index. */
export function scopeKey(s: ChatScope): string {
  if (s.kind === "global") return "global";
  if (s.kind === "project") return `project:${s.projectSlug}`;
  return `effort:${s.projectSlug}/${s.effortSlug}`;
}

const GLOBAL_DIR = path.join(".mathran", "global-chat");

/** Compute the on-disk directory for a scope. Caller must `mkdir -p` it. */
export function scopeDir(workspace: string, scope: ChatScope): string {
  switch (scope.kind) {
    case "global":
      return path.join(workspace, GLOBAL_DIR);
    case "project": {
      if (!scope.projectSlug) throw new Error("project scope requires projectSlug");
      return path.join(workspace, "projects", scope.projectSlug, "chat");
    }
    case "effort": {
      if (!scope.projectSlug || !scope.effortSlug) {
        throw new Error("effort scope requires projectSlug + effortSlug");
      }
      return path.join(workspace, "projects", scope.projectSlug, "efforts", scope.effortSlug, "chat");
    }
  }
}

/** Per-conversation entry inside `.index.json`. */
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
  /**
   * v0.18 — Discord-style threads.
   *
   * When set, this conversation is a CHILD thread of `parentConversationId`.
   * The SPA sidebar renders threads nested under their parent (a tree view
   * rather than a flat list), so the user can fork a side-discussion from
   * any point in the parent conversation without it polluting the main
   * stream OR vanishing into a separate top-level chat.
   *
   * `parentConversationId` MUST point to a conversation in the SAME scope.
   * (Cross-scope parenting would require touching the `.index.json` of two
   * directories per write — out of scope for v0.18.)
   *
   * Top-level conversations leave this `undefined`; the loader treats
   * `undefined` parent as "render at root level" so legacy index files
   * continue to work without migration.
   */
  parentConversationId?: string;
  /**
   * v0.18 — the bubble index in the parent conversation that this thread
   * was forked off of. The SPA renders a small "💬 N replies" affordance
   * next to that bubble in the parent view, and the thread itself shows
   * a "forked from <parent>: <quoted snippet>" header.
   *
   * Undefined when the thread was created without a specific anchor
   * (e.g. via `+ New thread` button on the parent — no specific bubble),
   * in which case the SPA renders the thread as a generic child without
   * an anchor pill.
   *
   * Independent of `parentConversationId`: a thread MAY have a parent
   * without an anchor, but MAY NOT have an anchor without a parent
   * (the loader normalises that case by clearing the orphan anchor).
   */
  anchorBubbleIdx?: number;
  /**
   * v0.18 — optional one-line description shown when hovering over a
   * thread in the sidebar. The SPA uses `title` as the primary label, but
   * `description` can carry e.g. the quoted snippet of the anchor bubble
   * so the user remembers what the thread is about without opening it.
   *
   * Undefined when not set; the SPA falls back to the bubble at
   * `anchorBubbleIdx` (if any) or just shows the title alone.
   */
  threadDescription?: string;
}

/** Shape of `.index.json`. */
interface ScopeIndex {
  conversations: Record<string, ConversationMeta>;
}

async function readIndex(dir: string): Promise<ScopeIndex> {
  try {
    const raw = await fs.readFile(path.join(dir, ".index.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.conversations) {
      return parsed as ScopeIndex;
    }
  } catch {
    /* fall through to empty index */
  }
  return { conversations: {} };
}

async function writeIndex(dir: string, idx: ScopeIndex): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  // 2026-06-25 audit E7 — atomic write via tmp+rename so a crash mid-write
  // doesn't leave a truncated/empty .index.json that breaks future loads.
  // (read-modify-write race between concurrent flush() calls is still
  // possible — the in-process per-dir lock below serialises them.)
  const finalPath = path.join(dir, ".index.json");
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(idx, null, 2), "utf-8");
  await fs.rename(tmpPath, finalPath);
}

// In-process per-key file lock — chains operations so concurrent
// read-modify-write cycles against the same disk file can't tear each
// other. Used for `.index.json` (E7), annotations sidecars (F3), and
// checkpoint index (G1). Exported so other modules that own their own
// RMW disk files can serialise the same way without proliferating
// near-identical locks.
const fileLocks = new Map<string, Promise<void>>();
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Chain on the previous tail. If the prior caller rejected, swallow it
  // here — the caller already saw the error via its own promise. Without
  // this catch, the next acquirer would await a rejected promise, never
  // enter the try block, never release(), and the dir would deadlock
  // permanently for the rest of the process lifetime.
  const prev = (fileLocks.get(key) ?? Promise.resolve()).catch(() => undefined);
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  fileLocks.set(key, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === next) fileLocks.delete(key);
  }
}

// Backwards-compatible alias — earlier audit E7 used withIndexLock with the
// scope dir as the key. We keep the name for self-documenting call sites.
const withIndexLock = withFileLock;

function conversationFile(dir: string, conversationId: string): string {
  return path.join(dir, `${conversationId}.jsonl`);
}

// ─── Per-message annotations sidecar (v0.16 §2) ────────────────────────────────────
// Reactions / pin / note / reply-target live in a separate JSON file rather
// than inline in history so the LLM protocol stays clean (LLMMessage is a
// wire format; bolting on social metadata would poison it). Indexed by
// bubbleIdx — the SPA's renderer position — because:
//
//   1. The SPA already groups raw LLMMessages into renderable bubbles via
//      `historyToBubbles`. Keying by bubbleIdx means the SPA can talk to
//      the server without translating coordinates.
//   2. bubbleIdx is stable under our only mutating operation, /truncate.
//      We never reorder or insert mid-history.
//
// Truncate / rerun must drop annotations for bubbleIdx >= truncateFrom
// (those bubbles no longer exist) but preserve everything before, including
// the anchor user bubble itself.
export interface MessageAnnotation {
  /** emoji -> count. Single-user app, so values are 0 or 1, but we keep
   *  the shape future-proof in case multi-user lands. */
  reactions?: Record<string, number>;
  pinned?: boolean;
  /** Private user note pinned under the message. Replaces the "thread"
   *  concept for a single-user research tool — no separate conversation,
   *  just a margin scribble that survives reloads. */
  note?: string;
  /** When set on a user bubble, indicates which earlier bubble this prompt
   *  was a reply to. Used by the SPA to render the quoted preview + by the
   *  server to prepend a quote block to the prompt. */
  replyTo?: { bubbleIdx: number; snippet: string };
}

export interface ConversationAnnotations {
  version: 1;
  byBubbleIdx: Record<string, MessageAnnotation>;
  /** v0.16 §4: per-conversation UI state. Survives reload, conversation
   *  switch, and (eventually) cross-tab via the standard sidecar. Not
   *  pruned by truncate — these are user-preference scalars, not
   *  message-coordinate data. */
  uiState?: ConversationUiState;
  /** v0.16 §11: an `ask_user` round is paused waiting for the user's
   *  reply. The serve `/answer-ask` endpoint clears this slot once the
   *  reply lands; SPA / CLI list endpoints can surface a chip so the
   *  user knows a question is waiting after a tab reload. Pruning the
   *  history (truncate / rerun) drops it because the placeholder tool
   *  message it points at gets dropped too. */
  pendingAsk?: PendingAskAnnotation;
}

export interface PendingAskAnnotation {
  /** The question the model asked. Echoed back to the SPA so a tab
   *  re-opened after the SSE stream closed can still render the prompt. */
  question: string;
  /** Tool-call id of the placeholder `ask_user` tool message in history.
   *  The answer endpoint patches the placeholder's content to the reply
   *  before resuming the round. */
  callId: string;
  /** Mirrors `callId` for code paths that prefer the wire-protocol name. */
  toolCallId: string;
  /** Unix epoch ms at which the question was posed. Lets the SPA show
   *  a relative age ("asked 3 min ago") and lets ops alarms catch
   *  forgotten pending asks. */
  ts: number;
  /**
   * v0.19 Codex parity — the four structured fields the model can
   * supply via `ask_user({ options, default, timeoutSeconds, allowCustom })`.
   * Persisted on the sidecar so a tab reload after the original SSE
   * stream closed can still render the button list + countdown + hint.
   * All optional; legacy pending asks (pre-v0.19) load with these
   * fields undefined and the SPA falls back to the plain textarea.
   */
  options?: string[];
  default?: string;
  timeoutSeconds?: number;
  allowCustom?: boolean;
  /**
   * v0.19 — unix epoch ms by which the server's auto-resolve timeout
   * fires. Recorded so the SPA can render a live countdown and so an
   * answer arriving after this timestamp (race) can be detected.
   * Only set when `timeoutSeconds` was supplied.
   */
  timeoutAt?: number;
}

export interface ConversationUiState {
  /** Last known scroll position in the chat scroller, in pixels from top.
   *  Restored on conversation switch. We persist *raw* pixels (not a %)
   *  because content reflow on reload is small for a stable history. */
  scrollTop?: number;
  /** Tool-call ids the user has explicitly expanded. Stored as a list
   *  rather than a Set because JSON doesn't have Set. */
  expandedToolCallIds?: string[];
  /** Whether the pinned-only filter was on when the conversation was
   *  last viewed. Persisted so a research session resumes with the same
   *  filter applied. */
  showPinnedOnly?: boolean;
}

function annotationsFile(dir: string, conversationId: string): string {
  return path.join(dir, "annotations", `${conversationId}.json`);
}

export async function loadAnnotations(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
): Promise<ConversationAnnotations> {
  const file = annotationsFile(scopeDir(workspace, scope), conversationId);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as ConversationAnnotations;
    if (parsed && typeof parsed === "object" && parsed.byBubbleIdx) {
      // v0.16 §11: preserve every top-level sidecar field, not just
      // `byBubbleIdx`. The original load implementation dropped `uiState`
      // and would have dropped any new sibling we add (pendingAsk). We
      // pick the known fields explicitly so a malformed extra key (e.g.
      // half-written by a future migration) never leaks back into save.
      const out: ConversationAnnotations = {
        version: 1,
        byBubbleIdx: parsed.byBubbleIdx,
      };
      if (parsed.uiState && typeof parsed.uiState === "object") {
        out.uiState = parsed.uiState;
      }
      if (parsed.pendingAsk && typeof parsed.pendingAsk === "object") {
        const pa = parsed.pendingAsk;
        // Defensive shape check — a corrupted sidecar shouldn't take down
        // the conversation; we just drop the bad slot.
        if (
          typeof pa.question === "string" &&
          typeof pa.callId === "string" &&
          typeof pa.toolCallId === "string" &&
          typeof pa.ts === "number"
        ) {
          // v0.19 Codex parity — round-trip the new structured fields
          // when present and well-typed. We rebuild the object
          // explicitly so a corrupted extra key on disk never leaks
          // back into save. Each field is also shape-checked
          // individually: bogus types are silently dropped rather than
          // tainting the in-memory model the SPA renders.
          const restored: PendingAskAnnotation = {
            question: pa.question,
            callId: pa.callId,
            toolCallId: pa.toolCallId,
            ts: pa.ts,
          };
          if (
            Array.isArray((pa as { options?: unknown }).options) &&
            ((pa as { options: unknown[] }).options as unknown[]).every(
              (x) => typeof x === "string",
            )
          ) {
            restored.options = (pa as { options: string[] }).options;
          }
          if (typeof (pa as { default?: unknown }).default === "string") {
            restored.default = (pa as { default: string }).default;
          }
          if (
            typeof (pa as { timeoutSeconds?: unknown }).timeoutSeconds ===
              "number" &&
            Number.isFinite(
              (pa as { timeoutSeconds: number }).timeoutSeconds,
            ) &&
            (pa as { timeoutSeconds: number }).timeoutSeconds > 0
          ) {
            restored.timeoutSeconds = (pa as {
              timeoutSeconds: number;
            }).timeoutSeconds;
          }
          if (typeof (pa as { allowCustom?: unknown }).allowCustom === "boolean") {
            restored.allowCustom = (pa as { allowCustom: boolean }).allowCustom;
          }
          if (
            typeof (pa as { timeoutAt?: unknown }).timeoutAt === "number" &&
            Number.isFinite((pa as { timeoutAt: number }).timeoutAt)
          ) {
            restored.timeoutAt = (pa as { timeoutAt: number }).timeoutAt;
          }
          out.pendingAsk = restored;
        }
      }
      return out;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { version: 1, byBubbleIdx: {} };
}

export async function saveAnnotations(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
  data: ConversationAnnotations,
): Promise<void> {
  const dir = path.join(scopeDir(workspace, scope), "annotations");
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(
    annotationsFile(scopeDir(workspace, scope), conversationId),
    JSON.stringify(data, null, 2),
  );
}

/**
 * 2026-06-25 audit F3 — atomic read-modify-write on the annotations
 * sidecar. Two concurrent PATCH annotations / POST react requests for
 * the same conv would both load -> mutate -> save and the second writer
 * would clobber the first. Wrap in an in-process per-file lock keyed on
 * the sidecar path so the modify is serialised.
 */
export async function mutateAnnotations(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
  mutator: (current: ConversationAnnotations) => ConversationAnnotations | Promise<ConversationAnnotations>,
): Promise<ConversationAnnotations> {
  const file = annotationsFile(scopeDir(workspace, scope), conversationId);
  return await withFileLock(file, async () => {
    const current = await loadAnnotations(workspace, scope, conversationId);
    const next = await mutator(current);
    await saveAnnotations(workspace, scope, conversationId, next);
    return next;
  });
}

/**
 * Drop annotations for bubbleIdx >= `fromIdx`. Used by /truncate and /rerun
 * to keep the sidecar in sync with the now-shortened history. The anchor
 * bubble itself (fromIdx in mode="after", fromIdx in mode="include" only
 * when we delete it) is the caller's responsibility — pass the right
 * fromIdx for the semantics you want.
 */
export async function pruneAnnotationsFrom(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
  fromIdx: number,
): Promise<void> {
  // 2026-06-25 audit G3 — wrap the load → mutate → save in the same
  // per-file lock used by mutateAnnotations / PATCH /annotations. Without
  // it a concurrent PATCH could land between this prune's load and save
  // and get clobbered.
  const file = annotationsFile(scopeDir(workspace, scope), conversationId);
  await withFileLock(file, async () => {
    const current = await loadAnnotations(workspace, scope, conversationId);
    let changed = false;
    const next: Record<string, MessageAnnotation> = {};
    for (const [k, v] of Object.entries(current.byBubbleIdx)) {
      if (Number(k) < fromIdx) next[k] = v;
      else changed = true;
    }
    // v0.16 §11: a `pendingAsk` points at a placeholder tool message in the
    // soon-to-be-truncated tail of history; once that message is gone the
    // pending slot is meaningless. Drop it on any prune so reload doesn't
    // resurrect a question whose tool-call no longer exists.
    const droppingPendingAsk = Boolean(current.pendingAsk);
    if (changed || droppingPendingAsk) {
      const saved: ConversationAnnotations = {
        version: 1,
        byBubbleIdx: next,
      };
      // Preserve uiState across prune — it's coordinate-free user prefs,
      // not message data.
      if (current.uiState) saved.uiState = current.uiState;
      await saveAnnotations(workspace, scope, conversationId, saved);
    }
  });
}

/**
 * Public path resolver for a (scope, conversationId) jsonl. Exposed so the
 * goal runner (and any future caller that needs the on-disk location for
 * audit / migration / debugging) can compute the same path the store uses
 * without recreating the layout rules.
 */
export function conversationFilePath(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
): string {
  return conversationFile(scopeDir(workspace, scope), conversationId);
}

/**
 * Flatten a single message's ContentPart[] (vision payload) down to a plain
 * string for disk persistence. We DO NOT persist base64 image bytes:
 *
 *   - the upload itself is already saved under `<workspace>/.mathran/uploads/`
 *     and the renderer marker can point back to it,
 *   - inlining the same image bytes in every persisted message would
 *     quadruple disk usage on a long thread,
 *   - on reload we don't need the bytes — the SPA shows the prior user
 *     turn from history and any re-send goes through chat-attachments again.
 *
 * The flattened form mirrors the legacy `[Image: <mime>]` text marker so a
 * future model that re-reads the persisted thread still sees "image happened
 * here" instead of nothing. Text parts are joined with `\n\n`.
 */
function flattenContentForPersist(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const p of content) {
    if (p && typeof p === "object") {
      if ((p as any).type === "text" && typeof (p as any).text === "string") {
        out.push((p as any).text);
      } else if ((p as any).type === "image") {
        const mime = typeof (p as any).mimeType === "string" ? (p as any).mimeType : "unknown";
        out.push(`[Image: ${mime}]`);
      }
    }
  }
  return out.join("\n\n");
}

/** Persist the full message history of a session as one `.jsonl` file. */
async function flushSession(dir: string, conversationId: string, history: LLMMessage[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  // C-round Commit 4 vision: ContentPart[] (image base64) is flattened to a
  // text marker before serialization — we never persist base64 image bytes
  // (the uploads dir already has the file).
  const flattened = history.map((m) => ({ ...m, content: flattenContentForPersist(m.content) }));
  const lines = flattened.map((m) => JSON.stringify(m)).join("\n");
  await atomicWriteFile(conversationFile(dir, conversationId), lines + (lines.length > 0 ? "\n" : ""));
}

/**
 * Write a Markdown view of the same conversation under a `transcripts/`
 * subdirectory. The Markdown is derived from the jsonl; it is overwritten
 * end-to-end on every flush and never read back, so it can be edited or
 * deleted without affecting replay.
 */
async function flushTranscript(
  dir: string,
  conversationId: string,
  history: LLMMessage[],
  meta: { scope: ChatScope; title?: string },
): Promise<void> {
  const transcriptsDir = path.join(dir, "transcripts");
  await fs.mkdir(transcriptsDir, { recursive: true });
  const scopeLabel =
    meta.scope.kind === "global"
      ? "global"
      : meta.scope.kind === "project"
      ? `project / ${meta.scope.projectSlug}`
      : `effort / ${meta.scope.projectSlug} / ${meta.scope.effortSlug}`;
  const md = renderTranscriptMarkdown(history, {
    scopeLabel,
    conversationId,
    title: meta.title,
  });
  await atomicWriteFile(
    path.join(transcriptsDir, `${conversationId}.md`),
    md + (md.endsWith("\n") ? "" : "\n"),
  );
}

/**
 * Reusable conversation persistence helpers (v0.2 §10).
 *
 * Both `ScopedChatSessionStore` (chat REPL / `serve`) and `GoalRunner`
 * persist a stream of `LLMMessage`s scoped by (ChatScope, conversationId).
 * Before §10 the goal runner duplicated the jsonl read/write inline, which
 * meant it skipped atomic-write + the `.index.json` directory + the
 * Markdown transcript that the chat store maintains. These two thin
 * functions are the single source of truth — `ScopedChatSessionStore`
 * delegates to them internally too (see below).
 *
 * Path layout is identical to the chat store, so existing
 * `<workspace>/.mathran/global-chat/<id>.jsonl` (or project / effort dirs)
 * files keep working unchanged — no migration required.
 */

/**
 * Load a conversation's history from disk for the given scope. Returns an
 * empty array if there is no file yet, matching the runner's previous
 * "start a fresh conversation" semantics.
 */
export async function loadConversationHistory(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
): Promise<LLMMessage[]> {
  const out = await loadHistory(scopeDir(workspace, scope), conversationId);
  return out ?? [];
}

/**
 * Persist a conversation's full message history for the given scope. Performs
 * the same three writes the chat store does after every `send()`:
 *   - atomic write of the `.jsonl` (via `atomic-write.ts`),
 *   - update of the per-scope `.index.json` (title / lastUsedAt / count),
 *   - render of a Markdown transcript next to the jsonl.
 * The transcript write is best-effort and never fails the call.
 */
export async function flushConversationHistory(
  workspace: string,
  scope: ChatScope,
  conversationId: string,
  history: LLMMessage[],
  opts?: { title?: string },
): Promise<void> {
  const dir = scopeDir(workspace, scope);
  // 2026-06-25 audit E7 + H5 — serialise both the jsonl write AND the
  // .index.json read-modify-write per conv. Two concurrent flushes to
  // the same conv with different history snapshots would otherwise
  // atomic-write each independently → last write wins → first snapshot
  // lost. Per-conv key so sibling convs in the same scope can still
  // flush in parallel (only their respective jsonls; the index lock is
  // per-dir below to serialise the index RMW).
  const jsonlFile = conversationFile(dir, conversationId);
  await withFileLock(jsonlFile, async () => {
    await flushSession(dir, conversationId, history);
  });
  await withIndexLock(dir, async () => {
    const idx = await readIndex(dir);
    const now = new Date().toISOString();
    const existing = idx.conversations[conversationId];
    const resolvedTitle = existing?.title ?? opts?.title ?? deriveTitle(history);
    idx.conversations[conversationId] = {
      id: conversationId,
      title: resolvedTitle,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      messageCount: history.length,
      // v0.18 — preserve thread linkage on every flush. Without this the
      // first send() in a freshly-created thread would wipe the parent
      // pointer because flushConversationHistory rebuilds the meta from
      // scratch using only the title-derivation inputs.
      ...(existing?.parentConversationId !== undefined && {
        parentConversationId: existing.parentConversationId,
      }),
      ...(existing?.anchorBubbleIdx !== undefined && {
        anchorBubbleIdx: existing.anchorBubbleIdx,
      }),
      ...(existing?.threadDescription !== undefined && {
        threadDescription: existing.threadDescription,
      }),
    };
    await writeIndex(dir, idx);
    try {
      await flushTranscript(dir, conversationId, history, { scope, title: resolvedTitle });
    } catch {
      /* transcript is best-effort */
    }
  });
}

/** Lazy-load a conversation's history from disk. Returns null if no file. */
async function loadHistory(dir: string, conversationId: string): Promise<LLMMessage[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(conversationFile(dir, conversationId), "utf-8");
  } catch {
    return null;
  }
  const out: LLMMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as LLMMessage);
    } catch {
      // Skip malformed lines rather than failing the whole load.
      continue;
    }
  }
  return out;
}

/** Factory provided by the server: builds a fresh `ChatSession` for a scope. */
export type ScopedChatSessionFactory = (args: {
  scope: ChatScope;
  model?: string;
  /** v0.17 W12 — conversation id, passed so the factory can construct
   *  per-conversation tools (e.g. `todo_write`) that persist to a file
   *  keyed by conversationId. Older factories may ignore this field. */
  conversationId?: string;
  /** v0.17 P2 — optional fire-and-forget goal-kickoff hook forwarded to
   *  the `propose_goal` builtin tool. Older factories may ignore. */
  autoRunGoal?: (goalId: string, userMessage: string) => void;
  /** v0.17 P2 — optional fire-and-forget plan-kickoff hook forwarded to
   *  the `propose_plan` builtin tool. Older factories may ignore. */
  autoRunPlan?: (planId: string, objective: string) => void;
}) => ChatSession;

interface SessionEntry {
  scope: ChatScope;
  conversationId: string;
  session: ChatSession;
  lastUsedMs: number;
  model?: string;
  /**
   * 2026-06-30 — Channels v1: when the session subscribes to the channel
   * registry, the registry hands back an unsubscribe callback. The store
   * stashes it here so `evictOne` / `drop` can invoke it before
   * discarding the entry, preventing the registry from holding a dead
   * session reference. Optional because callers that don't wire channels
   * (CLI without server, tests) skip the subscription.
   */
  unsubscribeChannel?: () => void;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

/**
 * Scoped, disk-backed chat session store.
 *
 * One instance per running `buildApp()`; instances are safe to share between
 * `/api/global-chat` / `/api/projects/*​/chat` / `/api/projects/*​/effort/*​/chat`
 * handlers because the (scope, conversationId) tuple disambiguates everything.
 */
export class ScopedChatSessionStore {
  private readonly entries = new Map<string, SessionEntry>();
  /**
   * Per-session eviction lock (v0.3 §20). Keyed by `cacheKey(scope, cid)`.
   *
   * Without this, concurrent evictions of the *same* session can race:
   *   - evictor A awaits `flushSession(K)`,
   *   - evictor B sees the entry still present, also calls `flushSession(K)`,
   *   - one of them deletes the entry mid-flush of the other.
   *
   * The lock is per-key so two *different* sessions still evict in parallel.
   * It does NOT block reads (`getOrCreate` for a hot, non-evicting key) — only
   * other evictions of the same key.
   */
  private readonly evictionLocks = new Map<string, Promise<void>>();
  /**
   * 2026-06-30 — Channels v1 wiring. Optional channel registry the
   * store uses to subscribe / unsubscribe each cached session at its
   * lifecycle boundaries. Stored as a generic `register` callback (not
   * a hard `ChannelRegistry` type) to avoid coupling store.ts to the
   * channels module — the registry interface is duck-typed on
   * `register({sessionId, deliver}) => unsubscribe`. When unset (the
   * default for CLI / tests), all channel hooks are no-ops.
   */
  private readonly channelRegistry?: {
    register: (sub: {
      sessionId: string;
      deliver: (m: { content: string; source: string; role?: "user" }) => void;
    }) => () => void;
  };

  constructor(
    private readonly workspace: string,
    private readonly factory: ScopedChatSessionFactory,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    /**
     * Optional channel registry. Pass `getGlobalChannelRegistry()` from
     * `src/core/channels/` here in serve mode so MCP pushes route into
     * live sessions. CLI / tests pass `undefined` and channels stay
     * dormant.
     */
    channelRegistry?: {
      register: (sub: {
        sessionId: string;
        deliver: (m: { content: string; source: string; role?: "user" }) => void;
      }) => () => void;
    },
  ) {
    if (channelRegistry) this.channelRegistry = channelRegistry;
  }

  /** Expose the workspace root so route handlers can pass it into the
   *  annotations helpers without having to thread it through every layer
   *  separately. (v0.16 §2) */
  getWorkspace(): string {
    return this.workspace;
  }

  private cacheKey(scope: ChatScope, conversationId: string): string {
    return `${scopeKey(scope)}::${conversationId}`;
  }

  /**
   * Acquire the eviction lock for `key`. Returns a release fn the caller MUST
   * invoke in a `finally` block.
   *
   * Multiple awaiters on the same key are serialized (each waits for the
   * previous holder's promise to resolve before installing its own).
   */
  private async acquireEvictionLock(key: string): Promise<() => void> {
    while (this.evictionLocks.has(key)) {
      await this.evictionLocks.get(key);
    }
    let release!: () => void;
    const p = new Promise<void>((res) => {
      release = res;
    });
    this.evictionLocks.set(key, p);
    return () => {
      this.evictionLocks.delete(key);
      release();
    };
  }

  /**
   * Evict a single cached session by `key`, awaiting any pending flush first
   * so the latest in-memory history is durably on disk before the cache entry
   * disappears (v0.3 §20).
   *
   * Concurrent calls for the same key de-dupe via the per-session lock: the
   * second caller observes the entry already gone and returns without re-
   * flushing.
   */
  private async evictOne(key: string): Promise<void> {
    const release = await this.acquireEvictionLock(key);
    try {
      const entry = this.entries.get(key);
      if (!entry) return; // already evicted by a concurrent caller
      // 2026-06-30 — Channels v1: detach the session from the channel
      // registry BEFORE flush so a push that arrives mid-eviction goes
      // to broadcast (or is dropped if no other live sub) rather than a
      // stale session about to be discarded.
      try {
        entry.unsubscribeChannel?.();
      } catch {
        /* best-effort — never block eviction on registry detach */
      }
      // Persist the latest history before dropping the cache entry. We use the
      // shared persistence helper so chat + goal stay on identical layout.
      await flushConversationHistory(
        this.workspace,
        entry.scope,
        entry.conversationId,
        entry.session.history(),
      );
      this.entries.delete(key);
    } finally {
      release();
    }
  }

  /**
   * Get a session for (scope, conversationId), hydrating from disk if needed.
   * Brand new conversations (no jsonl, no index entry) are created on first call.
   */
  async getOrCreate(
    scope: ChatScope,
    conversationId: string,
    model: string | undefined,
  ): Promise<ChatSession> {
    await this.evictExpired();
    const key = this.cacheKey(scope, conversationId);
    const cached = this.entries.get(key);
    if (cached) {
      cached.lastUsedMs = Date.now();
      return cached.session;
    }
    if (this.entries.size >= this.maxEntries) await this.evictLRU();

    const dir = scopeDir(this.workspace, scope);
    const session = this.factory({ scope, model, conversationId });
    const history = await loadHistory(dir, conversationId);
    if (history && history.length > 0) {
      // Replay each message via the kernel's `replayHistory` hook so the
      // ChatSession's internal `messages` matches what's on disk verbatim.
      session.replaceHistory(history);
    }
    // 2026-06-30 — Channels v1: subscribe this freshly-created session
    // to the channel registry (if wired). The returned unsubscribe is
    // stashed on the entry so evictOne / drop can call it before the
    // session leaves the cache.
    let unsubscribeChannel: (() => void) | undefined;
    if (this.channelRegistry) {
      try {
        unsubscribeChannel = session.subscribeToChannels(
          this.channelRegistry,
          conversationId,
        );
      } catch {
        /* best-effort — failed subscribe shouldn't block session creation */
      }
    }
    this.entries.set(key, {
      scope,
      conversationId,
      session,
      lastUsedMs: Date.now(),
      ...(model !== undefined ? { model } : {}),
      ...(unsubscribeChannel !== undefined ? { unsubscribeChannel } : {}),
    });
    return session;
  }

  /**
   * Persist a session's full history to disk + update the scope index entry.
   * Call this after each `send()` completes.
   *
   * Side effect (GAP #13): also rewrites a human-readable Markdown transcript
   * to `transcripts/<conversationId>.md` next to the jsonl file. The Markdown
   * is a derived view — always overwritten end-to-end, never read back.
   */
  async flush(scope: ChatScope, conversationId: string, title?: string): Promise<void> {
    const key = this.cacheKey(scope, conversationId);
    const entry = this.entries.get(key);
    if (!entry) return;
    // Delegate to the shared persistence helpers (v0.2 §10) so chat + goal
    // can never drift on jsonl layout, index format, or transcript shape.
    // The index lock is inside flushConversationHistory (audit E7), so we
    // don't need to re-wrap here.
    await flushConversationHistory(
      this.workspace,
      scope,
      conversationId,
      entry.session.history(),
      title !== undefined ? { title } : undefined,
    );
  }

  /** Drop a conversation: cache + disk file + index entry. */
  async drop(scope: ChatScope, conversationId: string): Promise<boolean> {
    const key = this.cacheKey(scope, conversationId);
    // 2026-06-30 — Channels v1: unsubscribe the live session (if any)
    // from the channel registry BEFORE deleting it from the cache.
    // Otherwise the registry continues to deliver pushes into a session
    // that's about to be GC'd, and the LLM would see stale message
    // injection if any history is still around in memory.
    const existing = this.entries.get(key);
    if (existing) {
      try {
        existing.unsubscribeChannel?.();
      } catch {
        /* best-effort */
      }
    }
    const hadCache = this.entries.delete(key);
    const dir = scopeDir(this.workspace, scope);
    let hadFile = false;
    try {
      await fs.unlink(conversationFile(dir, conversationId));
      hadFile = true;
    } catch {
      /* no file */
    }
    // 2026-06-25 audit E7 — same lock so a flush that's concurrent with
    // this drop can't re-introduce the just-dropped index entry.
    const hadIndex = await withIndexLock(dir, async () => {
      const idx = await readIndex(dir);
      const had = conversationId in idx.conversations;
      if (had) {
        delete idx.conversations[conversationId];
        await writeIndex(dir, idx);
      }
      return had;
    });
    // /diff + rewind: best-effort cleanup of this conversation's checkpoint
    // bucket so deleting a thread doesn't leak its snapshot cache.
    try {
      await deleteConversationCheckpoints(this.workspace, conversationId);
    } catch {
      /* advisory cache — never block a delete on it */
    }
    return hadCache || hadFile || hadIndex;
  }

  /** Enumerate conversations in a scope (reads the index from disk every time). */
  async listConversations(scope: ChatScope): Promise<ConversationMeta[]> {
    const dir = scopeDir(this.workspace, scope);
    const idx = await readIndex(dir);
    return Object.values(idx.conversations).sort(
      (a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt),
    );
  }

  /**
   * v0.18 — idempotent: link an existing conversation to a parent (set
   * parentConversationId / anchorBubbleIdx in its index entry). The
   * conversation MAY not yet exist on disk — we create a stub entry so
   * the link is recorded even before the first send().
   *
   * Unlike `createThread`, this does NOT mint a new id — caller supplies
   * the conversationId. This is the hook the goal runner uses to register
   * sub-goal conversations as threads of their parent goal's conversation
   * AFTER both ids already exist (sub-goal-tool created the sub-goal
   * record, runner attached a conversationId; we now retroactively mark
   * the linkage on the chat-side index).
   *
   * Same scope as the parent. Cross-scope linkage rejected for the same
   * reason as createThread.
   *
   * No-op when the conversation already has the EXACT same parent +
   * anchor (we re-flush parent's lastUsedAt regardless, so the sidebar
   * sort still surfaces the activity).
   *
   * Static because it only touches index.json — no need for the cache /
   * eviction lock state the instance carries. Lets the goal runner call
   * it without having to thread a ScopedChatSessionStore (and its factory)
   * through every code path.
   */
  static async linkConversationToParent(
    workspace: string,
    scope: ChatScope,
    conversationId: string,
    parentConversationId: string,
    opts?: { anchorBubbleIdx?: number; threadDescription?: string },
  ): Promise<void> {
    if (conversationId === parentConversationId) {
      throw new Error(
        `linkConversationToParent: refusing to make ${conversationId} a thread of itself.`,
      );
    }
    const dir = scopeDir(workspace, scope);
    const idx = await readIndex(dir);
    const parent = idx.conversations[parentConversationId];
    if (!parent) {
      throw new Error(
        `linkConversationToParent: parent conversation ${parentConversationId} not found in this scope.`,
      );
    }
    const now = new Date().toISOString();
    const existing = idx.conversations[conversationId];
    if (existing) {
      const sameLink =
        existing.parentConversationId === parentConversationId &&
        existing.anchorBubbleIdx === opts?.anchorBubbleIdx;
      if (sameLink) {
        idx.conversations[parentConversationId] = { ...parent, lastUsedAt: now };
        await writeIndex(dir, idx);
        return;
      }
      idx.conversations[conversationId] = {
        ...existing,
        parentConversationId,
        ...(typeof opts?.anchorBubbleIdx === "number" && {
          anchorBubbleIdx: opts.anchorBubbleIdx,
        }),
        ...(opts?.threadDescription && { threadDescription: opts.threadDescription }),
      };
    } else {
      idx.conversations[conversationId] = {
        id: conversationId,
        title: opts?.threadDescription
          ? opts.threadDescription.slice(0, 60)
          : `Sub-thread of ${(parent.title || parent.id).slice(0, 40)}`,
        createdAt: now,
        lastUsedAt: now,
        messageCount: 0,
        parentConversationId,
        ...(typeof opts?.anchorBubbleIdx === "number" && {
          anchorBubbleIdx: opts.anchorBubbleIdx,
        }),
        ...(opts?.threadDescription && { threadDescription: opts.threadDescription }),
      };
    }
    idx.conversations[parentConversationId] = { ...parent, lastUsedAt: now };
    await writeIndex(dir, idx);
  }

  /**
   * v0.18 — Create a CHILD thread conversation parented at `parentId`.
   *
   * Discord-style: the thread is a sibling .jsonl file in the same scope
   * directory, but its `.index.json` entry carries `parentConversationId`
   * (and optionally `anchorBubbleIdx`) so the SPA renders it nested under
   * the parent rather than at root level.
   *
   * Validation:
   *   - The parent must exist in this scope's index. We reject silently
   *     with `{ok: false}` shape via a thrown Error to keep the chat-tool
   *     surface honest (no silent linkage corruption).
   *   - Cross-scope parenting is rejected: caller must be in the same
   *     scope.
   *   - Nesting depth is NOT bounded server-side; the SPA caps display
   *     depth at 3 (parent / thread / sub-thread) and renders deeper
   *     children inline at depth 3. The server records the true depth
   *     so a future SPA can render arbitrarily deep if desired.
   *
   * Side effects:
   *   - Writes a NEW entry into `.index.json`.
   *   - Does NOT create the `.jsonl` file yet — that happens on the first
   *     `send()` to the thread, same as every other new conversation.
   *   - Bumps the parent's `lastUsedAt` so the parent's sidebar position
   *     reflects "there's recent activity (as a child thread)".
   *
   * Returns the new ConversationMeta entry (with the freshly-minted id).
   */
  async createThread(
    scope: ChatScope,
    parentId: string,
    opts?: {
      anchorBubbleIdx?: number;
      title?: string;
      threadDescription?: string;
    },
  ): Promise<ConversationMeta> {
    const dir = scopeDir(this.workspace, scope);
    const idx = await readIndex(dir);

    const parent = idx.conversations[parentId];
    if (!parent) {
      throw new Error(
        `createThread: parent conversation ${parentId} not found in this scope. ` +
          "Cross-scope parenting is not supported — caller must be in the same scope.",
      );
    }

    const now = new Date().toISOString();
    const id = ScopedChatSessionStore.newConversationId();

    // Default title: "⤳ thread" + optionally the bubble idx the user
    // forked from. The user can rename later via the rename tool / SPA.
    let defaultTitle: string;
    if (opts?.title && opts.title.trim().length > 0) {
      defaultTitle = opts.title.trim();
    } else if (typeof opts?.anchorBubbleIdx === "number") {
      defaultTitle = `Thread on #${opts.anchorBubbleIdx}`;
    } else {
      defaultTitle = `Thread of "${(parent.title || parent.id).slice(0, 40)}"`;
    }

    const newMeta: ConversationMeta = {
      id,
      title: defaultTitle,
      createdAt: now,
      lastUsedAt: now,
      messageCount: 0,
      parentConversationId: parentId,
      ...(typeof opts?.anchorBubbleIdx === "number" && {
        anchorBubbleIdx: opts.anchorBubbleIdx,
      }),
      ...(opts?.threadDescription && {
        threadDescription: opts.threadDescription,
      }),
    };
    idx.conversations[id] = newMeta;

    // Bump parent's lastUsedAt so sidebar's root-level sort surfaces the
    // "this conversation had activity (a new thread)" signal.
    idx.conversations[parentId] = {
      ...parent,
      lastUsedAt: now,
    };

    await writeIndex(dir, idx);
    return newMeta;
  }

  /** Read a conversation's history off disk. Returns null if no file. */
  async readHistory(scope: ChatScope, conversationId: string): Promise<LLMMessage[] | null> {
    return loadHistory(scopeDir(this.workspace, scope), conversationId);
  }

  /**
   * Peek the live in-memory history for a cached session (does NOT touch
   * lastUsedMs / LRU order). Returns null when no entry is cached.
   *
   * Used by `/usage` so the context-window meter reflects the *live* state
   * during an SSE stream (history flush only happens after the stream ends).
   */
  peekLiveHistory(scope: ChatScope, conversationId: string): LLMMessage[] | null {
    const entry = this.entries.get(this.cacheKey(scope, conversationId));
    return entry ? entry.session.history() : null;
  }

  /** Create a fresh conversation id. */
  static newConversationId(): string {
    return `c-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
  }

  /**
   * Drop all entries whose `lastUsedMs` is older than the TTL window.
   *
   * Each candidate is evicted via `evictOne`, which awaits its pending flush
   * before removing the cache entry. Different keys evict in parallel; the
   * per-session lock only serializes concurrent evictions of the *same* key.
   * (v0.3 §20)
   */
  private async evictExpired(): Promise<void> {
    const cutoff = Date.now() - this.ttlMs;
    const stale: string[] = [];
    for (const [k, v] of this.entries) {
      if (v.lastUsedMs < cutoff) stale.push(k);
    }
    if (stale.length === 0) return;
    await Promise.all(stale.map((k) => this.evictOne(k)));
  }

  /**
   * Drop the single least-recently-used entry to make room for a new one.
   *
   * The drop awaits the entry's pending flush before deleting it from the
   * cache, so the most recent in-memory turn is durably on disk before the
   * `ChatSession` becomes unreferenced. (v0.3 §20)
   */
  private async evictLRU(): Promise<void> {
    let oldestKey: string | undefined;
    let oldestMs = Infinity;
    for (const [k, v] of this.entries) {
      if (v.lastUsedMs < oldestMs) {
        oldestMs = v.lastUsedMs;
        oldestKey = k;
      }
    }
    if (oldestKey) await this.evictOne(oldestKey);
  }

  /**
   * Test-only helper (v0.3 §20): force-evict a single key, awaiting flush.
   * Production callers should rely on `getOrCreate` to trigger eviction
   * automatically; tests use this to drive the race scenarios deterministically.
   *
   * @internal
   */
  async _forceEvictForTesting(scope: ChatScope, conversationId: string): Promise<void> {
    await this.evictOne(this.cacheKey(scope, conversationId));
  }
}

/** Pick the first user message as a conversation title (truncated to 80 chars). */
function deriveTitle(history: LLMMessage[]): string {
  const first = history.find((m) => m.role === "user");
  if (!first) return "New chat";
  const text = typeof first.content === "string" ? first.content : "";
  const trimmed = text.trim().split("\n")[0];
  if (trimmed.length === 0) return "New chat";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}
