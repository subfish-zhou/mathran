/**
 * Built-in `list_effort_relations` tool (gap #1).
 *
 * Read the edge set for a project. When `effort` is given, returns both
 * outgoing (`from === effort`) and incoming (`to === effort`) edges so the
 * LLM can quickly inspect the local neighborhood.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import {
  listAllRelations,
  listEffortRelations,
  listEffortDependents,
} from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ListEffortRelationsToolOptions {
  workspace?: string;
}

export function createListEffortRelationsTool(
  opts: ListEffortRelationsToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "list_effort_relations",
    riskClass: "read",
    description:
      "List effort relations. When `effort` is given, returns `{ outgoing, incoming }` — outgoing " +
      "are edges from this effort; incoming are edges pointing at it (its dependents). When " +
      "`effort` is omitted, returns every edge in the project. " +
      "Output: `{ project, effort, outgoing?, incoming?, edges? }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: {
          type: "string",
          description: "Optional effort slug. If given, restrict to edges touching this effort.",
        },
      },
      required: ["project"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      if (!project) return { ok: false, content: "error: list_effort_relations requires 'project'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      const effort = typeof args.effort === "string" ? args.effort : "";
      if (effort && !isSafeSlug(effort)) {
        return { ok: false, content: `error: invalid effort slug '${effort}'` };
      }
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        if (effort) {
          const outgoing = await listEffortRelations(workspace, project, effort);
          const incoming = await listEffortDependents(workspace, project, effort);
          return {
            ok: true,
            content: JSON.stringify({ project, effort, outgoing, incoming }, null, 2),
          };
        }
        const edges = await listAllRelations(workspace, project);
        return { ok: true, content: JSON.stringify({ project, count: edges.length, edges }, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `list_effort_relations error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
