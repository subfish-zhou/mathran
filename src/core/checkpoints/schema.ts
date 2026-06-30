/**
 * Checkpoint schema (/diff + checkpoint/rewind).
 *
 * A checkpoint is created automatically before every mutating tool call
 * (`write_file` / `edit_file`). It records the *before* and *after* content of
 * exactly the path(s) the tool claimed to touch — never a full workspace scan
 * (PLAN 重要约束). This lets `/diff` render what changed and `/rewind` restore
 * the pre-mutation state.
 *
 * Files larger than {@link MAX_SNAPSHOT_BYTES} are not stored verbatim: only a
 * `sha256` + `size` are kept (PLAN 大文件约束). Such snapshots can be *diffed*
 * (shown as "binary or too large") but cannot be *restored* by a rewind.
 *
 * **Conversation snapshot** (5-mode rewind, aligned with Claude Code /rewind
 * menu). Each checkpoint additionally records `messageCountBefore`: the length
 * of the session's `messages[]` array at the moment the mutate tool ran. Because
 * the conversation jsonl is append-only, rewinding the *conversation* is a
 * pure prefix truncation: we keep the first `messageCountBefore` rows and drop
 * the rest. The field is optional so checkpoints written by older versions
 * keep working (rewind falls back to "code only" when it's missing).
 */

/** Hard cap on the byte size of a file we will snapshot verbatim (1 MiB). */
export const MAX_SNAPSHOT_BYTES = 1024 * 1024;

/** The mutating tools we checkpoint. */
export type MutateToolName = "write_file" | "edit_file" | "patch";

/**
 * One file's content at a point in time.
 *   - `absent`  — the file did not exist.
 *   - `text`    — full UTF-8 content (file ≤ {@link MAX_SNAPSHOT_BYTES}).
 *   - `large`   — file exceeded the cap; only `sha256` + `size` kept.
 */
export type FileSnapshot =
  | { kind: "absent" }
  | { kind: "text"; content: string }
  | { kind: "large"; size: number; sha256: string };

/** Per-path before/after pair captured around a single mutate call. */
export interface CheckpointFile {
  /** Workspace-relative path (POSIX separators). */
  path: string;
  before: FileSnapshot;
  after: FileSnapshot;
}

/** A full checkpoint record (persisted as one json file). */
export interface Checkpoint {
  /** `checkpoint-<timestamp>-<8hex>`. */
  id: string;
  conversationId: string;
  /** Provider tool-call id that triggered the checkpoint (may be empty). */
  toolCallId: string;
  toolName: MutateToolName;
  /** Workspace-relative paths the tool claimed to touch. */
  affectedPaths: string[];
  /** Per-path before/after snapshots. */
  files: CheckpointFile[];
  /** Epoch millis. */
  timestamp: number;
  /** One-line human description (e.g. `write_file src/foo.ts`). */
  description: string;
  /**
   * Length of the chat session's `messages[]` array *before* the mutate
   * tool ran (Claude Code /rewind parity). When present, `/rewind` with a
   * conversation-aware mode (`code-and-conversation`, `conversation-only`,
   * `summarize-*`) can truncate the conversation jsonl back to this length.
   * Optional for forward-compat: pre-5-mode checkpoints omit it, and rewind
   * silently degrades to "code only" for those.
   */
  messageCountBefore?: number;
}

/** Denormalised, newest-first index row (drives `/diff` / `/rewind` lists). */
export interface CheckpointIndexEntry {
  id: string;
  /** Provider tool-call id that triggered the checkpoint (may be empty). */
  toolCallId: string;
  toolName: MutateToolName;
  affectedPaths: string[];
  timestamp: number;
  description: string;
  /** See {@link Checkpoint.messageCountBefore}. Optional for back-compat. */
  messageCountBefore?: number;
}

/**
 * The five restore modes from Claude Code's /rewind menu.
 *
 *  - `code-and-conversation` — roll back both the workspace files AND the
 *    conversation jsonl to the pre-checkpoint state. Mirrors a full undo.
 *  - `conversation-only`     — keep the files (model's writes survive) and
 *    rewind only the conversation, e.g. to retry a prompt against new code.
 *  - `code-only`             — rewind the files but keep the conversation
 *    (the legacy mathran behaviour, kept as the default for `/rewind` so
 *    existing scripts/UX don't change).
 *  - `summarize-from-here`   — keep the conversation up to the checkpoint
 *    intact, and replace everything *after* it with a single summary
 *    system note. Useful when you want to clear out a noisy tail.
 *  - `summarize-up-to-here`  — replace everything *before* the checkpoint
 *    with a single summary system note, keeping the tail (current focus)
 *    intact. Useful when you want to compress early context.
 */
export type RestoreMode =
  | "code-and-conversation"
  | "conversation-only"
  | "code-only"
  | "summarize-from-here"
  | "summarize-up-to-here";

/** All restore-mode values (for validation / menus). */
export const RESTORE_MODES: readonly RestoreMode[] = [
  "code-and-conversation",
  "conversation-only",
  "code-only",
  "summarize-from-here",
  "summarize-up-to-here",
] as const;

/** Default mode used when `/rewind` is invoked with no `--mode` flag. */
export const DEFAULT_RESTORE_MODE: RestoreMode = "code-only";

/** Type guard for unknown strings coming off the CLI / HTTP boundary. */
export function isRestoreMode(value: unknown): value is RestoreMode {
  return (
    typeof value === "string" &&
    (RESTORE_MODES as readonly string[]).includes(value)
  );
}

/** Project a full checkpoint down to its index entry. */
export function toCheckpointIndexEntry(c: Checkpoint): CheckpointIndexEntry {
  const entry: CheckpointIndexEntry = {
    id: c.id,
    toolCallId: c.toolCallId,
    toolName: c.toolName,
    affectedPaths: c.affectedPaths,
    timestamp: c.timestamp,
    description: c.description,
  };
  if (typeof c.messageCountBefore === "number") {
    entry.messageCountBefore = c.messageCountBefore;
  }
  return entry;
}
