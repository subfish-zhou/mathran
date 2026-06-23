/**
 * Built-in `list_wiki_pages` tool (gap #1).
 *
 * Enumerate every wiki page in a project. Stable order: sortOrder, then
 * page slug. Returns the slug, title, parent, sortOrder, tags, and version
 * — enough for the LLM to choose which page to `read_wiki_page` next.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { listWikiPages, isSafeSlug } from "../../wiki/store.js";

export interface ListWikiPagesToolOptions {
  workspace?: string;
}

export function createListWikiPagesTool(
  opts: ListWikiPagesToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "list_wiki_pages",
    riskClass: "read",
    readOnly: true,
    description:
      "List every wiki page in a mathran project. Use this to discover what wiki pages exist before calling `read_wiki_page`. " +
      "Output is a JSON-encoded object: `{ project, count, pages: [{ page, title, parent, sortOrder, version, tags, deleted }] }`. " +
      "Soft-deleted pages are included with `deleted: true` so callers can filter them.",
    parameters: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project slug (e.g. 'liouville-rieman').",
        },
      },
      required: ["project"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      if (!project) return { ok: false, content: "error: list_wiki_pages requires 'project'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const pages = await listWikiPages(workspace, project);
        if (pages === null) return { ok: false, content: `project not found: ${project}` };
        return {
          ok: true,
          content: JSON.stringify({ project, count: pages.length, pages }, null, 2),
        };
      } catch (err: any) {
        return { ok: false, content: `list_wiki_pages error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
