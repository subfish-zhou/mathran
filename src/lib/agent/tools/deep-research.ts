import type { ToolDefinition } from "./types";

export const deepResearchTool: ToolDefinition = {
  name: "deep_research",
  description:
    "Delegate a research query to a sub-agent that can search across wiki, efforts, forum, and arxiv to produce a comprehensive answer.",
  type: "sub-agent",
  timeoutMs: 3_600_000,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The research query to investigate",
      },
      projectId: {
        type: "string",
        description: "Optional project ID to scope the research",
      },
    },
    required: ["query"],
  },
  agentConfig: {
    systemPrompt:
      "You are a research assistant. Use the available tools to thoroughly investigate the query. Synthesize your findings into a comprehensive answer.",
    maxIterations: 5,
    tools: [
      "search_wiki",
      "search_efforts",
      "search_forum",
      "search_arxiv",
      "read_wiki_page",
      "read_effort",
      "read_thread",
    ],
  },
  // Sub-agent tools don't use execute directly; the executor handles them via runAgentLoop.
  // Provide a no-op execute for type compatibility.
  execute: async () => ({
    success: false,
    data: null,
    displayText: "Sub-agent tool should be handled by executor",
  }),
};
