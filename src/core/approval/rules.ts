/**
 * Approval rule matching + persistence (Approval Policy 矩阵).
 *
 * A {@link Rule} auto-resolves a tool call without prompting:
 *
 *   - `prefix`   — matches `bash`/exec calls whose command starts with the
 *                  given string (after whitespace normalisation).
 *   - `pathGlob` — matches write calls whose `path` arg matches a glob.
 *
 * Two stores feed the broker (highest precedence first):
 *   1. The workspace rules file `.mathran/approval-rules.json`.
 *   2. The user rules file `~/.mathran/approval-rules.json`.
 *   3. Inline rules from `settings.json` (lowest).
 *
 * Plus a separate {@link Denylist} that ALWAYS denies, overriding any allow
 * rule — see {@link matchDenylist}. The denylist is the only thing that can
 * veto an explicit allow.
 *
 * Writes go through {@link atomicWriteFile} (tmp + rename) so a mid-write
 * SIGKILL never leaves a corrupt JSON file.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../chat/atomic-write.js";

/** A single approval rule. Exactly one of `prefix` / `pathGlob` is meaningful. */
export interface Rule {
  /** Tool the rule applies to, e.g. `"bash"` / `"write_file"`. */
  tool: string;
  /** Command-prefix match (for exec tools). */
  prefix?: string;
  /** Path glob match (for write tools). */
  pathGlob?: string;
  /** What to do on match. */
  action: "allow" | "deny";
  /** `session` rules live only in memory; `persistent` rules hit disk. */
  scope?: "session" | "persistent";
  /**
   * UX gap A — Diff preview before file write. When `true` on an `allow` rule
   * that matches a write-style tool call (write_file / edit_file), the broker
   * still authorises the call but the session first surfaces a `propose-write`
   * event carrying the unified diff and BLOCKS until the user accepts / declines
   * / edits it. Default (undefined / false) preserves the legacy behaviour: an
   * allow rule runs the write immediately with no preview. Ignored on `deny`
   * rules and on non-write tools.
   */
  requireDiffPreview?: boolean;
}

/** Shape of the `approval-rules.json` file. */
export interface RulesFile {
  rules: Rule[];
}

/**
 * A denylist entry, written as `"<tool>:<pattern>"`. `pattern` is matched
 * against the command (exec) or path (write) with `*` glob semantics.
 * Example: `"bash:rm -rf *"`, `"bash:sudo *"`, `"write_file:/etc/*"`.
 */
export type DenylistEntry = string;

/**
 * Normalise a command for prefix comparison: trim + collapse internal runs of
 * whitespace to a single space. So `"npm   test"` and `"npm test "` both match
 * a `"npm test"` prefix.
 */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/**
 * Convert a glob (supporting `*` and `**`) to a RegExp. `**` matches across
 * path separators; a single `*` matches within a segment (no `/`). Other regex
 * metacharacters are escaped.
 */
export function globToRegExp(glob: string, permissive = false): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (permissive) {
        // Denylist patterns operate on commands (which embed paths), so a
        // single `*` spans `/`.
        re += ".*";
        if (glob[i + 1] === "*") i++;
      } else if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        // swallow a trailing slash after ** so `src/**` matches `src/a`
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Extract the comparison subject from a tool call:
 *   - exec tools (bash): the `command` arg.
 *   - write tools: the `path` arg.
 * Returns `""` when the expected arg is absent.
 */
function subjectFor(
  tool: string,
  args: Record<string, unknown>,
): { command: string; pathArg: string } {
  const command =
    typeof args.command === "string" ? args.command : "";
  const pathArg = typeof args.path === "string" ? args.path : "";
  return { command, pathArg };
}

