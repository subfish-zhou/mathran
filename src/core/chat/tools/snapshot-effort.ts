/**
 * Built-in `snapshot_effort` tool (gap #1).
 *
 * Take a versioned snapshot of an effort. Copies `document.md` + `files/`
 * into `.versions/v<N>/` where N = current+1, and bumps `currentVersion`.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { snapshotEffort } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface SnapshotEffortToolOptions {
  workspace?: string;
}

export function createSnapshotEffortTool(
  opts: SnapshotEffortToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "snapshot_effort",
    riskClass: "write",
    description:
      "Take a versioned snapshot of an effort: copies `document.md` + `files/` into " +
      "`.versions/v<N>/` (N = currentVersion + 1) and bumps `currentVersion` in effort.toml. " +
      "Output: `{ effort, version }`.",
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
      if (!project) return { ok: false, content: "error: snapshot_effort requires 'project'" };
      if (!effort) return { ok: false, content: "error: snapshot_effort requires 'effort'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const version = await snapshotEffort(workspace, project, effort);
        return { ok: true, content: JSON.stringify({ effort, version }, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `snapshot_effort error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
