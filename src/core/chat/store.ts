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

/** Persist the full message history of a session as one `.jsonl` file. */
async function flushSession(dir: string, conversationId: string, history: LLMMessage[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const lines = history.map((m) => JSON.stringify(m)).join("\n");
  await fs.writeFile(conversationFile(dir, conversationId), lines + (lines.length > 0 ? "\n" : ""), "utf-8");
}

/**
 * Render a chat history as a human-readable Markdown transcript and write it
 * next to the jsonl file under a `transcripts/` subdirectory (GAP #13).
 *
 * Why a separate file: jsonl is the source of truth for replay (lossless,
 * parseable), but users want a readable thread artifact too — to skim later,
 * paste into wiki by hand, or git-track. Each `flush()` rewrites the same
 * transcript file end-to-end so it always matches the underlying jsonl.
 *
 * The format is intentionally plain: `## role` headers, then content. Tool
 * calls and tool results are surfaced as fenced code blocks so the file is
 * still useful when you want to debug what a tool returned.
 */
function renderTranscriptMarkdown(
  history: LLMMessage[],
  meta: { scope: ChatScope; conversationId: string; title?: string },
): string {
  const out: string[] = [];
  const scopeLabel =
    meta.scope.kind === "global"
      ? "global"
      : meta.scope.kind === "project"
      ? `project / ${meta.scope.projectSlug}`
      : `effort / ${meta.scope.projectSlug} / ${meta.scope.effortSlug}`;
  out.push(`# ${meta.title?.trim() || `Chat ${meta.conversationId}`}`);
  out.push("");
  out.push(`> **Scope:** ${scopeLabel}`);
  out.push(`> **Conversation id:** \`${meta.conversationId}\``);
  out.push(`> **Saved at:** ${new Date().toISOString()}`);
  out.push("");
  out.push("---");
  out.push("");
  for (const m of history) {
    const role = m.role;
    if (role === "system") {
      out.push(`## system`);
      out.push("");
      out.push("<details><summary>system prompt</summary>");
      out.push("");
      out.push("```");
      out.push(m.content ?? "");
      out.push("```");
      out.push("");
      out.push("</details>");
      out.push("");
      continue;
    }
    out.push(`## ${role}`);
    out.push("");
    if (m.content && m.content.trim().length > 0) {
      out.push(m.content);
      out.push("");
    }
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      for (const call of m.toolCalls) {
        out.push(`**tool call:** \`${call.name}\` (id \`${call.id}\`)`);
        out.push("");
        out.push("```json");
        out.push(call.arguments);
        out.push("```");
        out.push("");
      }
    }
    if (role === "tool" && m.toolCallId) {
      out.push(`_tool result for \`${m.name ?? "?"}\` (id \`${m.toolCallId}\`)_`);
      out.push("");
    }
  }
  return out.join("\n");
}

async function flushTranscript(
  dir: string,
  conversationId: string,
  history: LLMMessage[],
  meta: { scope: ChatScope; title?: string },
): Promise<void> {
  const transcriptsDir = path.join(dir, "transcripts");
  await fs.mkdir(transcriptsDir, { recursive: true });
  const md = renderTranscriptMarkdown(history, {
    scope: meta.scope,
    conversationId,
    title: meta.title,
  });
  await fs.writeFile(
    path.join(transcriptsDir, `${conversationId}.md`),
    md + (md.endsWith("\n") ? "" : "\n"),
    "utf-8",
  );
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
  constructor(
    private readonly workspace: string,
    private readonly factory: ScopedChatSessionFactory,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  private cacheKey(scope: ChatScope, conversationId: string): string {
    return `${scopeKey(scope)}::${conversationId}`;
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
    this.evictExpired();
    const key = this.cacheKey(scope, conversationId);
    const cached = this.entries.get(key);
    if (cached) {
      cached.lastUsedMs = Date.now();
      return cached.session;
    }
    if (this.entries.size >= this.maxEntries) this.evictLRU();

    const dir = scopeDir(this.workspace, scope);
    const session = this.factory({ scope, model });
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
    const dir = scopeDir(this.workspace, scope);
    const history = entry.session.history();
    await flushSession(dir, conversationId, history);

    const idx = await readIndex(dir);
    const now = new Date().toISOString();
    const existing = idx.conversations[conversationId];
    const resolvedTitle = existing?.title ?? title ?? deriveTitle(history);
    idx.conversations[conversationId] = {
      id: conversationId,
      title: resolvedTitle,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      messageCount: history.length,
    };
    await writeIndex(dir, idx);

    // GAP #13: keep a Markdown transcript view next to the jsonl.
    try {
      await flushTranscript(dir, conversationId, history, { scope, title: resolvedTitle });
    } catch {
      // Transcript is a convenience; never fail flush() on it.
    }
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

  /** Create a fresh conversation id. */
  static newConversationId(): string {
    return `c-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.entries) {
      if (v.lastUsedMs < cutoff) this.entries.delete(k);
    }
  }

  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestMs = Infinity;
    for (const [k, v] of this.entries) {
      if (v.lastUsedMs < oldestMs) {
        oldestMs = v.lastUsedMs;
        oldestKey = k;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
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
