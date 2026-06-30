/**
 * Rewind logic (/rewind) — 5-mode restore aligned with Claude Code /rewind.
 *
 * The legacy mathran behaviour was a single "restore code" path. This module
 * generalises it to five restore modes (PLAN: Claude Code parity):
 *
 *   1. `code-and-conversation` — roll back files **and** truncate the chat
 *      jsonl to the message prefix that existed *before* the oldest selected
 *      checkpoint ran.
 *   2. `conversation-only`     — keep files as-is, only truncate the jsonl.
 *   3. `code-only`             — original behaviour: rewind files, keep jsonl.
 *      Default mode (preserves `/rewind <id>` semantics for existing scripts).
 *   4. `summarize-from-here`   — keep messages *up to* the checkpoint prefix
 *      intact, drop everything after, and append one summary system note.
 *   5. `summarize-up-to-here`  — replace the prefix with one summary system
 *      note and keep the tail (current focus) intact.
 *
 * Files are rolled back from the captured `before` snapshots:
 *   - `text`   → write the content back.
 *   - `absent` → delete the file (it didn't exist before).
 *   - `large`  → skipped (only a hash was kept; PLAN 大文件约束).
 *
 * Rewinding **never deletes checkpoints** — the forward history is preserved so
 * the user can rewind again (PLAN 重要约束). `/rewind <N>` rolls back the newest
 * N checkpoints; `/rewind <id>` rolls back every checkpoint from newest down to
 * and including that id (i.e. "rewind to the state before checkpoint <id>").
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../chat/atomic-write.js";

import {
  readCheckpoint,
  readCheckpointIndex,
} from "./store.js";
import {
  DEFAULT_RESTORE_MODE,
  isRestoreMode,
  type Checkpoint,
  type CheckpointIndexEntry,
  type RestoreMode,
} from "./schema.js";

export interface RewindFileResult {
  path: string;
  action: "restored" | "deleted" | "skipped";
  reason?: string;
}

/** Conversation-side effect a rewind produced (when mode touches messages). */
export interface RewindConversationResult {
  /** Messages in the jsonl before the rewind. */
  beforeCount: number;
  /** Messages in the jsonl after the rewind. */
  afterCount: number;
  /** Human label, e.g. "truncated", "summarized tail", "summarized head". */
  action:
    | "unchanged"
    | "truncated"
    | "summarized-tail"
    | "summarized-head"
    | "skipped";
  /** Reason for "skipped" (e.g. no `messageCountBefore` recorded). */
  reason?: string;
}

export interface RewindResult {
  /** Checkpoint ids that were rolled back (newest → oldest). */
  checkpointIds: string[];
  /** Restore mode actually applied. */
  mode: RestoreMode;
  files: RewindFileResult[];
  /** Conversation side-effect, when the mode touched the jsonl. */
  conversation?: RewindConversationResult;
}

/** Parsed `/rewind` argument. */
export type RewindTarget =
  | { kind: "list" }
  | { kind: "count"; n: number }
  | { kind: "id"; id: string }
  | { kind: "error"; message: string };

/**
 * Parsed full /rewind invocation: a target (list / count / id) + a restore
 * mode flag (default `code-only`).
 */
export type RewindArgs =
  | { kind: "error"; message: string }
  | { kind: "list" }
  | { kind: "count"; n: number; mode: RestoreMode }
  | { kind: "id"; id: string; mode: RestoreMode };

/** Parse a `/rewind` argument string into a target. */
export function parseRewindArg(arg: string): RewindTarget {
  const trimmed = arg.trim();
  if (!trimmed || trimmed === "list") return { kind: "list" };
  if (trimmed === "last") return { kind: "count", n: 1 };
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (n <= 0) return { kind: "error", message: "usage: /rewind <N> (N ≥ 1)" };
    return { kind: "count", n };
  }
  return { kind: "id", id: trimmed };
}

/**
 * Parse the full /rewind invocation, supporting an optional `--mode <mode>`
 * flag (5-mode restore). The flag is order-agnostic and may appear before or
 * after the target. Unknown modes / typos are surfaced as `error` so the host
 * can show a friendly usage line.
 *
 *   /rewind             → list
 *   /rewind 2           → count=2 mode=code-only (default)
 *   /rewind <id>        → id=<id> mode=code-only
 *   /rewind 2 --mode code-and-conversation
 *   /rewind --mode conversation-only last
 */
