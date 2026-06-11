/**
 * User-memory fragment — relevant memories injected after persona+workspace.
 *
 * Wraps getUserMemoriesForPrompt(). Skipped when no userId or when the
 * MATHUB_MEMORY_INJECT_ENABLED env gate is off (the underlying function
 * returns '' in both cases).
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import { getUserMemoriesForPrompt } from "../user-memory";
import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

export const userMemoryFragment: ContextFragment = {
  id: "user-memory",
  priority: FragmentPriority.UserMemory,
  scope: "turn-time",
  render: async (input) => {
    if (!input.userId) return "";
    return getUserMemoriesForPrompt(input.userId, input.turnState?.queryText);
  },
};
