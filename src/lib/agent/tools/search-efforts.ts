import { searchEfforts } from "@/server/agent-gateway/services/efforts";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const searchEffortsTool: ToolDefinition = {
  name: "search_efforts",
  description:
    "Search workspace efforts (proofs, constructions, computations, etc.) by title or description. Returns matching effort titles, types, statuses, and description snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query to match against effort titles and descriptions" },
      projectId: { type: "string", description: "Optional project ID to scope search" },
      programId: { type: "string", description: "Optional program ID - searches across all projects in the program" },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    return withToolSpan(
      "search_efforts",
      { userId: ctx.userId },
      async () => {
    const query = String(args.query);
    // P0-4: tool args are LLM-controlled; scope IDs must come from server context.
    const projectId = ctx.projectId;
    const programId = ctx.programId;
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    // P0-2 / P1-4: cache key includes BOTH project + program scope and the
    // raw query. Empty-string placeholders disambiguate "unscoped" vs the
    // (effectively impossible) collision with a real id. Tool-name prefix is
    // required — see types.ts contract.
    const cacheKey =
      `search_efforts:${projectId ?? ""}:${programId ?? ""}:${query}`;
    if (ctx.runCache instanceof Map && ctx.runCache.has(cacheKey)) {
      const cached = ctx.runCache.get(cacheKey) as {
        formatted: Array<Record<string, unknown>>;
      };
      return {
        success: true,
        data: cached.formatted,
        displayText:
          `Found ${cached.formatted.length} effort(s) matching "${query}" (已从本 run 缓存复用)`,
      };
    }

    try {
      const results = await searchEfforts(principal, {
        query,
        projectId,
        programId,
        limit: 10,
      });

      const formatted = results.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        status: r.status,
        projectId: r.projectId,
        snippet: (r.description ?? "").slice(0, 300),
      }));

      // Cache the formatted (display-ready) shape so a re-hit returns exactly
      // the same data structure the LLM saw the first time.
      if (ctx.runCache instanceof Map) {
        ctx.runCache.set(cacheKey, { formatted });
      }
      return {
        success: true,
        data: formatted,
        displayText: `Found ${formatted.length} effort(s) matching "${query}"`,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        forbidden: "You don't have access to this search scope.",
        badInput: "Invalid search query.",
      });
    }
  },
    );
  },
};
