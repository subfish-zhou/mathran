/**
 * Wiki Agent Tools — tool definitions for the wiki agent loop.
 *
 * These tools allow the agent to read efforts, wiki pages, and search
 * the workspace on demand (no truncation), then output generated pages
 * via write_wiki_page.
 */

import type { ToolDefinition, ToolContext, ToolResult } from "./tools/types";
// TODO(mathran-v0.1): import { workspaceEfforts } from "@/server/db/schema/workspace";
// TODO(mathran-v0.1): import { wikiPages } from "@/server/db/schema/wiki";
import { eq, and, sql } from "drizzle-orm";
import { extractWorkspaceRefs } from "./ref-utils";
import type { WikiPageOutput } from "./init-types";

export function createWikiTools(collectedPages: WikiPageOutput[]): ToolDefinition[] {
  const listEfforts: ToolDefinition = {
    name: "list_efforts",
    description:
      "List all workspace efforts for the project. Returns id, title, type, status, and full description for each effort.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    projectOnly: true,
    async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.projectId) {
        return { success: false, data: null, displayText: "No projectId in context" };
      }
      const results = await ctx.db
        .select({
          id: workspaceEfforts.id,
          title: workspaceEfforts.title,
          type: workspaceEfforts.type,
          status: workspaceEfforts.status,
          description: workspaceEfforts.description,
        })
        .from(workspaceEfforts)
        .where(
          and(
            eq(workspaceEfforts.projectId, ctx.projectId),
            eq(workspaceEfforts.isDeleted, false),
          ),
        );
      return {
        success: true,
        data: results,
        displayText: `Found ${results.length} efforts`,
      };
    },
  };

  const readEffort: ToolDefinition = {
    name: "read_effort",
    description:
      "Read a single workspace effort with its full document content (no truncation). Returns id, title, type, status, description, and document.",
    parameters: {
      type: "object",
      properties: {
        effortId: { type: "string", description: "The effort ID to read" },
      },
      required: ["effortId"],
    },
    projectOnly: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.projectId) {
        return { success: false, data: null, displayText: "No projectId in context" };
      }
      const effortId = args.effortId as string;
      if (!effortId) {
        return { success: false, data: null, displayText: "effortId is required" };
      }
      const [result] = await ctx.db
        .select({
          id: workspaceEfforts.id,
          title: workspaceEfforts.title,
          type: workspaceEfforts.type,
          status: workspaceEfforts.status,
          description: workspaceEfforts.description,
          document: workspaceEfforts.document,
        })
        .from(workspaceEfforts)
        .where(
          and(
            eq(workspaceEfforts.id, effortId),
            eq(workspaceEfforts.projectId, ctx.projectId),
          ),
        )
        .limit(1);
      if (!result) {
        return { success: false, data: null, displayText: `Effort ${effortId} not found` };
      }
      return {
        success: true,
        data: result,
        displayText: `Read effort: ${result.title}`,
      };
    },
  };

  const readWikiPage: ToolDefinition = {
    name: "read_wiki_page",
    description:
      "Read an existing wiki page by slug. Returns slug, title, and full content (no truncation).",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The wiki page slug to read" },
      },
      required: ["slug"],
    },
    projectOnly: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.projectId) {
        return { success: false, data: null, displayText: "No projectId in context" };
      }
      const slug = args.slug as string;
      if (!slug) {
        return { success: false, data: null, displayText: "slug is required" };
      }
      const [result] = await ctx.db
        .select({
          slug: wikiPages.slug,
          title: wikiPages.title,
          content: wikiPages.content,
        })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.slug, slug),
            eq(wikiPages.projectId, ctx.projectId),
            eq(wikiPages.isDeleted, false),
          ),
        )
        .limit(1);
      if (!result) {
        return { success: false, data: null, displayText: `Wiki page "${slug}" not found` };
      }
      return {
        success: true,
        data: result,
        displayText: `Read wiki page: ${result.title}`,
      };
    },
  };

  const searchEfforts: ToolDefinition = {
    name: "search_efforts",
    description:
      "Search workspace efforts by keyword (case-insensitive). Matches against title, description, and document columns.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search keyword or phrase" },
      },
      required: ["query"],
    },
    projectOnly: true,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.projectId) {
        return { success: false, data: null, displayText: "No projectId in context" };
      }
      const query = args.query as string;
      if (!query) {
        return { success: false, data: null, displayText: "query is required" };
      }
      const pattern = `%${query}%`;
      const results = await ctx.db
        .select({
          id: workspaceEfforts.id,
          title: workspaceEfforts.title,
          type: workspaceEfforts.type,
          status: workspaceEfforts.status,
          description: workspaceEfforts.description,
        })
        .from(workspaceEfforts)
        .where(
          and(
            eq(workspaceEfforts.projectId, ctx.projectId),
            eq(workspaceEfforts.isDeleted, false),
            sql`(${workspaceEfforts.title} ILIKE ${pattern} OR ${workspaceEfforts.description} ILIKE ${pattern} OR ${workspaceEfforts.document} ILIKE ${pattern})`,
          ),
        );
      return {
        success: true,
        data: results,
        displayText: `Found ${results.length} efforts matching "${query}"`,
      };
    },
  };

  const writeWikiPage: ToolDefinition = {
    name: "write_wiki_page",
    description:
      "Output a generated wiki page. The page is collected for later use. Content should include the [AI-GENERATED] tag and proper LaTeX formatting.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The wiki page slug" },
        title: { type: "string", description: "The wiki page title" },
        content: { type: "string", description: "The full markdown content of the wiki page" },
        changeSummary: { type: "string", description: "Optional summary of changes made" },
      },
      required: ["slug", "title", "content"],
    },
    projectOnly: true,
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const slug = args.slug as string;
      const title = args.title as string;
      let content = args.content as string;

      if (!slug || !title || !content) {
        return { success: false, data: null, displayText: "slug, title, and content are required" };
      }

      // Ensure AI-GENERATED tag
      if (!content.includes("[AI-GENERATED]")) {
        content = `> [AI-GENERATED] This content was automatically generated and requires human review.\n\n${content}`;
      }

      const workspaceRefs = extractWorkspaceRefs(content);

      collectedPages.push({
        slug,
        title,
        content,
        workspaceRefs,
      });

      return {
        success: true,
        data: { slug },
        displayText: `Wiki page "${title}" (${slug}) written successfully`,
      };
    },
  };

  return [listEfforts, readEffort, readWikiPage, searchEfforts, writeWikiPage];
}
