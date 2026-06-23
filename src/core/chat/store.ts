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
  await fs.writeFile(path.join(dir, ".index.json"), JSON.stringify(idx, null, 2), "utf-8");
}

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
          out.pendingAsk = pa;
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
    // not message data. (Pre-v0.16 the old load impl stripped it on
    // read, which made this a no-op; now that we round-trip it we must
    // re-save it explicitly.)
    if (current.uiState) saved.uiState = current.uiState;
    await saveAnnotations(workspace, scope, conversationId, saved);
  }
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

/** Persist the full message history of a session as one `.jsonl` file. */
async function flushSession(dir: string, conversationId: string, history: LLMMessage[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const lines = history.map((m) => JSON.stringify(m)).join("\n");
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
  await flushSession(dir, conversationId, history);

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
  };
  await writeIndex(dir, idx);

  try {
    await flushTranscript(dir, conversationId, history, { scope, title: resolvedTitle });
  } catch {
    /* transcript is best-effort */
  }
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
  constructor(
    private readonly workspace: string,
    private readonly factory: ScopedChatSessionFactory,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

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
    this.entries.set(key, {
      scope,
      conversationId,
      session,
      lastUsedMs: Date.now(),
      model,
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
    const hadCache = this.entries.delete(key);
    const dir = scopeDir(this.workspace, scope);
    let hadFile = false;
    try {
      await fs.unlink(conversationFile(dir, conversationId));
      hadFile = true;
    } catch {
      /* no file */
    }
    const idx = await readIndex(dir);
    const hadIndex = conversationId in idx.conversations;
    if (hadIndex) {
      delete idx.conversations[conversationId];
      await writeIndex(dir, idx);
    }
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
  const trimmed = first.content.trim().split("\n")[0];
  if (trimmed.length === 0) return "New chat";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}
