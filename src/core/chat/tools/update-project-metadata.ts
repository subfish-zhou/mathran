/**
 * Built-in `update_project_metadata` tool (gap #1).
 *
 * Patch the writable subset of `project.toml`: name, description, tags.
 * Other fields (mathran_version, created_at, ...) are preserved.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { updateProjectMetadata } from "../../projects/helpers.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface UpdateProjectMetadataToolOptions {
  workspace?: string;
}

export function createUpdateProjectMetadataTool(
  opts: UpdateProjectMetadataToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "update_project_metadata",
    riskClass: "write",
    readOnly: false,
    description:
      "Patch the writable subset of `project.toml` for a project: `name`, `description`, `tags`. " +
      "Other fields (mathran_version, created_at) are preserved. At least one field must be provided. " +
      "Output: full updated TOML object.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        name: { type: "string", description: "New human-readable name." },
        description: { type: "string", description: "New short description." },
        tags: { type: "array", items: { type: "string" }, description: "New tag list." },
      },
      required: ["project"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      if (!project) return { ok: false, content: "error: update_project_metadata requires 'project'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      const patch: { name?: string; description?: string; tags?: string[] } = {};
      if (typeof args.name === "string") patch.name = args.name;
      if (typeof args.description === "string") patch.description = args.description;
      if (Array.isArray(args.tags)) patch.tags = (args.tags as unknown[]).filter((t) => typeof t === "string") as string[];
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const toml = await updateProjectMetadata(workspace, project, patch);
        return { ok: true, content: JSON.stringify(toml, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `update_project_metadata error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
