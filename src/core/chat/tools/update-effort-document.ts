/**
 * Built-in `update_effort_document` tool (gap #1).
 *
 * Replace the full `document.md` of an effort. Bumps `updatedAt`.
 * For appends use `append_effort_document` instead.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { writeEffortDocument } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface UpdateEffortDocumentToolOptions {
  workspace?: string;
}

export function createUpdateEffortDocumentTool(
  opts: UpdateEffortDocumentToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "update_effort_document",
    riskClass: "write",
    readOnly: false,
    description:
      "Replace the full `document.md` body of a workspace effort. Use this when rewriting the " +
      "whole document; for incremental notes use `append_effort_document` instead. " +
      "Output: `{ effort, bytes }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: { type: "string", description: "Effort slug." },
        body: { type: "string", description: "Full new document.md contents (markdown)." },
      },
      required: ["project", "effort", "body"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const effort = typeof args.effort === "string" ? args.effort : "";
      const body = typeof args.body === "string" ? args.body : null;
      if (!project) return { ok: false, content: "error: update_effort_document requires 'project'" };
      if (!effort) return { ok: false, content: "error: update_effort_document requires 'effort'" };
      if (body === null) return { ok: false, content: "error: update_effort_document requires 'body'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        await writeEffortDocument(workspace, project, effort, body);
        return {
          ok: true,
          content: JSON.stringify(
            { effort, bytes: Buffer.byteLength(body, "utf-8") },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `update_effort_document error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
