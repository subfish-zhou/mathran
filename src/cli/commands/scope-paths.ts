/**
 * scope-paths — resolve a ChatScope to its filesystem root.
 *
 * Used by CLI commands (chat, goal, plan) to narrow ctx.workspace for
 * `bash` / `read_file` / `write_file` / `edit_file` so an agent working
 * on `project:smoke` reads + writes inside `<workspace>/projects/smoke/`
 * instead of the workspace root.
 *
 * v0.4 §1.1 — closes v0.11.0 smoke wire-up gap #3.
 */

import * as path from "node:path";
import type { ChatScope } from "../../core/chat/store.js";

const PROJECTS_DIR = "projects";
const EFFORTS_DIR = "efforts";

/**
 * Map a ChatScope to the directory the assistant should treat as its
 * working tree:
 *
 *   - global               → workspace root
 *   - project:<p>          → workspace/projects/<p>
 *   - effort:<p>/<e>       → workspace/projects/<p>/efforts/<e>
 *
 * Does NOT verify the directory exists — callers can decide whether to
 * pre-create it. Returns an absolute path provided `workspace` is absolute.
 */
export function resolveScopeRoot(workspace: string, scope: ChatScope): string {
  if (scope.kind === "global") return workspace;
  if (scope.kind === "project") {
    if (!scope.projectSlug) return workspace;
    return path.join(workspace, PROJECTS_DIR, scope.projectSlug);
  }
  // effort
  if (!scope.projectSlug || !scope.effortSlug) return workspace;
  return path.join(
    workspace,
    PROJECTS_DIR,
    scope.projectSlug,
    EFFORTS_DIR,
    scope.effortSlug,
  );
}
