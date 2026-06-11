/**
 * Avoid-hint fragment — sub-agent only "things to avoid" tail-note.
 *
 * Renders as `[Avoid] ${hint}` appended to the sub-agent system prompt.
 * Main-agent flows pass no avoidHint so this is skipped there.
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

export const avoidHintFragment: ContextFragment = {
  id: "avoid-hint",
  priority: FragmentPriority.AvoidHint,
  scope: "turn-time",
  render: (input) => {
    const hint = input.turnState?.avoidHint?.trim();
    if (!hint) return "";
    return `[Avoid] ${hint}`;
  },
};
