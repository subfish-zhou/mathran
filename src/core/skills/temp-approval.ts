/**
 * Skill → temporary approval-rule bridge (Skills/Plugins 二层 §B.3).
 *
 * When a skill activates, its `manifest.allowedTools` are registered as
 * temporary, session-scoped `allow` rules on the {@link ApprovalBroker}. That
 * lets the skill's declared tools run without an approval prompt for the rest
 * of the session, WITHOUT persisting anything to `approval-rules.json`.
 *
 * Entry grammar (each `allowedTools` string):
 *   - `"bash"`            → allow the whole `bash` tool.
 *   - `"bash:lake build"` → allow `bash` only when the command starts with
 *                           `"lake build"` (a command-prefix rule).
 *
 * Precedence guarantees (enforced by the broker, not here):
 *   - The denylist is checked BEFORE standing rules, so a temp allow can never
 *     override a denylist veto (decision F.4).
 *   - Tools the skill does NOT list keep going through the normal policy.
 */

import type { ApprovalBroker } from "../chat/approval-broker.js";
import type { Rule } from "../approval/rules.js";
import type { LoadedSkill } from "./loader.js";

/**
 * Parse a single `allowedTools` entry into an approval {@link Rule}. A `:`
 * splits the tool name from a command-prefix; everything after the first colon
 * (trimmed) is the prefix. Returns `null` for an empty / malformed entry.
 */
export function parseAllowedTool(entry: string): Rule | null {
  if (typeof entry !== "string") return null;
  const trimmed = entry.trim();
  if (trimmed.length === 0) return null;
  const idx = trimmed.indexOf(":");
  if (idx < 0) {
    return { tool: trimmed, action: "allow", scope: "session" };
  }
  const tool = trimmed.slice(0, idx).trim();
  const prefix = trimmed.slice(idx + 1).trim();
  if (tool.length === 0) return null;
  if (prefix.length === 0) {
    return { tool, action: "allow", scope: "session" };
  }
  return { tool, prefix, action: "allow", scope: "session" };
}

/** Parse every `allowedTools` entry of a skill into rules (skipping bad ones). */
export function skillToolRules(skill: LoadedSkill): Rule[] {
  const tools = skill.manifest.allowedTools;
  if (!Array.isArray(tools)) return [];
  const rules: Rule[] = [];
  for (const entry of tools) {
    const rule = parseAllowedTool(entry);
    if (rule) rules.push(rule);
  }
  return rules;
}

/**
 * Register a skill's `allowedTools` as temporary session-scoped allow rules on
 * the broker. No-op when the broker is absent or the skill declares no tools.
 * Returns the rules that were registered (for logging / tests).
 */
export function registerSkillToolRules(
  broker: ApprovalBroker | undefined,
  skill: LoadedSkill,
): Rule[] {
  if (!broker) return [];
  const rules = skillToolRules(skill);
  for (const rule of rules) {
    broker.registerTemporaryRule(rule);
  }
  return rules;
}
