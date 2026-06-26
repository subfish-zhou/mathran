/**
 * Rewind logic (/rewind).
 *
 * Restores the *before* snapshots captured by one or more checkpoints, rolling
 * the workspace back to the state that existed before those mutate calls ran:
 *   - `text`   snapshot → write the content back.
 *   - `absent` snapshot → delete the file (it didn't exist before).
 *   - `large`  snapshot → cannot restore (only a hash was kept); skipped with a
 *      warning (PLAN 大文件约束).
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
import type { Checkpoint, CheckpointIndexEntry } from "./schema.js";

export interface RewindFileResult {
  path: string;
  action: "restored" | "deleted" | "skipped";
  reason?: string;
}

export interface RewindResult {
  /** Checkpoint ids that were rolled back (newest → oldest). */
  checkpointIds: string[];
  files: RewindFileResult[];
}

/** Parsed `/rewind` argument. */
export type RewindTarget =
  | { kind: "list" }
  | { kind: "count"; n: number }
  | { kind: "id"; id: string }
  | { kind: "error"; message: string };

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
  return { checkpointIds, files };
}

/** Render a human summary of a rewind for the CLI / SPA. */
export function formatRewindResult(result: RewindResult): string {
  if (result.checkpointIds.length === 0) {
    return "nothing was rewound (no matching checkpoints).";
  }
  const lines: string[] = [
    `Rewound ${result.checkpointIds.length} checkpoint(s):`,
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
  return lines.join("\n");
}

/**
 * High-level entry used by the slash handlers: parse + resolve + apply in one
 * call. Returns either a `text` body to print (list / errors) or a structured
 * `result` plus a `historyNote` the caller can append to chat history.
 */
export async function runRewind(
  workspace: string,
  conversationId: string,
  arg: string,
): Promise<
  | { kind: "text"; text: string }
  | { kind: "done"; result: RewindResult; historyNote: string; text: string }
> {
  const target = parseRewindArg(arg);
  if (target.kind === "error") return { kind: "text", text: target.message };
  const index = await readCheckpointIndex(workspace, conversationId);
  if (target.kind === "list") {
    const { formatCheckpointList } = await import("./diff-format.js");
    return { kind: "text", text: formatCheckpointList(index) };
  }
  const resolved = resolveRewindPrefix(index, target);
  if ("error" in resolved) return { kind: "text", text: resolved.error };
  const result = await rewindCheckpoints(
    workspace,
    conversationId,
    resolved.entries,
  );
  const oldest = resolved.entries[resolved.entries.length - 1];
  const historyNote = `[Rewound to before checkpoint ${oldest?.id ?? "?"}: ${oldest?.description ?? ""}]`;
  return {
    kind: "done",
    result,
    historyNote,
    text: formatRewindResult(result),
  };
}
