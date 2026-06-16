/**
 * Standalone-runtime stand-ins for the Mathub thread gateway services.
 *
 * Fully mocked by the agent-tool tests; the bodies never execute. The return
 * shapes mirror the fields the ported tools render and the test fixtures
 * supply (self-contained, not derived from the DB schema).
 */

import type { AgentPrincipal } from "@/server/agent-gateway/principal";

export async function getThread(
  _principal: AgentPrincipal,
  _args: { id: string },
): Promise<{
  thread: {
    title: string;
    stream: string | null;
    status: string | null;
  };
  posts: Array<{
    body: string | null;
    authorName: string | null;
    createdAt: Date | null;
  }>;
}> {
  throw new Error("threads.getThread is not available in the mathran standalone runtime");
}

export async function summarizeThread(
  _principal: AgentPrincipal,
  _args: { threadId: string; bodyMaxChars?: number },
): Promise<{
  thread: {
    id: string;
    title: string;
    stream: string;
    status: string;
    isLocked: boolean;
    isPinned: boolean;
    createdAt: Date;
    projectId: string | null;
    programId: string | null;
    summary: string | null;
  };
  posts: Array<{
    id: string;
    authorId: string;
    authorName: string | null;
    body: string;
    createdAt: Date;
    truncated: boolean;
  }>;
}> {
  throw new Error("threads.summarizeThread is not available in the mathran standalone runtime");
}

export async function searchForumThreadsAndPosts(
  _principal: AgentPrincipal,
  _args: {
    query: string;
    projectId?: string;
    programId?: string;
    limit?: number;
  },
): Promise<{
  threads: Array<{
    id: string;
    title: string;
    projectId: string | null;
    snippet: string;
    status: string;
  }>;
  posts: Array<{
    id: string;
    threadId: string;
    snippet: string;
  }>;
}> {
  throw new Error(
    "threads.searchForumThreadsAndPosts is not available in the mathran standalone runtime",
  );
}
