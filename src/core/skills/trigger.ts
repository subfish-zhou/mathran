/**
 * Skill trigger matcher (Skills/Plugins 二层 §B).
 *
 * Given the layered skills and the current user message, decide which skills
 * should activate this turn. Activation is driven by each skill's
 * `manifest.trigger`:
 *
 *   - absent          → "always": the skill is active every turn (injected at
 *                       session start; never matched here).
 *   - string          → case-insensitive substring keyword match.
 *   - { keywords }    → any keyword (case-insensitive substring) matches.
 *   - { regex }       → `new RegExp(regex, "i")` tests the message.
 *   - { keywords, regex } → either side matching is enough.
 *
 * The matcher is pure and never throws: a malformed regex is treated as a
 * non-match (with the offending skill simply not triggering). Multiple skills
 * can match the same message — all matches are returned, in input order.
 */

import type { LoadedSkill } from "./loader.js";

/** How a skill came to be active. */
export type SkillTriggerKind = "keyword" | "regex" | "always" | "manual";

export interface SkillTriggerMatch {
  skill: LoadedSkill;
  /** How the skill matched. */
  matched: SkillTriggerKind;
  /** The keyword / regex source fragment that triggered the match, if any. */
  matchedFragment?: string;
}

/** True when `skill.manifest.trigger` is absent (an "always" skill). */
export function isAlwaysSkill(skill: LoadedSkill): boolean {
  return skill.manifest.trigger === undefined;
}

/**
 * Match a single skill against a (lower-cased) user message. Returns the match
 * descriptor, or `null` when the skill does not trigger. "always" skills are
 * NOT matched here (they are injected at session start, not per-turn).
 */
function matchOne(
  skill: LoadedSkill,
  message: string,
  messageLower: string,
): SkillTriggerMatch | null {
  const trigger = skill.manifest.trigger;
  if (trigger === undefined) return null; // "always" — handled at startup.

  if (typeof trigger === "string") {
    const kw = trigger.trim().toLowerCase();
    if (kw.length > 0 && messageLower.includes(kw)) {
      return { skill, matched: "keyword", matchedFragment: trigger };
    }
    return null;
  }

  // Object trigger: keywords first (cheap), then regex.
  const keywords = Array.isArray(trigger.keywords) ? trigger.keywords : [];
  for (const k of keywords) {
    if (typeof k !== "string") continue;
    const kw = k.trim().toLowerCase();
    if (kw.length > 0 && messageLower.includes(kw)) {
      return { skill, matched: "keyword", matchedFragment: k };
    }
  }

  if (typeof trigger.regex === "string" && trigger.regex.length > 0) {
    try {
      const re = new RegExp(trigger.regex, "i");
      if (re.test(message)) {
        return { skill, matched: "regex", matchedFragment: trigger.regex };
      }
    } catch {
      // Malformed regex → treat as non-match rather than throwing.
    }
  }

  return null;
}

export interface MatchSkillTriggersOpts {
  skills: ReadonlyArray<LoadedSkill>;
  userMessage: string;
}

/**
 * Return every skill whose trigger matches `userMessage`. "always" skills are
 * excluded (they don't depend on the message). Order follows `skills`.
 */
export function matchSkillTriggers(
  opts: MatchSkillTriggersOpts,
): SkillTriggerMatch[] {
  const message = opts.userMessage ?? "";
  const messageLower = message.toLowerCase();
  const out: SkillTriggerMatch[] = [];
  for (const skill of opts.skills) {
    const m = matchOne(skill, message, messageLower);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Resolve the prompt text a skill injects when active: `promptTemplate` when
 * present (with `{{userMessage}}` substituted), else the raw skill body.
 * Returns "" when neither yields content.
 *
 * Only the `{{userMessage}}` placeholder is supported in this iteration; other
 * `{{...}}` tokens are left verbatim.
 */
export function renderSkillPrompt(
  skill: LoadedSkill,
  userMessage: string,
): string {
  const template = skill.manifest.promptTemplate;
  const source =
    typeof template === "string" && template.length > 0 ? template : skill.body;
  if (!source) return "";
  return source.replace(/\{\{\s*userMessage\s*\}\}/g, userMessage);
}