export function parseRewindArgs(arg: string): RewindArgs {
  const trimmed = arg.trim();
  if (!trimmed || trimmed === "list") return { kind: "list" };

  // Pull out --mode <value> | --mode=<value>; rest goes to target parser.
  const tokens = trimmed.split(/\s+/);
  let mode: RestoreMode = DEFAULT_RESTORE_MODE;
  let modeSeen = false;
  const targetTokens: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--mode" || t === "-m") {
      const val = tokens[i + 1];
      if (!val) {
        return {
          kind: "error",
          message:
            "usage: /rewind [<N>|<id>] [--mode <code-and-conversation|conversation-only|code-only|summarize-from-here|summarize-up-to-here>]",
        };
      }
      if (!isRestoreMode(val)) {
        return { kind: "error", message: `unknown --mode value '${val}'.` };
      }
      mode = val;
      modeSeen = true;
      i += 1;
      continue;
    }
    const eq = t.match(/^--mode=(.+)$/);
    if (eq) {
      const val = eq[1]!;
      if (!isRestoreMode(val)) {
        return { kind: "error", message: `unknown --mode value '${val}'.` };
      }
      mode = val;
      modeSeen = true;
      continue;
    }
    targetTokens.push(t);
  }

  const targetStr = targetTokens.join(" ");
  if (!targetStr) {
    // `/rewind --mode X` alone — interpret as list (we still need a target
    // to know what to roll back).
    return modeSeen ? { kind: "list" } : { kind: "list" };
  }
  const target = parseRewindArg(targetStr);
  if (target.kind === "error") return target;
  if (target.kind === "list") return { kind: "list" };
  if (target.kind === "count") return { kind: "count", n: target.n, mode };
  return { kind: "id", id: target.id, mode };
}

/**
 * Resolve a parsed target against a newest-first index into the contiguous
 * prefix of checkpoints to roll back (newest → oldest). Returns an error
 * string when the target can't be resolved.
 */
export function resolveRewindPrefix(
  index: readonly CheckpointIndexEntry[],
  target: Exclude<RewindTarget, { kind: "list" } | { kind: "error" }>,
): { entries: CheckpointIndexEntry[] } | { error: string } {
  if (index.length === 0) {
    return { error: "no checkpoints to rewind in this conversation." };
  }
  if (target.kind === "count") {
    if (target.n > index.length) {
      return {
        error: `only ${index.length} checkpoint(s) exist; cannot rewind ${target.n}.`,
      };
    }
    return { entries: index.slice(0, target.n) };
  }
  // by id (exact, or unique hex-suffix shorthand, or tool-call id)
  let idx = index.findIndex(
    (e) => e.id === target.id || e.toolCallId === target.id,
  );
  if (idx === -1) {
    const matches = index.filter((e) => e.id.endsWith(target.id));
    if (matches.length === 1) {
      idx = index.findIndex((e) => e.id === matches[0]!.id);
    } else if (matches.length > 1) {
      return { error: `checkpoint id '${target.id}' is ambiguous.` };
    }
  }
  if (idx === -1) {
    return { error: `no checkpoint matching '${target.id}'.` };
  }
  return { entries: index.slice(0, idx + 1) };
}

/** Apply a single checkpoint's before-snapshots to disk. */
async function applyCheckpointBefore(
  workspace: string,
  checkpoint: Checkpoint,
): Promise<RewindFileResult[]> {
  const results: RewindFileResult[] = [];
  // 2026-06-25 audit D3 — even though middleware.ts validates paths at
  // snapshot creation, defence-in-depth: re-check on restore. A tampered
  // checkpoint file on disk could otherwise let `/rewind` overwrite
  // arbitrary host files (e.g. ~/.ssh/authorized_keys) by setting
  // file.path to `../../../...`.
  const wsAbs = path.resolve(workspace);
  for (const file of checkpoint.files) {
    if (file.path.startsWith("../") || path.isAbsolute(file.path)) {
      results.push({
        path: file.path,
        action: "skipped",
        reason: "path escapes workspace (rejected at restore time)",
      });
      continue;
    }
    const abs = path.resolve(workspace, file.path);
    if (!abs.startsWith(wsAbs + path.sep) && abs !== wsAbs) {
      results.push({
        path: file.path,
        action: "skipped",
        reason: "path escapes workspace (rejected at restore time)",
      });
      continue;
    }
    const before = file.before;
    if (before.kind === "text") {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      // 2026-06-25 audit O1 — atomic restore so a crash mid-rewind can't
      // truncate the user's file (worst case: partial restore where the
      // file is neither original nor checkpoint snapshot).
      await atomicWriteFile(abs, before.content);
      results.push({ path: file.path, action: "restored" });
    } else if (before.kind === "absent") {
      try {
        await fs.unlink(abs);
      } catch {
        /* already gone */
      }
      results.push({ path: file.path, action: "deleted" });
    } else {
      results.push({
        path: file.path,
        action: "skipped",
        reason: "file too large to snapshot — content not restorable",
      });
    }
  }
  return results;
}

