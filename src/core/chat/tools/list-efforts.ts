/**
 * Built-in `list_efforts` tool (gap #1).
 *
 * Enumerate workspace efforts in a project. Returns metadata only (slug,
 * title, type, status, currentVersion, updatedAt, ...), not document/file
 * contents. Use `read_effort` for the full body.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { listEfforts } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface ListEffortsToolOptions {
  workspace?: string;
}

export function createListEffortsTool(
  opts: ListEffortsToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "list_efforts",
    riskClass: "read",
    readOnly: true,
    description:
      "List every workspace effort in a mathran project. Each effort is a directory under " +
      "`projects/<slug>/efforts/<effort-slug>/` and represents one unit of mathematical work " +
      "(proof attempt, construction, computation, ...). Returns metadata only — call `read_effort` " +
      "for the document body. " +
      "Output: `{ project, count, efforts: [{ slug, title, type, status, currentVersion, updatedAt }] }`.",
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
      if (!project) return { ok: false, content: "error: list_efforts requires 'project'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const efforts = await listEfforts(workspace, project);
        return {
          ok: true,
          content: JSON.stringify(
            {
              project,
              count: efforts.length,
              efforts: efforts.map((e) => ({
                slug: e.slug,
                title: e.title,
                type: e.type,
                status: e.status,
                currentVersion: e.currentVersion,
                updatedAt: e.updatedAt,
              })),
            },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `list_efforts error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
