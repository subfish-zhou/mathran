/**
 * Standalone-runtime stand-in for the Mathub project gateway service.
 *
 * Fully mocked by the agent-tool tests; the body never executes. The return
 * shape mirrors the fields the `get_project_index` tool renders and the test
 * fixtures supply.
 */

import type { AgentPrincipal } from "@/server/agent-gateway/principal";

interface ProjectRecord {
  title: string;
  description: string | null;
  status: string | null;
  mathStatus: string | null;
  mscCodes: string[] | null;
  visibility: string | null;
}

export async function getProjectIndex(
  _principal: AgentPrincipal,
  _args: { id: string },
): Promise<{
  project: ProjectRecord;
  efforts: Array<{
    id: string;
    title: string;
    type: string;
    status: string;
  }>;
  wikiPages: Array<{
    id: string;
    title: string;
    slug: string | null;
    parentId: string | null;
  }>;
  threads: Array<{
    id: string;
    title: string;
    stream: string;
    postCount: number;
  }>;
}> {
  throw new Error("projects.getProjectIndex is not available in the mathran standalone runtime");
}
