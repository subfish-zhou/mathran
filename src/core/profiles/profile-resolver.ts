/**
 * Permission Profiles (#2) — resolver + mutation classification.
 *
 * Responsibilities:
 *   1. {@link loadProfileDefinition} — resolve a profile name to a definition,
 *      with a user-authored `<root>/.mathran/profiles/<name>.json` overriding the
 *      builtin of the same name (workspace layer wins over user layer).
 *   2. {@link resolveProfileEffects} — fill every optional field with its
 *      default, producing the {@link ProfileEffects} the CLI threads into the
 *      broker + ChatSession.
 *   3. {@link listAvailableProfiles} — the union of builtins + user files, for
 *      the `/profile` listing.
 *   4. {@link isMutatingCall} — the single source of truth for "does this tool
 *      call mutate?", used by the dispatch hard-reject (ci / review).
 *
 * Profiles never weaken the denylist (重要约束): {@link ProfileEffects.denylistTools}
 * is always merged *on top of* the settings denylist by the caller.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MATHRAN_DIR } from "../config/mathran-root.js";
import { DEFAULT_APPROVAL_POLICY } from "../approval/types.js";
import type { RiskClass } from "../approval/types.js";
import { BUILTIN_PROFILES, BUILTIN_PROFILE_NAMES } from "./builtin-profiles.js";
import { ProfileDefinitionSchema } from "./schema.js";
import type { ProfileDefinition, ProfileEffects } from "./types.js";

/** Thrown when `--profile <name>` / `/profile <name>` names a profile that does not exist. */
export class UnknownProfileError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly available: string[],
  ) {
    super(
      `unknown profile "${profileName}". Available: ${available.join(", ") || "(none)"}`,
    );
    this.name = "UnknownProfileError";
  }
}

const PROFILES_SUBDIR = "profiles";

export interface ProfileResolveOpts {
  /** Workspace root — `<workspace>/.mathran/profiles/` is the highest layer. */
  workspace?: string;
  /** Override `os.homedir()` (tests). */
  home?: string;
}

function profilesDir(root: string): string {
  return path.join(root, MATHRAN_DIR, PROFILES_SUBDIR);
}

/** Layer roots, highest precedence first (workspace > user). */
function layerRoots(opts: ProfileResolveOpts): string[] {
  const roots: string[] = [];
  if (opts.workspace) roots.push(opts.workspace);
  roots.push(opts.home ?? os.homedir());
  return roots;
}

/**
 * Read + validate a single `<root>/.mathran/profiles/<name>.json`. Returns the
 * parsed definition (with `name` forced to the file name), or `null` when the
 * file is absent or malformed (malformed files are skipped, not fatal).
 */
