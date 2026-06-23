/**
 * Built-in `delete_wiki_page` tool (gap #1).
 *
 * Soft-delete: sets `frontmatter.deleted = true` on the page and bumps
 * `version`. The on-disk file stays so the page can be undeleted via
 * `update_wiki_page` (which leaves `deleted` flag unless rewritten).
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { softDeleteWikiPage, isSafeSlug } from "../../wiki/store.js";

export interface DeleteWikiPageToolOptions {
  workspace?: string;
}

export function createDeleteWikiPageTool(
  opts: DeleteWikiPageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "delete_wiki_page",
    riskClass: "write",
    readOnly: false,
    description:
      "Soft-delete a wiki page by setting `frontmatter.deleted = true` and bumping the version. " +
      "The page contents are preserved on disk (so `update_wiki_page` can resurrect it). " +
      "Fails if the page does not exist. Output: `{ page, version, deleted: true }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        page: { type: "string", description: "Existing wiki page slug." },
      },
      required: ["project", "page"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      if (!project) return { ok: false, content: "error: delete_wiki_page requires 'project'" };
      if (!page) return { ok: false, content: "error: delete_wiki_page requires 'page'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid wiki page slug '${page}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const r = await softDeleteWikiPage(workspace, project, page);
        return {
          ok: true,
          content: JSON.stringify(
            { page: r.page, version: r.version, deleted: r.frontmatter.deleted === true },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `delete_wiki_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
