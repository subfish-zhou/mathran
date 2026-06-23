/**
 * Built-in `read_effort` tool (gap #1).
 *
 * Read both metadata + document.md of a workspace effort. Use this whenever
 * the LLM needs the *contents* of a known effort; use `list_efforts` first
 * if the slug is unknown.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { readEffortMetadata, readEffortDocument } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ReadEffortToolOptions {
  workspace?: string;
}

export function createReadEffortTool(
  opts: ReadEffortToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "read_effort",
    riskClass: "read",
    readOnly: true,
    description:
      "Read a workspace effort: returns `effort.toml` metadata (id, type, status, statusHistory, ...) " +
      "and the full `document.md` body. " +
      "Use `list_efforts` first if the slug is unknown. " +
      "Output: `{ project, effort, metadata: {...}, document }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        effort: { type: "string", description: "Effort slug (directory name)." },
      },
      required: ["project", "effort"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const effort = typeof args.effort === "string" ? args.effort : "";
      if (!project) return { ok: false, content: "error: read_effort requires 'project'" };
      if (!effort) return { ok: false, content: "error: read_effort requires 'effort'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(effort)) return { ok: false, content: `error: invalid effort slug '${effort}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const meta = await readEffortMetadata(workspace, project, effort);
        if (!meta) return { ok: false, content: `effort not found: ${project}/${effort}` };
        const doc = await readEffortDocument(workspace, project, effort);
        return {
          ok: true,
          content: JSON.stringify(
            {
              project,
              effort,
              metadata: meta,
              document: doc ?? "",
            },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `read_effort error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
