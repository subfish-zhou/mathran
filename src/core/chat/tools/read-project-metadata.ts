/**
 * Built-in `read_project_metadata` tool (gap #1).
 *
 * Return parsed `project.toml` plus top-level directory entries (so the LLM
 * sees what's inside without needing a separate `list_dir`).
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { readProjectDetails } from "../../projects/helpers.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ReadProjectMetadataToolOptions {
  workspace?: string;
}

export function createReadProjectMetadataTool(
  opts: ReadProjectMetadataToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "read_project_metadata",
    riskClass: "read",
    description:
      "Read a project's `project.toml` and the top-level entries of `projects/<slug>/`. " +
      "Output: `{ slug, project: {...toml...}, entries: ['wiki/', 'efforts/', 'project.toml', ...] }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
      },
      required: ["project"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      if (!project) return { ok: false, content: "error: read_project_metadata requires 'project'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const d = await readProjectDetails(workspace, project);
        if (!d) return { ok: false, content: `project not found: ${project}` };
        return { ok: true, content: JSON.stringify(d, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `read_project_metadata error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
