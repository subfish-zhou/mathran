/**
 * Built-in `search_wiki` tool (gap #1).
 *
 * Naive case-insensitive substring search across every wiki page body
 * in a project. v2 will swap this for embeddings.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { searchWiki, isSafeSlug } from "../../wiki/store.js";

export interface SearchWikiToolOptions {
  workspace?: string;
}

export function createSearchWikiTool(
  opts: SearchWikiToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "search_wiki",
    riskClass: "read",
    description:
      "Search the wiki of a project for a case-insensitive substring. Returns up to `limit` hits " +
      "(default 20, max 100), one per matching page (first line that contains the query). " +
      "Use this to discover relevant pages before `read_wiki_page`. " +
      "Output: `{ project, query, count, hits: [{ page, title, line, snippet }] }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        query: { type: "string", description: "Substring (case-insensitive) to grep for." },
        limit: {
          type: "number",
          description: "Maximum hits to return (1..100). Defaults to 20.",
        },
      },
      required: ["project", "query"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const query = typeof args.query === "string" ? args.query : "";
      if (!project) return { ok: false, content: "error: search_wiki requires 'project'" };
      if (!query.trim()) return { ok: false, content: "error: search_wiki requires non-empty 'query'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(100, Math.floor(args.limit)))
          : 20;
      try {
        const hits = await searchWiki(workspace, project, query, { limit });
        return {
          ok: true,
          content: JSON.stringify({ project, query, count: hits.length, hits }, null, 2),
        };
      } catch (err: any) {
        return { ok: false, content: `search_wiki error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
