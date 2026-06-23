/**
 * Built-in `list_doc_pages` tool (gap #1).
 *
 * List `projects/<slug>/docs/*.md` — the project's free-form notebook
 * separate from `wiki/`.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { listDocPages } from "../../projects/helpers.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ListDocPagesToolOptions {
  workspace?: string;
}

export function createListDocPagesTool(
  opts: ListDocPagesToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "list_doc_pages",
    riskClass: "read",
    description:
      "List `docs/*.md` files in a project. Docs are a free-form notebook (no frontmatter required) " +
      "separate from `wiki/` (which is structured + versioned). " +
      "Output: `{ project, count, pages: [{ page, bytes, updatedAt }] }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
      },
      required: ["project"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      if (!project) return { ok: false, content: "error: list_doc_pages requires 'project'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const pages = await listDocPages(workspace, project);
        if (pages === null) return { ok: false, content: `project not found: ${project}` };
        return { ok: true, content: JSON.stringify({ project, count: pages.length, pages }, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `list_doc_pages error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
