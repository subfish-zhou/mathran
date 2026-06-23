/**
 * Built-in `transition_effort_status` tool (gap #1).
 *
 * Guarded status transition — enforces VALID_TRANSITIONS and required
 * fields (reason for DEAD_END/ERRATUM, supersededBy for SUPERSEDED).
 * Appends a `statusHistory` entry on success.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { transitionEffortStatus } from "../../effort/store.js";
import { EFFORT_STATUSES, isEffortStatus, type EffortStatus } from "../../effort/types.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface TransitionEffortStatusToolOptions {
  workspace?: string;
}

export function createTransitionEffortStatusTool(
  opts: TransitionEffortStatusToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "transition_effort_status",
    riskClass: "write",
    readOnly: false,
    description:
      "Apply a guarded status transition to a workspace effort. Enforces VALID_TRANSITIONS — " +
      "DEAD_END / ERRATUM require `reason`, SUPERSEDED requires `supersededBy` (target slug in " +
      `same project). Valid statuses: ${EFFORT_STATUSES.join(", ")}. ` +
      "On success appends a statusHistory entry. " +
      "Output (success): `{ ok: true, from, to }`. Output (failure): `{ ok: false, reason, ...details }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: { type: "string", description: "Effort slug." },
        to: { type: "string", description: "Target status." },
        reason: { type: "string", description: "Required for DEAD_END / ERRATUM." },
        supersededBy: { type: "string", description: "Required for SUPERSEDED: slug of superseding effort." },
      },
      required: ["project", "effort", "to"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const effort = typeof args.effort === "string" ? args.effort : "";
      const to = typeof args.to === "string" ? args.to : "";
      if (!project) return { ok: false, content: "error: transition_effort_status requires 'project'" };
      if (!effort) return { ok: false, content: "error: transition_effort_status requires 'effort'" };
      if (!to) return { ok: false, content: "error: transition_effort_status requires 'to'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      if (!isEffortStatus(to)) return { ok: false, content: `error: invalid target status '${to}'` };
      const reason = typeof args.reason === "string" ? args.reason : undefined;
      const supersededBy = typeof args.supersededBy === "string" ? args.supersededBy : undefined;
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const result = await transitionEffortStatus(workspace, project, effort, {
          to: to as EffortStatus,
          ...(reason !== undefined ? { reason } : {}),
          ...(supersededBy !== undefined ? { supersededBy } : {}),
        });
        if (!result.ok) {
          return { ok: false, content: JSON.stringify(result, null, 2) };
        }
        return { ok: true, content: JSON.stringify(result, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `transition_effort_status error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
