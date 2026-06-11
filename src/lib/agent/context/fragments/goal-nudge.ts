/**
 * Goal-nudge fragment — turn-time injection of "missing X" hint.
 *
 * Renders as the legacy turn-time system message `目标尚未达成，缺：${hint}…`.
 * Used by executor.ts after the goal gate evaluates and decides to continue.
 *
 * Skipped when no hint.
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

export const goalNudgeFragment: ContextFragment = {
  id: "goal-nudge",
  priority: FragmentPriority.GoalNudge,
  scope: "turn-time",
  render: (input) => {
    const hint = input.turnState?.goalNudgeHint?.trim();
    if (!hint) return "";
    return `目标尚未达成，缺：${hint}。继续推进，直到目标真正完成或确实需要用户决策为止。`;
  },
};
