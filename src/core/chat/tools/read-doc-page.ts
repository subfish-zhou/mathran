/**
 * Built-in `read_doc_page` tool (gap #1).
 *
 * Read `docs/<page>.md` body as plain markdown (no frontmatter parsing).
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { readDocPage } from "../../projects/helpers.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ReadDocPageToolOptions {
  workspace?: string;
}

export function createReadDocPageTool(
  opts: ReadDocPageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "read_doc_page",
    riskClass: "read",
    readOnly: true,
    description:
      "Read a doc page (`docs/<page>.md`) verbatim — no frontmatter parsing. " +
      "Output: `{ project, page, content }`. Returns ok=false if the file is missing.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        page: { type: "string", description: "Doc page slug (filename without `.md`)." },
      },
      required: ["project", "page"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const page = typeof args.page === "string" ? args.page : "";
      if (!project) return { ok: false, content: "error: read_doc_page requires 'project'" };
      if (!page) return { ok: false, content: "error: read_doc_page requires 'page'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(page)) return { ok: false, content: `error: invalid doc page slug '${page}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const content = await readDocPage(workspace, project, page);
        if (content === null) return { ok: false, content: `doc page not found: ${project}/${page}` };
        return { ok: true, content: JSON.stringify({ project, page, content }, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `read_doc_page error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
