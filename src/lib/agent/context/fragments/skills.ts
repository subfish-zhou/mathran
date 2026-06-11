/**
 * Skills fragment — active skill section composed from turnState.matchedSkills.
 *
 * The matching logic (which skills apply to this turn) stays where it is —
 * in executor.ts skill loading + matcher.ts. This fragment is just the
 * RENDER side: given a list of matched skills, produce the system block.
 *
 * Returns '' when no skills matched.
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

export const skillsFragment: ContextFragment = {
  id: "skills",
  priority: FragmentPriority.Skills,
  scope: "turn-time",
  render: (input) => {
    const matched = input.turnState?.matchedSkills ?? [];
    const header = input.turnState?.skillSystemSection ?? "";
    if (matched.length === 0 && !header) return "";
    let body = "";
    for (const skill of matched) {
      const refList = skill.references ?? [];
      const refNote =
        refList.length > 0
          ? `\nAvailable references (use load_skill_reference to read): ${refList.join(", ")}`
          : "";
      body += `\n\n## Active Skill: ${skill.name}\n${skill.body}${refNote}`;
    }
    // Byte-identical to executor.ts:535 `skillSystemSection + matchedSkillContent`:
    // header is kept as-is (no trim), body always starts with the leading
    // `\n\n` that executor produced via `+=`.
    return `${header}${body}`;
  },
};
