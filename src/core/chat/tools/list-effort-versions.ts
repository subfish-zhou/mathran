/**
 * Built-in `list_effort_versions` tool (gap #1).
 *
 * List the snapshot versions for an effort (the integer N's under
 * `.versions/v<N>/`).
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { listSnapshots, readEffortMetadata } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ListEffortVersionsToolOptions {
  workspace?: string;
}

export function createListEffortVersionsTool(
  opts: ListEffortVersionsToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "list_effort_versions",
    riskClass: "read",
    readOnly: true,
    description:
      "List the snapshot versions of an effort. Each version was created by a `snapshot_effort` " +
      "call and contains a frozen copy of document.md + files/. " +
      "Output: `{ effort, currentVersion, versions: [N, ...] }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: { type: "string", description: "Effort slug." },
      },
      required: ["project", "effort"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const effort = typeof args.effort === "string" ? args.effort : "";
      if (!project) return { ok: false, content: "error: list_effort_versions requires 'project'" };
      if (!effort) return { ok: false, content: "error: list_effort_versions requires 'effort'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const meta = await readEffortMetadata(workspace, project, effort);
        if (!meta) return { ok: false, content: `effort not found: ${project}/${effort}` };
        const versions = await listSnapshots(workspace, project, effort);
        return {
          ok: true,
          content: JSON.stringify(
            { effort, currentVersion: meta.currentVersion, versions },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `list_effort_versions error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