/**
 * Roll back a contiguous prefix of checkpoints (newest → oldest) so the oldest
 * `before` state wins for any file touched more than once. Reads the full
 * checkpoint records from the store. Checkpoints are left on disk.
 */
export async function rewindCheckpoints(
  workspace: string,
  conversationId: string,
  entries: readonly CheckpointIndexEntry[],
): Promise<RewindResult> {
  const files: RewindFileResult[] = [];
  const checkpointIds: string[] = [];
  // entries are newest-first; apply in that order so an earlier (older)
  // checkpoint's before-state overwrites a later one's for the same path.
  for (const entry of entries) {
    const cp = await readCheckpoint(workspace, conversationId, entry.id);
    if (!cp) continue;
    checkpointIds.push(cp.id);
    files.push(...(await applyCheckpointBefore(workspace, cp)));
  }
  return { checkpointIds, mode: "code-only", files };
}

// ── Conversation jsonl adapter ────────────────────────────────────────────────

/**
 * Minimal "conversation jsonl" surface the rewind module needs. The CLI / HTTP
 * host wires it to the real chat store; tests pass an in-memory stub.
 *
 * Semantics:
 *   - `read()` returns the persisted message list (newest-LAST), or `null` if
 *     no jsonl exists yet.
 *   - `write(messages)` replaces the persisted list atomically. The host is
 *     responsible for keeping any live in-memory session in sync.
 */
export interface ConversationHistoryAdapter {
  read(): Promise<MinimalMessage[] | null>;
  write(messages: MinimalMessage[]): Promise<void>;
}

/**
 * Minimal message shape the rewind module touches. Mirrors the bits of
 * `LLMMessage` we actually need so this module stays decoupled from
 * `src/core/providers/llm.ts`. Extra fields are allowed (assignable from
 * `LLMMessage`) but never inspected by this module.
 */
export interface MinimalMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
}

/**
 * Summariser injection. The CLI / SPA host can pass a real LLM-backed
 * summariser; the default produces a deterministic stub note (and a v2 TODO
 * marker) so the feature works end-to-end without an LLM dependency.
 */
export type Summarizer = (
  messages: readonly MinimalMessage[],
  context: { side: "head" | "tail"; checkpointId: string },
) => Promise<string> | string;

/** Default stub summariser — never throws, never hits the network. */
export const defaultSummarizer: Summarizer = (messages, ctx) => {
  const n = messages.length;
  const sideLabel =
    ctx.side === "head"
      ? "messages before checkpoint"
      : "messages after checkpoint";
  // First 60 chars of first/last text content help the user recognise the slice.
  const firstText = previewText(messages[0]);
  const lastText = previewText(messages[messages.length - 1]);
  return [
    `[Summary stub — ${n} ${sideLabel} ${ctx.checkpointId}]`,
    firstText ? `  first: ${firstText}` : "",
    lastText && lastText !== firstText ? `  last : ${lastText}` : "",
    "  (v2 TODO: wire to LLM summariser; currently a deterministic placeholder)",
  ]
    .filter(Boolean)
    .join("\n");
};

