/**
 * Keyword-based skill matcher (no LLM).
 * Extracts trigger keywords from skill descriptions and matches against user messages.
 *
 * [commit-6b] mention counter integration: every match increments the per-slug
 * counter, and matches are returned hot-first (commit-6a/render.ts sort
 * already orders the *list* by mentions; here we order matches the same way
 * so callers like executor.ts who consume the order get hot skills first).
 */

import { recordMention, getCount } from "./mention-counter";

interface SkillMeta {
  name: string;
  slug: string;
  description: string;
}

/** Extract keywords from description for matching */
function extractKeywords(description: string): string[] {
  const keywords: string[] = [];

  // Look for "Triggers on:" section
  const triggersMatch = description.match(/Triggers?\s+on:?\s*(.+?)(?:\.|$)/i);
  if (triggersMatch) {
    // Extract quoted keywords
    const quoted = triggersMatch[1].match(/"([^"]+)"/g);
    if (quoted) {
      keywords.push(...quoted.map((q) => q.replace(/"/g, "").toLowerCase()));
    }
  }

  // Look for "Use when:" section — extract key phrases
  const useWhenMatch = description.match(/Use when:?\s*([\s\S]+?)(?:NOT for|Triggers|$)/i);
  if (useWhenMatch) {
    // Extract parenthesized items like (1) symbolic computation
    const items = useWhenMatch[1].match(/\(\d+\)\s*([^,(]+)/g);
    if (items) {
      keywords.push(
        ...items.map((item) =>
          item
            .replace(/\(\d+\)\s*/, "")
            .trim()
            .toLowerCase()
        )
      );
    }
  }

  // Also extract individual notable words from the name
  keywords.push(description.split(/\s+/).length > 0 ? "" : ""); // no-op placeholder

  return keywords.filter((k) => k.length > 0);
}

/** Check if message matches a set of keywords */
function messageMatchesKeywords(
  message: string,
  keywords: string[],
  skillName: string
): boolean {
  const lower = message.toLowerCase();

  // Always check the skill name itself
  if (lower.includes(skillName.toLowerCase())) return true;

  // Check slug-like patterns (e.g., "wolfram", "sage")
  const nameParts = skillName.toLowerCase().split(/[-\s]+/);
  for (const part of nameParts) {
    if (part.length >= 4 && lower.includes(part)) return true;
  }

  // Check extracted keywords
  for (const keyword of keywords) {
    if (keyword.length >= 3 && lower.includes(keyword)) return true;
  }

  return false;
}

export async function matchSkills(
  userMessage: string,
  availableSkills: SkillMeta[]
): Promise<string[]> {
  const matched: string[] = [];

  for (const skill of availableSkills) {
    const keywords = extractKeywords(skill.description);
    if (messageMatchesKeywords(userMessage, keywords, skill.name)) {
      matched.push(skill.slug);
      // [commit-6b] Mention counter — bump on every match. Sync, allocation-
      // light; in-memory only until commit 6c wires the DB flush sink.
      recordMention(skill.slug);
    }
  }

  // [commit-6b] Sort hot-first; alpha tiebreak. Preserves backward
  // compatibility for callers that don't care about order (matched.length and
  // set membership are unchanged), while letting executor.ts load the most-
  // used skill body first when matched.length is large.
  matched.sort((a, b) => {
    const mA = getCount(a);
    const mB = getCount(b);
    if (mA !== mB) return mB - mA;
    return a.localeCompare(b);
  });

  return matched;
}
