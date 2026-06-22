/**
 * Layered skill loader (C 方案).
 *
 * Skills live at `<layer>/.mathran/skills/<name>/SKILL.md`, where `<layer>` is
 * one of the three cascade layers:
 *
 *   ~/.mathran/skills/<name>/SKILL.md                          USER
 *   <workspace>/.mathran/skills/<name>/SKILL.md                WORKSPACE
 *   <workspace>/projects/<slug>/.mathran/skills/<name>/SKILL.md  PROJECT
 *
 * Dedup is by skill `name`: PROJECT overrides same-named WORKSPACE overrides
 * same-named USER. The `SKILL.md` frontmatter is parsed into a
 * {@link SkillManifest}; `name` defaults to the directory name when absent.
 *
 * Reads are best-effort: a missing layer is empty; an unreadable / invalid
 * `SKILL.md` is skipped with a warning. Never throws.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SkillManifestSchema, type SkillManifest } from "../config/schemas.js";
import { MATHRAN_DIR } from "../config/mathran-root.js";
import { parseFrontmatter } from "../config/frontmatter.js";

export type LayerName = "user" | "workspace" | "project";

/** Precedence order, lowest → highest. */
export const LAYER_PRECEDENCE: ReadonlyArray<LayerName> = ["user", "workspace", "project"];

export interface LoadedSkill {
  name: string;
  layer: LayerName;
  /** Absolute path to the SKILL.md. */
  path: string;
  manifest: SkillManifest;
  /** Markdown body (sans frontmatter). */
  body: string;
}

export interface LoadLayeredSkillsOpts {
  workspace: string;
  projectSlug?: string;
  home?: string;
  skipUser?: boolean;
  /** Names to exclude (e.g. from settings.skills.disabled). */
  disabled?: ReadonlyArray<string>;
}

export interface LayeredSkillsResult {
  /** Effective skills after dedup, keyed insertion order is precedence-stable. */
  skills: LoadedSkill[];
  warnings: string[];
}

function userSkillsDir(home?: string): string {
  return path.join(home ?? os.homedir(), MATHRAN_DIR, "skills");
}
function workspaceSkillsDir(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR, "skills");
}
function projectSkillsDir(workspace: string, slug: string): string {
  return path.join(workspace, "projects", slug, MATHRAN_DIR, "skills");
}

function readSkillsFromDir(
  dir: string,
  layer: LayerName,
  warnings: string[],
): LoadedSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(dir, entry.name);
    const manifestPath = path.join(skillDir, "SKILL.md");
    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, "utf-8");
    } catch {
      continue; // no SKILL.md in this dir
    }
    const { data, body, error } = parseFrontmatter(raw);
    if (error) {
      warnings.push(`skills: ${manifestPath} has malformed frontmatter (${error}); ignored.`);
      continue;
    }
    // Default name to the directory name when frontmatter omits it.
    const candidate = { name: entry.name, ...data };
    const result = SkillManifestSchema.safeParse(candidate);
    if (!result.success) {
      warnings.push(
        `skills: ${manifestPath} failed validation (${result.error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; ")}); ignored.`,
      );
      continue;
    }
    out.push({
      name: result.data.name,
      layer,
      path: manifestPath,
      manifest: result.data,
      body,
    });
  }
  return out;
}

/**
 * Load skills from all three layers and dedup by name (PROJECT > WORKSPACE >
 * USER). Disabled names are filtered out last.
 */
export function loadLayeredSkills(opts: LoadLayeredSkillsOpts): LayeredSkillsResult {
  const warnings: string[] = [];
  const byName = new Map<string, LoadedSkill>();

  // Apply lowest → highest so later layers overwrite same-named entries.
  if (!opts.skipUser) {
    for (const s of readSkillsFromDir(userSkillsDir(opts.home), "user", warnings)) {
      byName.set(s.name, s);
    }
  }
  for (const s of readSkillsFromDir(workspaceSkillsDir(opts.workspace), "workspace", warnings)) {
    byName.set(s.name, s);
  }
  if (opts.projectSlug) {
    for (const s of readSkillsFromDir(
      projectSkillsDir(opts.workspace, opts.projectSlug),
      "project",
      warnings,
    )) {
      byName.set(s.name, s);
    }
  }

  const disabled = new Set(opts.disabled ?? []);
  const skills = [...byName.values()].filter((s) => !disabled.has(s.name));
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}
