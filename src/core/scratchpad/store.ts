/**
 * Per-conversation scratchpad store (gap #3), fs-only.
 *
 * Scratchpads are short-lived, conversation-scoped notes the model writes to
 * persist state across turns. They live under
 * `<workspace>/.mathran/scratchpad/<convId>/<name>.md` and can be wiped wholesale
 * when a conversation ends via {@link cleanupScratchpad}.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Conversation ids and scratchpad names share the same flat-slug rule. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Throw if `value` (a convId or name) isn't a safe, flat slug. */
export function assertValidSlug(value: string, kind: string): void {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw new Error(
      `invalid ${kind} '${value}': must match ${SLUG_RE} (alphanumeric, dash, underscore; no path separators)`,
    );
  }
}

/** Absolute path to a conversation's scratchpad directory (convId validated). */
function convDir(workspace: string, convId: string): string {
  assertValidSlug(convId, "conversationId");
  return path.join(workspace, ".mathran", "scratchpad", convId);
}

/** Absolute path to a named scratchpad file (convId + name validated). */
function scratchpadPath(
  workspace: string,
  convId: string,
  name: string,
): string {
  assertValidSlug(name, "scratchpad name");
  return path.join(convDir(workspace, convId), `${name}.md`);
}

/** Read a named scratchpad, or null if it doesn't exist. */
export async function readScratchpad(
  workspace: string,
  convId: string,
  name: string,
): Promise<string | null> {
  const p = scratchpadPath(workspace, convId, name);
  try {
    return await fs.readFile(p, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/** Write (or overwrite) a named scratchpad. */
export async function writeScratchpad(
  workspace: string,
  convId: string,
  name: string,
  content: string,
): Promise<void> {
  const p = scratchpadPath(workspace, convId, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf-8");
}

/** Remove an entire conversation's scratchpad directory. No-op if absent. */
export async function cleanupScratchpad(
  workspace: string,
  convId: string,
): Promise<void> {
  const dir = convDir(workspace, convId);
  await fs.rm(dir, { recursive: true, force: true });
}