function previewText(m: MinimalMessage | undefined): string {
  if (!m) return "";
  const c = m.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    for (const p of c) {
      if (p && typeof p === "object" && (p as any).type === "text") {
        text = String((p as any).text ?? "");
        if (text) break;
      }
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

/** Render a human summary of a rewind for the CLI / SPA. */
export function formatRewindResult(result: RewindResult): string {
  if (result.checkpointIds.length === 0) {
    return "nothing was rewound (no matching checkpoints).";
  }
  const lines: string[] = [
    `Rewound ${result.checkpointIds.length} checkpoint(s) — mode: ${result.mode}`,
  ];
  for (const f of result.files) {
    const tag =
      f.action === "restored"
        ? "restored"
        : f.action === "deleted"
          ? "deleted "
          : "skipped ";
    lines.push(`  ${tag} ${f.path}${f.reason ? `  (${f.reason})` : ""}`);
  }
  if (result.conversation) {
    const c = result.conversation;
    if (c.action === "unchanged") {
      lines.push(`  conversation: unchanged (${c.beforeCount} messages)`);
    } else if (c.action === "skipped") {
      lines.push(`  conversation: skipped (${c.reason ?? "unavailable"})`);
    } else {
      const verb =
        c.action === "truncated"
          ? "truncated"
          : c.action === "summarized-tail"
            ? "summarised tail"
            : "summarised head";
      lines.push(
        `  conversation: ${verb} ${c.beforeCount} → ${c.afterCount} messages`,
      );
    }
  }
  return lines.join("\n");
}

// ── Conversation-side rewind helpers ─────────────────────────────────────────

/**
 * Apply a conversation-side rewind given a {@link RestoreMode}, the oldest
 * checkpoint in the rolled-back prefix, and a {@link ConversationHistoryAdapter}.
 *
 * Returns null for `code-only` (no conversation change) and for modes that
 * decide to no-op (e.g. checkpoint lacks `messageCountBefore`).
 */
export async function applyConversationRewind(
  workspace: string,
  conversationId: string,
  oldestEntry: CheckpointIndexEntry,
  mode: RestoreMode,
  adapter: ConversationHistoryAdapter,
  summarizer: Summarizer,
): Promise<RewindConversationResult | null> {
  if (mode === "code-only") return null;

  // Pull the canonical `messageCountBefore` from the full checkpoint (the
  // index entry may be a pre-5-mode row that lacks the field).
  let mcb: number | undefined = oldestEntry.messageCountBefore;
  if (mcb === undefined) {
    const cp = await readCheckpoint(workspace, conversationId, oldestEntry.id);
    if (cp?.messageCountBefore !== undefined) {
      mcb = cp.messageCountBefore;
    }
  }

  if (mcb === undefined) {
    return {
      beforeCount: 0,
      afterCount: 0,
      action: "skipped",
      reason: "checkpoint pre-dates conversation snapshot (no messageCountBefore)",
    };
  }

  const history = (await adapter.read()) ?? [];
  const beforeCount = history.length;
  const cut = Math.max(0, Math.min(mcb, beforeCount));

  switch (mode) {
    case "code-and-conversation":
    case "conversation-only": {
      // Truncate to the prefix that existed before the checkpoint ran. We
      // append a small system note so the model sees the workspace + history
      // were reset.
      const truncated: MinimalMessage[] = [...history.slice(0, cut)];
      truncated.push({
        role: "system",
        content: `[Conversation rewound to before checkpoint ${oldestEntry.id} (${cut} messages kept; mode=${mode})]`,
      });
      await adapter.write(truncated);
      return {
        beforeCount,
        afterCount: truncated.length,
        action: "truncated",
      };
    }
    case "summarize-from-here": {
      // Keep [0..cut), replace [cut..end] with a single summary.
      if (cut >= beforeCount) {
        return {
          beforeCount,
          afterCount: beforeCount,
          action: "unchanged",
          reason: "nothing after the checkpoint to summarise",
        };
      }
      const head = history.slice(0, cut);
      const tail = history.slice(cut);
      const summary = await summarizer(tail, {
        side: "tail",
        checkpointId: oldestEntry.id,
      });
      const next: MinimalMessage[] = [
        ...head,
        {
          role: "system",
          content: `[Summary of ${tail.length} message(s) after checkpoint ${oldestEntry.id}]\n${summary}`,
        },
      ];
      await adapter.write(next);
      return {
        beforeCount,
        afterCount: next.length,
        action: "summarized-tail",
      };
    }
    case "summarize-up-to-here": {
      // Replace [0..cut) with a single summary, keep [cut..end] intact. Be
      // careful to preserve any leading system messages — those carry the
      // session's system prompt and are not "conversation" content.
      let leading = 0;
      while (
        leading < history.length &&
        history[leading]!.role === "system" &&
        leading < cut
      ) {
        leading += 1;
      }
      if (cut <= leading) {
        return {
          beforeCount,
          afterCount: beforeCount,
          action: "unchanged",
          reason: "nothing before the checkpoint to summarise",
        };
      }
      const head = history.slice(0, leading);
      const middle = history.slice(leading, cut);
      const tail = history.slice(cut);
      const summary = await summarizer(middle, {
        side: "head",
        checkpointId: oldestEntry.id,
      });
      const next: MinimalMessage[] = [
        ...head,
        {
          role: "system",
          content: `[Summary of ${middle.length} message(s) before checkpoint ${oldestEntry.id}]\n${summary}`,
        },
        ...tail,
      ];
      await adapter.write(next);
      return {
        beforeCount,
        afterCount: next.length,
        action: "summarized-head",
      };
    }
  }
}

// ── High-level entry point ────────────────────────────────────────────────────

/** Optional plumbing the host can supply for conversation-aware modes. */
export interface RunRewindHostHooks {
  /** Required for any non-`code-only` mode; absent → mode silently degrades. */
  historyAdapter?: ConversationHistoryAdapter;
  /** Summariser injection. Defaults to {@link defaultSummarizer}. */
  summarizer?: Summarizer;
}

/**
 * High-level entry used by the slash handlers: parse + resolve + apply in one
 * call. Returns either a `text` body to print (list / errors) or a structured
 * `result` plus a `historyNote` the caller can append to chat history.
 *
 * Backward-compat overload: callers that pass `arg` as the only extra
 * argument still get the legacy `code-only` behaviour.
 */
export async function runRewind(
  workspace: string,
  conversationId: string,
  arg: string,
  hooks?: RunRewindHostHooks,
): Promise<
  | { kind: "text"; text: string }
  | { kind: "done"; result: RewindResult; historyNote: string; text: string }
> {
  const parsed = parseRewindArgs(arg);
  if (parsed.kind === "error") return { kind: "text", text: parsed.message };
  const index = await readCheckpointIndex(workspace, conversationId);
  if (parsed.kind === "list") {
    const { formatCheckpointList } = await import("./diff-format.js");
    return { kind: "text", text: formatCheckpointList(index) };
  }

  const target: Exclude<RewindTarget, { kind: "list" } | { kind: "error" }> =
    parsed.kind === "count"
      ? { kind: "count", n: parsed.n }
      : { kind: "id", id: parsed.id };
  const resolved = resolveRewindPrefix(index, target);
  if ("error" in resolved) return { kind: "text", text: resolved.error };

  const mode = parsed.mode;

  // Code-side: apply file rollback for any mode that includes "code"; for
  // pure conversation modes (`conversation-only`, `summarize-*`) we skip
  // the disk writes.
  const touchesCode =
    mode === "code-only" || mode === "code-and-conversation";

  const result: RewindResult = touchesCode
    ? await rewindCheckpoints(workspace, conversationId, resolved.entries)
    : {
        checkpointIds: resolved.entries.map((e) => e.id),
        mode,
        files: [],
      };
  result.mode = mode;

  // Conversation-side.
  const oldest = resolved.entries[resolved.entries.length - 1]!;
  if (mode !== "code-only" && hooks?.historyAdapter) {
    const conv = await applyConversationRewind(
      workspace,
      conversationId,
      oldest,
      mode,
      hooks.historyAdapter,
      hooks.summarizer ?? defaultSummarizer,
    );
    if (conv) result.conversation = conv;
  } else if (mode !== "code-only" && !hooks?.historyAdapter) {
    // Host didn't wire a conversation adapter — surface this so the user
    // knows the mode silently degraded.
    result.conversation = {
      beforeCount: 0,
      afterCount: 0,
      action: "skipped",
      reason: "host did not provide a conversation history adapter",
    };
  }

  const historyNote = `[Rewound to before checkpoint ${oldest.id}: ${oldest.description}${
    mode === "code-only" ? "" : ` (mode=${mode})`
  }]`;
  return {
    kind: "done",
    result,
    historyNote,
    text: formatRewindResult(result),
  };
}
