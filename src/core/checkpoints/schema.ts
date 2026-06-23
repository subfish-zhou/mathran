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
}

/** Project a full checkpoint down to its index entry. */
export function toCheckpointIndexEntry(c: Checkpoint): CheckpointIndexEntry {
  return {
    id: c.id,
    toolCallId: c.toolCallId,
    toolName: c.toolName,
    affectedPaths: c.affectedPaths,
    timestamp: c.timestamp,
    description: c.description,
  };
}
