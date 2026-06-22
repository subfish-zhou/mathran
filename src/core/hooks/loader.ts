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
 * filename prefix (`pre-chat`*, `post-tool`*); anything else is `unknown`.
 *
 * SECURITY: this module deliberately does no execution and reads no script
 * contents beyond what's needed to record path + metadata. Sandboxed shell
 * execution is a separate, out-of-scope PR. The `allowed` flag is computed
 * from `settings.hooks.allowed` (a whitelist) purely so a future executor can
 * refuse to run un-allowlisted hooks.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MATHRAN_DIR } from "../config/mathran-root.js";
import type { LayerName } from "../skills/loader.js";

export type HookType = "pre-chat" | "post-tool" | "unknown";

export interface LoadedHook {
  /** Filename without the `.sh` extension. */
  name: string;
  /** Derived from the filename prefix. */
  type: HookType;
  layer: LayerName;
  /** Absolute path to the `.sh` file. NOT executed. */
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

/** Classify a hook by its filename prefix. */
export function hookTypeFor(fileNameNoExt: string): HookType {
  if (/^pre-chat(\b|[-_.]|$)/.test(fileNameNoExt)) return "pre-chat";
  if (/^post-tool(\b|[-_.]|$)/.test(fileNameNoExt)) return "post-tool";
  return "unknown";
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
    if (!entry.name.endsWith(".sh")) continue;
    const name = entry.name.slice(0, -".sh".length);
    const type = hookTypeFor(name);
    const allowed = allowSet.has(name) || allowSet.has(type);
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
