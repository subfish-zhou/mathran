/**
 * Built-in `list_projects` tool (gap #1).
 *
 * Enumerate every project in the workspace.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { listAllProjects } from "../../projects/helpers.js";

export interface ListProjectsToolOptions {
  workspace?: string;
}

export function createListProjectsTool(
  opts: ListProjectsToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "list_projects",
    riskClass: "read",
    description:
      "List every project in this mathran workspace (each is a directory under `projects/<slug>/` " +
      "with a `project.toml`). " +
      "Output: `{ count, projects: [{ slug, name, created_at, mathran_version }] }`.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const projects = await listAllProjects(workspace);
        return {
          ok: true,
          content: JSON.stringify({ count: projects.length, projects }, null, 2),
        };
      } catch (err: any) {
        return { ok: false, content: `list_projects error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
