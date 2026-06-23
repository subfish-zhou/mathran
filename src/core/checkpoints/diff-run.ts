/**
 * `/diff` runner — list checkpoints or render one checkpoint's diff.
 *
 * Argument grammar (mirrors `/rewind`):
 *   - (empty) / `list`   → newest-first checkpoint listing
 *   - `last`             → diff of the most recent checkpoint
 *   - `<id>`             → diff of that checkpoint (exact id or unique suffix)
 */

import { formatCheckpointDiff, formatCheckpointList } from "./diff-format.js";
import { readCheckpoint, readCheckpointIndex } from "./store.js";

/** Resolve an `/diff <arg>` to the target checkpoint id (or list). */
export type DiffTarget =
  | { kind: "list" }
  | { kind: "show"; id: string };

/** Parse a `/diff` argument into a target. */
export function parseDiffArg(arg: string): DiffTarget {
  const trimmed = arg.trim();
  if (!trimmed || trimmed === "list") return { kind: "list" };
  return { kind: "show", id: trimmed };
}

/** Run `/diff` against the store and return a text body to print. */
export async function runDiff(
  workspace: string,
  conversationId: string,
  arg: string,
): Promise<string> {
  const target = parseDiffArg(arg);
  const index = await readCheckpointIndex(workspace, conversationId);
  if (target.kind === "list") return formatCheckpointList(index);

  // Resolve `last` and id/suffix shorthands against the newest-first index.
  let id: string | null = null;
  if (target.id === "last") {
    id = index.length > 0 ? index[0]!.id : null;
  } else {
    const exact = index.find(
      (e) => e.id === target.id || e.toolCallId === target.id,
    );
    if (exact) {
      id = exact.id;
    } else {
      const matches = index.filter((e) => e.id.endsWith(target.id));
      if (matches.length === 1) id = matches[0]!.id;
      else if (matches.length > 1)
        return `checkpoint id '${target.id}' is ambiguous.`;
    }
  }
  if (!id) {
    return index.length === 0
      ? formatCheckpointList(index)
      : `no checkpoint matching '${target.id}' (try /diff for the list).`;
  }
  const cp = await readCheckpoint(workspace, conversationId, id);
  if (!cp) return `checkpoint '${id}' could not be read.`;
  return formatCheckpointDiff(cp);
}
