/**
 * Layered hook loader (C 方案) — **loads only, never executes**.
 *
 * Hooks live at `<layer>/.mathran/hooks/*.sh`:
 *
 *   ~/.mathran/hooks/*.sh                          USER
 *   <workspace>/.mathran/hooks/*.sh                WORKSPACE
 *   <workspace>/projects/<slug>/.mathran/hooks/*.sh  PROJECT
 *
 * Unlike skills/commands, hooks are NOT deduped by name — every layer's hooks
 * are merged (all would run, per type). A hook's *type* is derived from its
 * filename prefix (`pre-chat`*, `post-tool`*, `pre-edit`*, `post-edit`*,
 * `pre-commit`*, `pre-bash`*, `on-goal-complete`*); anything else is
 * `unknown`.
 *
 * SECURITY: this module deliberately does no execution and reads no script
 * contents beyond what's needed to record path + metadata. Sandboxed shell
 * execution lives in `executor.ts`. The `allowed` flag is computed from
 * `settings.hooks.allowed` (a whitelist) so the executor can refuse to run
 * un-allowlisted hooks.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MATHRAN_DIR } from "../config/mathran-root.js";
import type { LayerName } from "../skills/loader.js";

export type HookType =
  | "pre-chat"
  | "post-tool"
  | "pre-edit"
  | "post-edit"
  | "pre-commit"
  | "pre-bash"
  | "on-goal-complete"
  | "unknown";

/** Hook types whose non-zero exit (or timeout) BLOCKS the guarded operation. */
export const BLOCKING_HOOK_TYPES: ReadonlySet<HookType> = new Set<HookType>([
  "pre-chat",
  "pre-edit",
  "pre-commit",
  "pre-bash",
]);

/** True when a non-zero exit / timeout of this hook type blocks the operation. */
export function isBlockingHookType(type: HookType): boolean {
  return BLOCKING_HOOK_TYPES.has(type);
}

/** Recognised hook script extensions (everything else, incl. none, is bash). */
const HOOK_EXTENSIONS = [".sh", ".bash", ".js", ".py"] as const;

export interface LoadedHook {
  /** Filename without the hook extension (e.g. `post-edit`). */
  name: string;
  /** Derived from the filename prefix. */
  type: HookType;
  layer: LayerName;
  /** Absolute path to the hook script. */
  path: string;
  /** True when this hook (by name or type) is in `settings.hooks.allowed`. */
  allowed: boolean;
}

export interface LoadLayeredHooksOpts {
  workspace: string;
  projectSlug?: string;
  home?: string;
  skipUser?: boolean;
  /** Whitelist from `settings.hooks.allowed` (matched against name or type). */
  allowed?: ReadonlyArray<string>;
}

export interface LayeredHooksResult {
  hooks: LoadedHook[];
  warnings: string[];
}

function userHooksDir(home?: string): string {
  return path.join(home ?? os.homedir(), MATHRAN_DIR, "hooks");
}
function workspaceHooksDir(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR, "hooks");
}
function projectHooksDir(workspace: string, slug: string): string {
  return path.join(workspace, "projects", slug, MATHRAN_DIR, "hooks");
}

/** Classify a hook by its filename prefix (extension already stripped). */
export function hookTypeFor(fileNameNoExt: string): HookType {
  // Order matters: `pre-commit` and `pre-bash` are both `pre-*`; match the
  // more specific `pre-commit` / `pre-edit` before falling through. The regex
  // anchors on a word boundary so `pre-chat-lint` still classifies as
  // `pre-chat` but `pre-commitment` does NOT match `pre-commit`.
  const boundary = "(\\b|[-_.]|$)";
  const types: HookType[] = [
    "pre-chat",
    "post-tool",
    "pre-edit",
    "post-edit",
    "pre-commit",
    "pre-bash",
    "on-goal-complete",
  ];
  for (const t of types) {
    if (new RegExp(`^${t}${boundary}`).test(fileNameNoExt)) return t;
  }
  return "unknown";
}

/**
 * Strip a recognised hook extension. Returns the bare name plus the matched
 * extension (`""` when the file has no extension — treated as a bash script).
 */
function splitHookExt(fileName: string): { name: string; ext: string } | null {
  for (const ext of HOOK_EXTENSIONS) {
    if (fileName.endsWith(ext)) {
      return { name: fileName.slice(0, -ext.length), ext };
    }
  }
  // No recognised extension. Accept extensionless files (run as bash) but
  // reject anything with an *unrecognised* extension (e.g. `.md`, `.txt`).
  if (!fileName.includes(".")) return { name: fileName, ext: "" };
  return null;
}

function readHooksFromDir(
  dir: string,
  layer: LayerName,
  allowSet: Set<string>,
): LoadedHook[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LoadedHook[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const split = splitHookExt(entry.name);
    if (!split) continue;
    const name = split.name;
    const type = hookTypeFor(name);
    const allowed = allowSet.has(name) || allowSet.has(type) || allowSet.has(entry.name);
    out.push({ name, type, layer, path: path.join(dir, entry.name), allowed });
  }
  // Stable order within a layer.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Load hooks from all three layers. All layers are merged (no dedup) so a
 * future executor can run every matching hook per type, lowest layer first
 * (USER → WORKSPACE → PROJECT).
 */
export function loadLayeredHooks(opts: LoadLayeredHooksOpts): LayeredHooksResult {
  const warnings: string[] = [];
  const allowSet = new Set(opts.allowed ?? []);
  const hooks: LoadedHook[] = [];

  if (!opts.skipUser) {
    hooks.push(...readHooksFromDir(userHooksDir(opts.home), "user", allowSet));
  }
  hooks.push(...readHooksFromDir(workspaceHooksDir(opts.workspace), "workspace", allowSet));
  if (opts.projectSlug) {
    hooks.push(
      ...readHooksFromDir(projectHooksDir(opts.workspace, opts.projectSlug), "project", allowSet),
    );
  }

  return { hooks, warnings };
}
