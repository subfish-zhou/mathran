/**
 * Builtin-skills loader (Skills/Plugins 二层 §C).
 *
 * Ships `propose-plan` / `propose-goal` (and any future builtin) as ordinary
 * `SKILL.md` files under this directory, then exposes them as a *hidden layer
 * below USER*. Because they go through the same {@link readSkillsFromDir}
 * parser and the same name-dedup as the three on-disk layers, a user who
 * writes `~/.mathran/skills/propose-plan/SKILL.md` transparently overrides the
 * builtin — no code change required (decision F.1).
 *
 * The `.md` files are the single source of truth. At runtime we resolve the
 * directory relative to this module (works under `tsx`/Vitest from `src/` and,
 * for a published build, from the copied `dist/` tree — see the build copy
 * step). A missing directory is non-fatal: builtins simply don't load.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { readSkillsFromDir, type LoadedSkill } from "../../skills/loader.js";

/** Directory containing the builtin `<name>/SKILL.md` folders. */
function builtinSkillsDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Candidate directories to search for the builtin SKILL.md files, in order.
 * The primary is this module's own directory. When the module runs from a
 * compiled `dist/` tree that did not copy the `.md` files, we fall back to the
 * sibling `src/` path so local dev/test of a built tree still works.
 */
function candidateDirs(): string[] {
  const primary = builtinSkillsDir();
  const dirs = [primary];
  if (primary.includes(`${path.sep}dist${path.sep}`)) {
    dirs.push(primary.replace(`${path.sep}dist${path.sep}`, `${path.sep}src${path.sep}`));
  }
  return dirs;
}

/**
 * Load the builtin skills as {@link LoadedSkill}s at layer `"builtin"`.
 * Best-effort: never throws; an unreadable directory yields an empty list.
 */
export function loadBuiltinSkills(): { skills: LoadedSkill[]; warnings: string[] } {
  const warnings: string[] = [];
  for (const dir of candidateDirs()) {
    let exists = false;
    try {
      exists = fs.statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const skills = readSkillsFromDir(dir, "builtin", warnings);
    if (skills.length > 0) return { skills, warnings };
  }
  return { skills: [], warnings };
}