/** True when a single rule matches the call. */
export function ruleMatches(
  rule: Rule,
  tool: string,
  args: Record<string, unknown>,
): boolean {
  if (rule.tool !== tool) return false;
  const { command, pathArg } = subjectFor(tool, args);
  if (rule.prefix !== undefined) {
    return normalizeCommand(command).startsWith(normalizeCommand(rule.prefix));
  }
  if (rule.pathGlob !== undefined) {
    if (!pathArg) return false;
    return globToRegExp(rule.pathGlob).test(pathArg);
  }
  // A rule with neither prefix nor pathGlob is a tool-wide match.
  return true;
}

/**
 * Find the first matching rule's action. Returns `null` when no rule matches.
 * `deny` rules take precedence over `allow` rules at the SAME list position is
 * not modelled — order in the array is precedence; callers should list deny
 * rules first if they want them to win. (The denylist is the hard veto.)
 */
export function matchRules(
  rules: Rule[],
  tool: string,
  args: Record<string, unknown>,
): "allow" | "deny" | null {
  for (const rule of rules) {
    if (ruleMatches(rule, tool, args)) return rule.action;
  }
  return null;
}

/**
 * Like {@link matchRules}, but returns the first matching {@link Rule} object
 * (not just its action) so callers can inspect per-rule metadata such as
 * {@link Rule.requireDiffPreview}. Returns `null` when no rule matches.
 */
export function firstMatchingRule(
  rules: Rule[],
  tool: string,
  args: Record<string, unknown>,
): Rule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, tool, args)) return rule;
  }
  return null;
}

/**
 * Match a tool call against the denylist. A denylist entry `"<tool>:<pattern>"`
 * matches when the tool equals `<tool>` and `<pattern>` (glob) matches the
 * command or path. Returns the matched entry, or `null`.
 *
 * The denylist is the highest-priority veto: even an explicit allow rule cannot
 * override a denylist hit.
 */
export function matchDenylist(
  denylist: DenylistEntry[],
  tool: string,
  args: Record<string, unknown>,
): DenylistEntry | null {
  const { command, pathArg } = subjectFor(tool, args);
  for (const entry of denylist) {
    const idx = entry.indexOf(":");
    if (idx < 0) continue;
    const entryTool = entry.slice(0, idx).trim();
    const pattern = entry.slice(idx + 1).trim();
    if (entryTool !== tool) continue;
    const re = globToRegExp(pattern, true);
    const subjects = [normalizeCommand(command), pathArg].filter(Boolean);
    // Also test the un-normalised command so patterns with embedded spacing
    // (e.g. "rm -rf *") match raw input.
    if (command) subjects.push(command.trim());
    if (subjects.some((s) => re.test(s))) return entry;
  }
  return null;
}

/** Default rules-file name under a `.mathran` root. */
export const APPROVAL_RULES_FILENAME = "approval-rules.json";

/**
 * Read + parse a rules file. Returns an empty rule set when the file is absent
 * or malformed (malformed → warn-and-ignore rather than crash a chat round).
 */
export async function loadRulesFile(filePath: string): Promise<RulesFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return { rules: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as RulesFile).rules)
    ) {
      const rules = (parsed as RulesFile).rules.filter(
        (r) => r && typeof r.tool === "string" && (r.action === "allow" || r.action === "deny"),
      );
      return { rules };
    }
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[mathran] ignoring malformed approval-rules at ${filePath}`);
  }
  return { rules: [] };
}

/**
 * Append a persistent rule to a rules file (creating it if needed), writing
 * atomically. Duplicate rules (same tool + prefix/pathGlob + action) are not
 * appended twice.
 */
export async function appendRule(
  filePath: string,
  rule: Rule,
): Promise<RulesFile> {
  const current = await loadRulesFile(filePath);
  const dup = current.rules.some(
    (r) =>
      r.tool === rule.tool &&
      r.prefix === rule.prefix &&
      r.pathGlob === rule.pathGlob &&
      r.action === rule.action,
  );
  if (!dup) current.rules.push(rule);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, JSON.stringify(current, null, 2) + "\n");
  return current;
}
