/**
 * Standalone-runtime stand-ins for the Mathub effort gateway services.
 *
 * mathran has no relational database, so these function bodies are never meant
 * to execute — both agent-tool test files fully mock this module via
 * `vi.mock("@/server/agent-gateway/services/efforts")`. The TYPE signatures are
 * preserved (adapted to self-contained structural return types) so the ported
 * tool files type-check and the test fixtures assign cleanly.
 */

import type { AgentPrincipal } from "@/server/agent-gateway/principal";

export interface EffortRecord {
  id: string;
  title: string;
  type: string | null;
  status: string | null;
  description: string | null;
  document: string | null;
  tags: string[] | string | null;
  arxivId: string | null;
  doi: string | null;
  createdAt: Date | null;
}

interface EffortReviewRecord {
  id: string;
  status: string;
  body: string | null;
  createdAt: Date | null;
  reviewerName: string | null;
}

interface EffortMilestoneRecord {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: Date | null;
  createdAt: Date | null;
}

interface EffortReleaseRecord {
  id: string;
  tag: string;
  title: string;
  isDraft: boolean;
  createdAt: Date | null;
  authorName: string | null;
}

interface EffortIssueRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  authorName: string | null;
  authorId: string | null;
  createdAt: Date | null;
}

function unavailable(fn: string): never {
  throw new Error(`efforts.${fn} is not available in the mathran standalone runtime`);
}

export async function getEffort(
  _principal: AgentPrincipal,
  _args: { id: string },
): Promise<{
  effort: EffortRecord;
  project: { id: string; slug: string; title: string; visibility: string } | null;
  creator: { id: string; name: string | null } | null;
}> {
  return unavailable("getEffort");
}

export async function getEffortDetails(
  _principal: AgentPrincipal,
  _args: { id: string; include?: ReadonlyArray<"reviews" | "milestones" | "releases" | "stats"> },
): Promise<{
  reviews?: EffortReviewRecord[];
  milestones?: EffortMilestoneRecord[];
  releases?: EffortReleaseRecord[];
  stats?: { stars: number; watches: number };
}> {
  return unavailable("getEffortDetails");
}

export async function listEffortIssues(
  _principal: AgentPrincipal,
  _args: { effortId: string; status?: string; limit?: number; offset?: number },
): Promise<{
  issues: EffortIssueRecord[];
  limit: number;
  offset: number;
}> {
  return unavailable("listEffortIssues");
}

export async function createProjectEffort(
  _principal: AgentPrincipal,
  _args: {
    projectId: string;
    type: string;
    title: string;
    description: string;
    subject?: string;
    tags?: string;
    sourceThreadId?: string;
  },
): Promise<EffortRecord> {
  return unavailable("createProjectEffort");
}

export async function searchEfforts(
  _principal: AgentPrincipal,
  _args: { query: string; projectId?: string; programId?: string; limit?: number },
): Promise<
  Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    projectId: string;
    description: string;
  }>
> {
  return unavailable("searchEfforts");
}
