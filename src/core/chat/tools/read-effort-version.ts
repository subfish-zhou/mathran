/**
 * Built-in `read_effort_version` tool (gap #1).
 *
 * Read a specific snapshot version's `document.md`. Versions are integer N
 * created by `snapshot_effort`. Use `list_effort_versions` to discover them.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { effortDirFor } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ReadEffortVersionToolOptions {
  workspace?: string;
}

export function createReadEffortVersionTool(
  opts: ReadEffortVersionToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "read_effort_version",
    riskClass: "read",
    description:
      "Read the `document.md` from a specific snapshot version of an effort. " +
      "Versions are integer Ns created via `snapshot_effort`. " +
      "Output: `{ effort, version, document }`. Returns ok=false if the version is missing.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: { type: "string", description: "Effort slug." },
        version: { type: "number", description: "Snapshot version number (positive integer)." },
      },
      required: ["project", "effort", "version"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const effort = typeof args.effort === "string" ? args.effort : "";
      const version =
        typeof args.version === "number" && Number.isFinite(args.version)
          ? Math.floor(args.version)
          : NaN;
      if (!project) return { ok: false, content: "error: read_effort_version requires 'project'" };
      if (!effort) return { ok: false, content: "error: read_effort_version requires 'effort'" };
      if (!Number.isInteger(version) || version <= 0) {
        return { ok: false, content: "error: read_effort_version requires positive integer 'version'" };
      }
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      const file = path.join(effortDirFor(workspace, project, effort), ".versions", `v${version}`, "document.md");
      try {
        const document = await fs.readFile(file, "utf-8");
        return { ok: true, content: JSON.stringify({ effort, version, document }, null, 2) };
      } catch {
        return { ok: false, content: `version v${version} not found for ${project}/${effort}` };
      }
    },
  };
}