function readUserProfile(
  root: string,
  name: string,
): ProfileDefinition | null {
  const file = path.join(profilesDir(root), `${name}.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ProfileDefinitionSchema.safeParse(json);
  if (!parsed.success) return null;
  return { ...(parsed.data as ProfileDefinition), name };
}

/**
 * Resolve a profile NAME to its definition. A user-authored file overrides a
 * builtin of the same name; the workspace layer overrides the user layer.
 *
 * @throws {UnknownProfileError} when no builtin and no user file match.
 */
export function loadProfileDefinition(
  name: string,
  opts: ProfileResolveOpts = {},
): ProfileDefinition {
  for (const root of layerRoots(opts)) {
    const user = readUserProfile(root, name);
    if (user) return user;
  }
  const builtin = BUILTIN_PROFILES[name];
  if (builtin) return builtin;
  throw new UnknownProfileError(name, listAvailableProfiles(opts).map((p) => p.name));
}

/** Fill every optional field of a definition with its default. */
export function resolveProfileEffects(def: ProfileDefinition): ProfileEffects {
  return {
    name: def.name,
    description: def.description ?? "",
    policy: def.approval?.policy ?? DEFAULT_APPROVAL_POLICY,
    readOnlyMode: def.readOnlyMode ?? false,
    hardRejectMutations: def.hardRejectMutations ?? false,
    denylistTools: def.denylistTools ?? [],
    autoApprovePatterns: def.autoApprovePatterns ?? [],
  };
}

/** Convenience: load + resolve in one step. */
export function resolveProfile(
  name: string,
  opts: ProfileResolveOpts = {},
): ProfileEffects {
  return resolveProfileEffects(loadProfileDefinition(name, opts));
}

export interface AvailableProfile {
  name: string;
  description: string;
  /** "builtin" | "user" | "workspace" — where the effective definition came from. */
  source: "builtin" | "user" | "workspace";
}

/**
 * List every available profile (builtins + user/workspace files), deduped by
 * name with the highest-precedence source winning. Sorted with builtins first
 * (in canonical order), then any extra user profiles alphabetically.
 */
export function listAvailableProfiles(
  opts: ProfileResolveOpts = {},
): AvailableProfile[] {
  const byName = new Map<string, AvailableProfile>();
  for (const name of BUILTIN_PROFILE_NAMES) {
    const def = BUILTIN_PROFILES[name];
    byName.set(name, { name, description: def.description ?? "", source: "builtin" });
  }
  // User layer first (lower precedence), then workspace layer (overrides).
  const home = opts.home ?? os.homedir();
  scanLayer(home, "user", byName);
  if (opts.workspace) scanLayer(opts.workspace, "workspace", byName);

  const builtins = BUILTIN_PROFILE_NAMES.filter((n) => byName.has(n)).map(
    (n) => byName.get(n)!,
  );
  const extras = [...byName.values()]
    .filter((p) => !BUILTIN_PROFILE_NAMES.includes(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...builtins, ...extras];
}

function scanLayer(
  root: string,
  source: "user" | "workspace",
  byName: Map<string, AvailableProfile>,
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(profilesDir(root));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    const def = readUserProfile(root, name);
    if (!def) continue;
    byName.set(name, { name, description: def.description ?? "", source });
  }
}

// ──────────────────────────────────────────────────────────────────────
// Mutation classification (drives the dispatch hard-reject for ci / review)
// ──────────────────────────────────────────────────────────────────────

/** Tools whose every call mutates the workspace, regardless of args. */
const ALWAYS_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "todo_write",
]);

/**
 * Tools that look high-risk (`exec`) but do NOT mutate the workspace, so they
 * stay allowed under read-only / hard-reject profiles. `lean_check` compiles a
 * proof to verify it — exactly what a `ci` profile wants to keep running.
 */
const NON_MUTATING_EXEC_TOOLS: ReadonlySet<string> = new Set(["lean_check"]);

/** Leading commands that only read (no workspace mutation). */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "grep", "rg", "egrep", "fgrep", "find", "pwd",
  "echo", "wc", "stat", "file", "which", "type", "env", "printenv", "date",
  "true", "sort", "uniq", "cut", "tr", "column", "diff", "tree", "basename",
  "dirname", "realpath", "readlink", "du", "df", "whoami", "id", "uname",
  "hostname", "test", "[",
]);

/** `git` subcommands that only read repository state. */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame",
  "describe", "tag", "remote", "cat-file", "shortlog", "reflog", "ls-tree",
  "name-rev", "whatchanged", "grep",
]);

/**
 * Best-effort: returns true when `command` is composed solely of read-only
 * shell commands (so a `ci` read-only profile can still let the model run
 * `ls` / `cat` / `git status`). Conservative — anything not recognised, any
 * output redirect, or any command-substitution is treated as a mutation.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  // Output redirect to a file (`> f`, `>> f`) writes — but `2>&1` does not.
  if (/(^|[^0-9&])>>?\s*[^&\s>]/.test(cmd)) return false;
  // Command substitution / process substitution can hide a mutation.
  if (/\$\(|`|<\(/.test(cmd)) return false;
  // Split into segments on shell separators (pipes, &&, ||, ;, newline).
  const segments = cmd.split(/\|\||&&|[|;\n]/);
  for (const segRaw of segments) {
    const seg = segRaw.trim();
    if (!seg) continue;
    const tokens = seg.split(/\s+/);
    let head = tokens[0];
    // Skip a leading `env VAR=val` prefix.
    let idx = 0;
    while (head === "env" && tokens[idx + 1] && /=/.test(tokens[idx + 1])) {
      idx++;
      head = tokens[idx + 1];
    }
    if (!head) return false;
    if (head === "git") {
      const sub = tokens[idx + 1];
      if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
      continue;
    }
    if (!READ_ONLY_COMMANDS.has(head)) return false;
  }
  return true;
}

/**
 * The single source of truth for "does this tool call mutate the workspace?",
 * used by the dispatch hard-reject under `readOnlyMode` / `hardRejectMutations`.
 */
export function isMutatingCall(
  tool: string,
  riskClass: RiskClass,
  args: Record<string, unknown>,
): boolean {
  if (ALWAYS_MUTATING_TOOLS.has(tool)) return true;
  if (NON_MUTATING_EXEC_TOOLS.has(tool)) return false;
  if (tool === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    return !isReadOnlyShellCommand(command);
  }
  // Generic: writes / network / arbitrary execution mutate; reads do not.
  return riskClass === "write" || riskClass === "net" || riskClass === "exec";
}
