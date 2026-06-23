/**
 * Built-in `update_wiki_page` tool (gap #1).
 *
 * Overwrite an existing wiki page; fails if it does not exist (use
 * `create_wiki_page` then). Bumps the page version and snapshots the
 * previous content to `.history/<page>/v<oldVersion>.md`.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { updateWikiPage, isSafeSlug } from "../../wiki/store.js";

export interface UpdateWikiPageToolOptions {
  workspace?: string;
}

export function createUpdateWikiPageTool(
  opts: UpdateWikiPageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "update_wiki_page",
    riskClass: "write",
    readOnly: false,
    description:
      "Update (overwrite) an existing wiki page. Fails (ok=false) if the page does not exist — " +
      "use `create_wiki_page` first. The previous body is automatically snapshotted into " +
      "`.history/<page>/v<N>.md` and `version` is bumped. Output: `{ page, version, title }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        page: { type: "string", description: "Existing wiki page slug." },
        body: { type: "string", description: "Full replacement markdown body (no frontmatter)." },
        title: { type: "string", description: "Optional new title; defaults to previous." },
        parent: { type: "string", description: "Optional new parent page slug." },
        sortOrder: { type: "number", description: "Optional new sort order." },
        tags: { type: "array", items: { type: "string" }, description: "Optional new tag list." },
      },
      required: ["project", "page", "body"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      const body = typeof args.body === "string" ? args.body : null;
      if (!project) return { ok: false, content: "error: update_wiki_page requires 'project'" };
      if (!page) return { ok: false, content: "error: update_wiki_page requires 'page'" };
      if (body === null) return { ok: false, content: "error: update_wiki_page requires 'body' (string)" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid wiki page slug '${page}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      const title = typeof args.title === "string" ? args.title : undefined;
      const parent = typeof args.parent === "string" ? args.parent : undefined;
      const sortOrder = typeof args.sortOrder === "number" ? args.sortOrder : undefined;
      const tags = Array.isArray(args.tags)
        ? (args.tags.filter((t) => typeof t === "string") as string[])
        : undefined;
      try {
        const r = await updateWikiPage(workspace, project, page, body, {
          ...(title !== undefined ? { title } : {}),
          ...(parent !== undefined ? { parent } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {}),
          ...(tags !== undefined ? { tags } : {}),
        });
        return {
          ok: true,
          content: JSON.stringify(
            { page: r.page, version: r.version, title: r.frontmatter.title ?? r.page },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `update_wiki_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
