/**
 * Subagent-notification fragment — renders buffered sub-agent stop
 * notifications as user-role messages tagged with <subagent_notification>
 * markers, matching codex-rs/core/src/context/subagent_notification.rs.
 *
 * One JSON-encoded notification per <subagent_notification>...</> block.
 * Multiple notifications join with blank lines. Returns '' when none.
 *
 * Ported: 2026-06-10 (commit 12/sprint-3 of mathub-ai-codex-upgrade).
 */

import type { ContextFragment, SubagentNotificationPayload } from "../fragment";
import { FragmentPriority } from "../fragment";

const OPEN_MARKER = "<subagent_notification>";
const CLOSE_MARKER = "</subagent_notification>";

function renderOne(n: SubagentNotificationPayload): string {
  // Match codex JSON shape (snake_case + only-non-null keys). Drop fields
  // explicitly undefined so the block stays compact when the parent agent
  // skims a long history.
  //
  // [P2-4 doc] We rely on JSON.stringify() to escape any newlines / quotes
  // / control characters that appear inside resultPreview or agentReference.
  // DO NOT switch to template-string concatenation (`"result_preview":"${n.resultPreview}"`)
  // — that would let a sub-agent print `"}{evil` and break out of the
  // <subagent_notification> JSON envelope. Test in fragments-12.test.ts
  // covers the escape behavior implicitly via the parse-back roundtrip.
  const payload: Record<string, unknown> = {
    agent_reference: n.agentReference,
    status: n.status,
  };
  if (typeof n.durationMs === "number") payload.duration_ms = n.durationMs;
  if (typeof n.totalTokens === "number") payload.total_tokens = n.totalTokens;
  if (typeof n.resultPreview === "string" && n.resultPreview.length > 0) {
    payload.result_preview = n.resultPreview;
  }
  return `${OPEN_MARKER}\n${JSON.stringify(payload)}\n${CLOSE_MARKER}`;
}

export const subagentNotificationFragment: ContextFragment = {
  id: "subagent-notification",
  priority: FragmentPriority.SubagentNotification,
  scope: "turn-time",
  render: (input) => {
    const notifs = input.turnState?.subagentNotifications ?? [];
    if (notifs.length === 0) return "";
    return notifs.map(renderOne).join("\n\n");
  },
};

export const SUBAGENT_NOTIFICATION_OPEN_MARKER = OPEN_MARKER;
export const SUBAGENT_NOTIFICATION_CLOSE_MARKER = CLOSE_MARKER;
