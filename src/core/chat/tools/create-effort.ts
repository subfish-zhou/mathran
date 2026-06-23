/**
 * Built-in `create_effort` tool (gap #1).
 *
 * Scaffold a new workspace effort. Required: project slug, title, type
 * (one of BUILTIN_EFFORT_TYPES). Optional: explicit slug, description.
 * Fails if slug already exists (no `force` exposed to the LLM by default).
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { initEffort } from "../../effort/store.js";
import { BUILTIN_EFFORT_TYPES, isBuiltinEffortType } from "../../effort/types.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface CreateEffortToolOptions {
  workspace?: string;
}

export function createCreateEffortTool(
  opts: CreateEffortToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "create_effort",
    riskClass: "write",
    description:
      "Scaffold a new workspace effort inside a project. Creates the effort directory with " +
      "`effort.toml` (status=DRAFT) + empty `document.md` + `files/`. " +
      `'type' must be one of: ${BUILTIN_EFFORT_TYPES.join(", ")}. ` +
      "Slug defaults to a sanitized version of `title`. Fails if slug already exists. " +
      "Output: `{ slug, title, type, status: 'DRAFT' }`.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        title: { type: "string", description: "Human-readable title." },
        type: {
          type: "string",
          description: `One of: ${BUILTIN_EFFORT_TYPES.join(", ")}.`,
        },
        slug: { type: "string", description: "Optional explicit slug (lowercase alnum + - _ .)." },
        description: { type: "string", description: "Optional short abstract." },
      },
      required: ["project", "title", "type"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const title = typeof args.title === "string" ? args.title : "";
      const type = typeof args.type === "string" ? args.type : "";
      if (!project) return { ok: false, content: "error: create_effort requires 'project'" };
      if (!title) return { ok: false, content: "error: create_effort requires 'title'" };
      if (!type) return { ok: false, content: "error: create_effort requires 'type'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isBuiltinEffortType(type)) {
        return {
          ok: false,
          content: `error: invalid type '${type}' (must be one of: ${BUILTIN_EFFORT_TYPES.join(", ")})`,
        };
      }
      const explicitSlug = typeof args.slug === "string" ? args.slug : undefined;
      const description = typeof args.description === "string" ? args.description : undefined;
      if (explicitSlug !== undefined && !isSafeSlug(explicitSlug)) {
        return { ok: false, content: `error: invalid effort slug '${explicitSlug}'` };
      }
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        const r = await initEffort(workspace, project, {
          title,
          type,
          ...(explicitSlug !== undefined ? { slug: explicitSlug } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        return {
          ok: true,
          content: JSON.stringify(
            { slug: r.slug, title: r.metadata.title, type: r.metadata.type, status: r.metadata.status },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return { ok: false, content: `create_effort error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
