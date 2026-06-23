/**
 * Built-in `create_doc_page` tool (gap #1).
 *
 * Create `projects/<slug>/docs/<page>.md`. Fails if it already exists.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { createDocPage } from "../../projects/helpers.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface CreateDocPageToolOptions {
  workspace?: string;
}

export function createCreateDocPageTool(
  opts: CreateDocPageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "create_doc_page",
    riskClass: "write",
    description:
      "Create a new `docs/<page>.md` in a project. Fails (ok=false) if the page already exists — " +
      "use `update_doc_page` then. No frontmatter is added; the body is written verbatim. " +
      "Output: `{ page, bytes }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        page: { type: "string", description: "New doc page slug." },
        body: { type: "string", description: "Markdown body (no frontmatter required)." },
      },
      required: ["project", "page", "body"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      const body = typeof args.body === "string" ? args.body : null;
      if (!project) return { ok: false, content: "error: create_doc_page requires 'project'" };
      if (!page) return { ok: false, content: "error: create_doc_page requires 'page'" };
      if (body === null) return { ok: false, content: "error: create_doc_page requires 'body'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid doc page slug '${page}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const r = await createDocPage(workspace, project, page, body);
        return { ok: true, content: JSON.stringify(r, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `create_doc_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
