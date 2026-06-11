/**
 * Hook-context fragment — renders hook outcomes' additionalContext as a
 * developer-role message (modeled as system role in Mathub's convention)
 * so the LLM sees what hooks contributed without confusing them for user
 * input.
 *
 * Codex parity: codex-rs/core/src/context/hook_additional_context.rs.
 *
 * Returns '' when no entries. Multiple entries are joined by blank lines.
 *
 * Ported: 2026-06-10 (commit 12/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { ContextFragment } from "../fragment";
import { FragmentPriority } from "../fragment";

const MARKER = "[hook-context]";

export const hookContextFragment: ContextFragment = {
  id: "hook-context",
  priority: FragmentPriority.HookContext,
  scope: "turn-time",
  render: (input) => {
    const items = (input.turnState?.hookAdditionalContext ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) return "";
    // Marker prefix lets later compaction filters recognize injected hook
    // output and lets the LLM disambiguate from real user content.
    return `${MARKER}\n${items.join("\n\n")}`;
  },
};

export const HOOK_CONTEXT_MARKER = MARKER;
