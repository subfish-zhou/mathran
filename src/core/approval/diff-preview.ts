/**
 * UX gap A — Diff preview before file write.
 *
 * codex and Claude Code both show a unified diff before a write/edit lands and
 * let the user accept / decline / edit it. mathran historically only had
 * path-level allow/ask/deny rules with NO content preview — a wrong write was
 * only recoverable after the fact via `git diff`.
 *
 * This module is the pure, host-agnostic core of the feature:
 *
 *   - {@link computeUnifiedDiff} — old → new content as a unified-diff string.
 *   - {@link buildWriteProposal} — turn a pending write_file / edit_file tool
 *     call into a {@link WriteProposal} (path + truncated contents + diff +
 *     mode) the host ships to the UI as a `propose-write` event.
 *
 * The session BLOCKS on a {@link WriteProposalDecision} (accept / decline /
 * accept-with-edited-content) before the write actually executes. No I/O lives
 * here except what the caller passes in (`oldContent`) — keeping it trivially
 * unit-testable.
 */

import { createTwoFilesPatch } from "diff";

/** Whether the write creates a brand-new file or modifies an existing one. */
export type DiffMode = "create" | "modify";

/**
 * Default cap (bytes) applied to `oldContent` / `newContent` before they are
 * shipped on the wire. The diff is computed on the FULL content; only the
 * embedded copies the UI shows are truncated.
 */
export const PREVIEW_CONTENT_CAP_BYTES = 5 * 1024;

/**
 * The payload carried by a `propose-write` event. Mirrors what the SPA's
 * DiffPreviewModal needs to render without a follow-up fetch.
 */
export interface WriteProposal {
  /** Provider tool-call id — correlates the event with the decision POST. */
  toolCallId: string;
  /** Workspace-relative or absolute path the write targets. */
  path: string;
  /** Existing file content (truncated to {@link PREVIEW_CONTENT_CAP_BYTES}). */
  oldContent: string;
  /** Proposed new content (truncated to {@link PREVIEW_CONTENT_CAP_BYTES}). */
  newContent: string;
  /** Unified-diff text (computed on the full, untruncated contents). */
  diffText: string;
  /** `create` when the file does not exist yet, else `modify`. */
  mode: DiffMode;
}

/**
 * The user's verdict on a {@link WriteProposal}:
 *   - `accept`  — run the write as proposed.
 *   - `accept` + `editedContent` — run the write but with the user-tweaked
 *     whole-file content instead of the model's.
 *   - `decline` — do NOT write; the tool result reports a user rejection so the
 *     model can change strategy.
 */
export interface WriteProposalDecision {
  outcome: "accept" | "decline";
  /**
   * When present on an `accept`, the FULL new file content the user edited in
   * the modal. Replaces the model-proposed content. Ignored on `decline`.
   */
  editedContent?: string;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes, appending an ellipsis
 *  marker when it was cut. Cheap byte-budget slice (good enough for a preview;
 *  may split a multibyte char at the very boundary — harmless for display). */
export function truncateContent(
  content: string,
  maxBytes: number = PREVIEW_CONTENT_CAP_BYTES,
): string {
  const buf = Buffer.from(content, "utf-8");
  if (buf.byteLength <= maxBytes) return content;
  const head = buf.subarray(0, maxBytes).toString("utf-8");
  return `${head}\n… [truncated ${buf.byteLength - maxBytes} more bytes]`;
}

/**
 * Produce a unified diff from `oldContent` → `newContent` for `filePath`.
 * A `create` (oldContent === "") still yields a valid all-additions patch.
 * Trailing context is set to 3 lines (the codex / git default).
 */
export function computeUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  return createTwoFilesPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: 3 },
  );
}

/** Non-overlapping occurrence count of `needle` in `hay`. */
function countOccurrences(hay: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const pos = hay.indexOf(needle, idx);
    if (pos === -1) return count;
    count++;
    idx = pos + needle.length;
  }
}

/**
 * Compute the proposed new whole-file content for a write-style tool call,
 * given the existing content. Returns `null` when no meaningful preview can be
 * derived (so the caller falls back to executing the tool directly):
 *
 *   - `write_file` — new content is the `content` arg verbatim.
 *   - `edit_file`  — apply the `old_string` → `new_string` replacement to
 *     `oldContent`. Honours `replace_all`; returns `null` when the match is
 *     absent or ambiguous (the tool itself will then fail loudly).
 *
 * Unknown tools return `null`.
 */
export function computeProposedContent(
  tool: string,
  args: Record<string, unknown>,
  oldContent: string,
): string | null {
  if (tool === "write_file") {
    return typeof args.content === "string" ? args.content : null;
  }
  if (tool === "edit_file") {
    const oldString = typeof args.old_string === "string" ? args.old_string : null;
    const newString = typeof args.new_string === "string" ? args.new_string : null;
    if (oldString === null || newString === null || oldString.length === 0) {
      return null;
    }
    const replaceAll = args.replace_all === true;
    const matches = countOccurrences(oldContent, oldString);
    if (matches === 0) return null;
    if (matches > 1 && !replaceAll) return null;
    return replaceAll
      ? oldContent.split(oldString).join(newString)
      : oldContent.replace(oldString, newString);
  }
  return null;
}

/**
 * Build a {@link WriteProposal} for a pending write-style tool call. Returns
 * `null` when a preview cannot be derived (caller should just run the tool).
 *
 * The diff is computed on the FULL contents; the `oldContent` / `newContent`
 * copies embedded in the proposal are truncated to {@link PREVIEW_CONTENT_CAP_BYTES}.
 */
export function buildWriteProposal(input: {
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  /** Path to display (raw path arg, may be relative). */
  path: string;
  /** Existing file content, or "" / null when the file does not exist. */
  oldContent: string | null;
  /** Whether the target file already exists on disk. */
  exists: boolean;
  /** Optional override for the per-content truncation cap. */
  capBytes?: number;
}): WriteProposal | null {
  const oldFull = input.oldContent ?? "";
  const newFull = computeProposedContent(input.tool, input.args, oldFull);
  if (newFull === null) return null;

  const cap = input.capBytes ?? PREVIEW_CONTENT_CAP_BYTES;
  return {
    toolCallId: input.toolCallId,
    path: input.path,
    oldContent: truncateContent(oldFull, cap),
    newContent: truncateContent(newFull, cap),
    diffText: computeUnifiedDiff(oldFull, newFull, input.path),
    mode: input.exists ? "modify" : "create",
  };
}
