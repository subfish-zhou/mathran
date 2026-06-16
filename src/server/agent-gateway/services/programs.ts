/**
 * Standalone-runtime stand-ins for the Mathub program gateway services.
 *
 * Fully mocked by the agent-tool tests; the bodies never execute. The return
 * shapes mirror the fields the ported tools render and the test fixtures
 * supply (self-contained, not derived from the DB schema).
 */

import type { AgentPrincipal } from "@/server/agent-gateway/principal";

interface ProgramRecord {
  id: string;
  title: string;
  slug: string | null;
  subtitle: string | null;
  description: string | null;
  status: string | null;
  mathStatus: string | null;
  visibility: string | null;
  parentId: string | null;
  mscCodes: string[] | null;
  createdAt: Date | null;
}

export async function getProgramIndex(
  _principal: AgentPrincipal,
  _args: { idOrSlug: string },
): Promise<{
  program: ProgramRecord;
  parent: { id: string; title: string } | null;
  projects: Array<{
    id: string;
    title: string | null;
    status: string | null;
    role: string;
    order: number;
    effortCount: number;
    wikiPageCount: number;
    threadCount: number;
  }>;
  dependencies: Array<{
    sourceProjectId: string;
    targetProjectId: string;
    relationKind: string;
    label: string | null;
  }>;
  members: Array<{
    role: string;
    userName: string | null;
    userUsername: string | null;
  }>;
}> {
  throw new Error("programs.getProgramIndex is not available in the mathran standalone runtime");
}

export async function listPrograms(
  _principal: AgentPrincipal,
  _args: { query?: string; projectId?: string; limit?: number; offset?: number },
): Promise<Array<ProgramRecord & { projectCount: number }>> {
  throw new Error("programs.listPrograms is not available in the mathran standalone runtime");
}
