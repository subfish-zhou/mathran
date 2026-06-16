/**
 * Standalone-runtime stand-in for the Mathub forum gateway service.
 *
 * Fully mocked by the agent-tool tests; the body never executes. The
 * `MentionRow` shape mirrors Mathub so the `list_mentions` tool type-checks.
 */

import type { AgentPrincipal } from "@/server/agent-gateway/principal";

export interface MentionRow {
  postId: string;
  threadId: string;
  body: string;
  authorId: string;
  createdAt: Date;
}

export async function listMentions(
  _principal: AgentPrincipal,
  _args: { since?: Date | string; limit?: number; offset?: number },
): Promise<MentionRow[]> {
  throw new Error("forum.listMentions is not available in the mathran standalone runtime");
}
