/**
 * Diff rendering for checkpoints (`/diff`).
 *
 * A minimal, dependency-free unified-diff: an LCS over lines drives the
 * `+`/`-`/` ` markers (PLAN decision: "纯文本 diff 足够 v1" — no syntax
 * highlight, no hunk headers). `large` snapshots (files over the snapshot cap)
 * render as `binary or too large` instead of content.
 */

import type {
  Checkpoint,
  CheckpointFile,
  CheckpointIndexEntry,
  FileSnapshot,
} from "./schema.js";

/** Longest-common-subsequence table over two line arrays. */
function lcsLengths(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

/** Split into lines, dropping a single trailing newline's empty element. */
function toLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Produce unified-diff body lines (`+`/`-`/` ` prefixed) between two texts.
 * Pure; exported for tests.
 */
export function diffLines(beforeText: string, afterText: string): string[] {
  const a = toLines(beforeText);
  const b = toLines(afterText);
  const dp = lcsLengths(a, b);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

function snapshotText(s: FileSnapshot): string | null {
  if (s.kind === "text") return s.content;
  if (s.kind === "absent") return "";
  return null; // large
}

/** Render one file's before→after change block. */
export function formatFileDiff(file: CheckpointFile): string {
  const beforeText = snapshotText(file.before);
  const afterText = snapshotText(file.after);
  const header = `--- a/${file.path}\n+++ b/${file.path}`;
  if (beforeText === null || afterText === null) {
    return `${header}\n(binary or too large — content not snapshotted)`;
  }
  if (beforeText === afterText) {
    return `${header}\n(no content change)`;
  }
  const tag =
    file.before.kind === "absent"
      ? " (new file)"
      : file.after.kind === "absent"
        ? " (deleted)"
        : "";
  const body = diffLines(beforeText, afterText).join("\n");
  return `${header}${tag}\n${body}`;
}

/** Render a full checkpoint's diff (every affected file). */
export function formatCheckpointDiff(checkpoint: Checkpoint): string {
  const when = new Date(checkpoint.timestamp).toISOString();
  const head = `checkpoint ${checkpoint.id}  [${checkpoint.toolName}]  ${when}\n${checkpoint.description}`;
  if (checkpoint.files.length === 0) {
    return `${head}\n(no files changed)`;
  }
  const blocks = checkpoint.files.map(formatFileDiff).join("\n\n");
  return `${head}\n\n${blocks}`;
}

function shortId(id: string): string {
  // checkpoint-<ts>-<8hex> → keep the hex suffix for a stable short handle.
  const parts = id.split("-");
  return parts.length >= 3 ? `…${parts[parts.length - 1]}` : id;
}

/** Render the `/diff` (and `/rewind`) checkpoint listing, newest-first. */
export function formatCheckpointList(
  entries: readonly CheckpointIndexEntry[],
): string {
  if (entries.length === 0) {
    return "no checkpoints in this conversation yet — they're recorded automatically before each write_file / edit_file.";
  }
  const lines: string[] = [`Checkpoints (${entries.length}, newest first):`];
  entries.forEach((e, idx) => {
    const n = idx + 1;
    const paths =
      e.affectedPaths.length > 0 ? e.affectedPaths.join(", ") : "(none)";
    lines.push(
      `  ${String(n).padStart(2)}. ${e.id}  ${e.toolName.padEnd(10)} ${paths}`,
    );
  });
  lines.push("");
  lines.push(
    "use `/diff <id>` or `/diff last` to view a diff; `/rewind <N>` or `/rewind <id>` to restore.",
  );
  void shortId; // reserved for future compact rendering
  return lines.join("\n");
}
