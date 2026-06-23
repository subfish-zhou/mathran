/**
 * Built-in `append_effort_document` tool (gap #1).
 *
 * Append a markdown chunk to `document.md`. Cheap counterpart to
 * `update_effort_document` for incremental note-taking.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { appendEffortDocument } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface AppendEffortDocumentToolOptions {
  workspace?: string;
}

export function createAppendEffortDocumentTool(
  opts: AppendEffortDocumentToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "append_effort_document",
    riskClass: "write",
    readOnly: false,
    description:
      "Append a markdown chunk to the end of `document.md` (with one leading newline if the file " +
      "is already non-empty). Use this for streaming notes; for full rewrites use " +
      "`update_effort_document`. Output: `{ effort, bytes }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: { type: "string", description: "Effort slug." },
        body: { type: "string", description: "Markdown chunk to append." },
      },
      required: ["project", "effort", "body"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const effort = typeof args.effort === "string" ? args.effort : "";
      const body = typeof args.body === "string" ? args.body : null;
      if (!project) return { ok: false, content: "error: append_effort_document requires 'project'" };
      if (!effort) return { ok: false, content: "error: append_effort_document requires 'effort'" };
      if (body === null) return { ok: false, content: "error: append_effort_document requires 'body'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        await appendEffortDocument(workspace, project, effort, body);
        return {
          ok: true,
          content: JSON.stringify({ effort, bytes: Buffer.byteLength(body, "utf-8") }, null, 2),
        };
      } catch (err: any) {
        return { ok: false, content: `append_effort_document error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
