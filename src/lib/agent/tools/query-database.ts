import { wikiPages, workspaceEfforts, threads } from "@/server/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { projectMembers } from "@/server/db/schema";
import type { ToolDefinition } from "./types";

const METRICS = ["member_count", "effort_count", "thread_count", "wiki_page_count"] as const;

export const queryDatabaseTool: ToolDefinition = {
  name: "query_database",
  description:
    "Query predefined project metrics. Available metrics: member_count, effort_count, thread_count, wiki_page_count.",
  parameters: {
    type: "object",
    properties: {
      metric: {
        type: "string",
        enum: METRICS,
        description: "The metric to query",
      },
      projectId: { type: "string", description: "The project ID to query" },
    },
    required: ["metric", "projectId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    const metric = String(args.metric) as (typeof METRICS)[number];
    // P0-4: project scope is a server capability, not an LLM-supplied ID.
    const projectId = ctx.projectId;

    if (!projectId) {
      return { success: false, data: null, displayText: "No project context available" };
    }

    if (!METRICS.includes(metric)) {
      return { success: false, data: null, displayText: `Unknown metric: ${metric}. Available: ${METRICS.join(", ")}` };
    }

    let count = 0;
    let label = "";

    switch (metric) {
      case "member_count": {
        const [row] = await ctx.db
          .select({ count: sql<number>`count(*)::int` })
          .from(projectMembers)
          .where(eq(projectMembers.projectId, projectId));
        count = row?.count ?? 0;
        label = "members";
        break;
      }
      case "effort_count": {
        const [row] = await ctx.db
          .select({ count: sql<number>`count(*)::int` })
          .from(workspaceEfforts)
          .where(and(eq(workspaceEfforts.projectId, projectId), eq(workspaceEfforts.isDeleted, false)));
        count = row?.count ?? 0;
        label = "workspace efforts";
        break;
      }
      case "thread_count": {
        const [row] = await ctx.db
          .select({ count: sql<number>`count(*)::int` })
          .from(threads)
          .where(and(eq(threads.projectId, projectId), eq(threads.isDeleted, false)));
        count = row?.count ?? 0;
        label = "forum threads";
        break;
      }
      case "wiki_page_count": {
        const [row] = await ctx.db
          .select({ count: sql<number>`count(*)::int` })
          .from(wikiPages)
          .where(and(eq(wikiPages.projectId, projectId), eq(wikiPages.isDeleted, false)));
        count = row?.count ?? 0;
        label = "wiki pages";
        break;
      }
    }

    return {
      success: true,
      data: { metric, count, projectId },
      displayText: `Project has ${count} ${label}`,
    };
  },
};
