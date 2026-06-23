/**
 * Built-in `update_effort_metadata` tool (gap #1).
 *
 * Patch a small subset of `effort.toml` fields (title, description, status,
 * type). For guarded status transitions with audit history, use
 * `transition_effort_status` instead — this tool is the freeform bulk-edit
 * loophole.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { updateEffortMetadata } from "../../effort/store.js";
import { BUILTIN_EFFORT_TYPES, EFFORT_STATUSES, isBuiltinEffortType, isEffortStatus } from "../../effort/types.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface UpdateEffortMetadataToolOptions {
  workspace?: string;
}

export function createUpdateEffortMetadataTool(
  opts: UpdateEffortMetadataToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "update_effort_metadata",
    riskClass: "write",
    readOnly: false,
    description:
      "Patch effort.toml fields (title, description, status, type). Freeform — bypasses the " +
      "VALID_TRANSITIONS state machine. For audited status transitions use " +
      "`transition_effort_status`. " +
      `Valid types: ${BUILTIN_EFFORT_TYPES.join(", ")}. ` +
      `Valid statuses: ${EFFORT_STATUSES.join(", ")}. ` +
      "Output: full updated metadata object.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: { type: "string", description: "Effort slug." },
        title: { type: "string", description: "Optional new title." },
        description: { type: "string", description: "Optional new description." },
        status: { type: "string", description: "Optional new status (use transition_effort_status for guarded changes)." },
        type: { type: "string", description: "Optional new type." },
      },
      required: ["project", "effort"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const effort = typeof args.effort === "string" ? args.effort : "";
      if (!project) return { ok: false, content: "error: update_effort_metadata requires 'project'" };
      if (!effort) return { ok: false, content: "error: update_effort_metadata requires 'effort'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      const patch: Record<string, string> = {};
      if (typeof args.title === "string") patch.title = args.title;
      if (typeof args.description === "string") patch.description = args.description;
      if (typeof args.status === "string") {
        if (!isEffortStatus(args.status)) {
          return { ok: false, content: `error: invalid status '${args.status}'` };
        }
        patch.status = args.status;
      }
      if (typeof args.type === "string") {
        if (!isBuiltinEffortType(args.type)) {
          return { ok: false, content: `error: invalid type '${args.type}'` };
        }
        patch.type = args.type;
      }
      if (Object.keys(patch).length === 0) {
        return { ok: false, content: "error: no fields to update (title/description/status/type)" };
      }
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const meta = await updateEffortMetadata(workspace, project, effort, patch as any);
        return { ok: true, content: JSON.stringify(meta, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `update_effort_metadata error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
