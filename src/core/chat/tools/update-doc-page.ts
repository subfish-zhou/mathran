/**
 * Built-in `update_doc_page` tool (gap #1).
 *
 * Overwrite `projects/<slug>/docs/<page>.md`. Fails if file is missing.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { updateDocPage } from "../../projects/helpers.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface UpdateDocPageToolOptions {
  workspace?: string;
}

export function createUpdateDocPageTool(
  opts: UpdateDocPageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "update_doc_page",
    riskClass: "write",
    description:
      "Overwrite an existing `docs/<page>.md` in a project. Fails (ok=false) if the file does not " +
      "exist — use `create_doc_page` first. Body is written verbatim. Output: `{ page, bytes }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        page: { type: "string", description: "Existing doc page slug." },
        body: { type: "string", description: "New full markdown body." },
      },
      required: ["project", "page", "body"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      const body = typeof args.body === "string" ? args.body : null;
      if (!project) return { ok: false, content: "error: update_doc_page requires 'project'" };
      if (!page) return { ok: false, content: "error: update_doc_page requires 'page'" };
      if (body === null) return { ok: false, content: "error: update_doc_page requires 'body'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid doc page slug '${page}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const r = await updateDocPage(workspace, project, page, body);
        return { ok: true, content: JSON.stringify(r, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `update_doc_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
