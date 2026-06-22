/**
 * Layered slash-command loader (C 方案).
 *
 * Commands live at `<layer>/.mathran/commands/<name>.md`:
 *
 *   ~/.mathran/commands/<name>.md                          USER
 *   <workspace>/.mathran/commands/<name>.md                WORKSPACE
 *   <workspace>/projects/<slug>/.mathran/commands/<name>.md  PROJECT
 *
 * Dedup is by command `name` (the filename sans `.md`, overridable via
 * frontmatter): PROJECT > WORKSPACE > USER. The markdown body (sans
 * frontmatter) becomes the command's `body`.
 *
 * Best-effort: missing layers are empty; malformed frontmatter is skipped
 * with a warning. Never throws.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CommandManifestSchema, type CommandManifest } from "../config/schemas.js";
import { MATHRAN_DIR } from "../config/mathran-root.js";
import { parseFrontmatter } from "../config/frontmatter.js";
import type { LayerName } from "../skills/loader.js";

export interface LoadedCommand {
  name: string;
  layer: LayerName;
  /** Absolute path to the `<name>.md`. */
  path: string;
  manifest: CommandManifest;
}

export interface LoadLayeredCommandsOpts {
  workspace: string;
  projectSlug?: string;
  home?: string;
  skipUser?: boolean;
}

export interface LayeredCommandsResult {
  commands: LoadedCommand[];
  warnings: string[];
}

function userCommandsDir(home?: string): string {
  return path.join(home ?? os.homedir(), MATHRAN_DIR, "commands");
}
function workspaceCommandsDir(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR, "commands");
}
function projectCommandsDir(workspace: string, slug: string): string {
  return path.join(workspace, "projects", slug, MATHRAN_DIR, "commands");
}

function readCommandsFromDir(
  dir: string,
  layer: LayerName,
  warnings: string[],
): LoadedCommand[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LoadedCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { data, body, error } = parseFrontmatter(raw);
    if (error) {
      warnings.push(`commands: ${filePath} has malformed frontmatter (${error}); ignored.`);
      continue;
    }
    const defaultName = entry.name.slice(0, -".md".length);
    const candidate = { name: defaultName, ...data, body };
    const result = CommandManifestSchema.safeParse(candidate);
    if (!result.success) {
      warnings.push(
        `commands: ${filePath} failed validation (${result.error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; ")}); ignored.`,
      );
      continue;
    }
    out.push({ name: result.data.name, layer, path: filePath, manifest: result.data });
  }
  return out;
}

/** Load + dedup commands across all three layers (PROJECT > WORKSPACE > USER). */
export function loadLayeredCommands(
  opts: LoadLayeredCommandsOpts,
): LayeredCommandsResult {
  const warnings: string[] = [];
  const byName = new Map<string, LoadedCommand>();

  if (!opts.skipUser) {
    for (const c of readCommandsFromDir(userCommandsDir(opts.home), "user", warnings)) {
      byName.set(c.name, c);
    }
  }
  for (const c of readCommandsFromDir(workspaceCommandsDir(opts.workspace), "workspace", warnings)) {
    byName.set(c.name, c);
  }
  if (opts.projectSlug) {
    for (const c of readCommandsFromDir(
      projectCommandsDir(opts.workspace, opts.projectSlug),
      "project",
      warnings,
    )) {
      byName.set(c.name, c);
    }
  }

  const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { commands, warnings };
}
