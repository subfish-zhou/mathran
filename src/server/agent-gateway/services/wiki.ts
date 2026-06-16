/**
 * Standalone-runtime stand-ins for the Mathub wiki gateway services.
 *
 * Fully mocked by the agent-tool tests; the bodies never execute. The return
 * shapes mirror the fields the ported tools render and the test fixtures
 * supply (self-contained, not derived from the DB schema).
 */

import type { AgentPrincipal } from "@/server/agent-gateway/principal";

interface WikiPageRecord {
  title: string;
  slug: string | null;
  content: string | null;
  updatedAt: Date | null;
}

export async function getWikiPage(
  _principal: AgentPrincipal,
  _args: { id: string },
): Promise<WikiPageRecord> {
  throw new Error("wiki.getWikiPage is not available in the mathran standalone runtime");
}

export async function searchWikiPages(
  _principal: AgentPrincipal,
  _args: { query: string; projectId?: string; programId?: string; limit?: number },
): Promise<
  Array<{
    id: string;
    title: string;
    slug: string;
    projectId: string | null;
    programId: string | null;
    snippet: string;
    type: "wiki";
  }>
> {
  throw new Error("wiki.searchWikiPages is not available in the mathran standalone runtime");
}
