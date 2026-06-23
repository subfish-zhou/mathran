/**
 * Built-in `add_effort_relation` tool (gap #1).
 *
 * Add a typed edge between two efforts in the same project.
 * (e.g. proof_attempt --depends_on--> construction).
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import { addRelation, VALID_RELATION_TYPES, readEffortMetadata } from "../../effort/store.js";
import { isSafeSlug } from "../../wiki/store.js";

export interface AddEffortRelationToolOptions {
  workspace?: string;
}

export function createAddEffortRelationTool(
  opts: AddEffortRelationToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  return {
    name: "add_effort_relation",
    riskClass: "write",
    description:
      "Add a typed relationship edge between two efforts in the same project. " +
      `Valid types: ${VALID_RELATION_TYPES.join(", ")}. ` +
      "Both efforts must already exist. " +
      "Output: full edge with id, createdAt.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project slug." },
        from: { type: "string", description: "Source effort slug." },
        to: { type: "string", description: "Target effort slug." },
        type: { type: "string", description: `Relation type (${VALID_RELATION_TYPES.join(", ")}).` },
        description: { type: "string", description: "Optional human description of the edge." },
        confidence: { type: "number", description: "Optional 0..1 confidence (default 0.8)." },
      },
      required: ["project", "from", "to", "type"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const project = typeof args.project === "string" ? args.project : "";
      const from = typeof args.from === "string" ? args.from : "";
      const to = typeof args.to === "string" ? args.to : "";
      const type = typeof args.type === "string" ? args.type : "";
      if (!project) return { ok: false, content: "error: add_effort_relation requires 'project'" };
      if (!from) return { ok: false, content: "error: add_effort_relation requires 'from'" };
      if (!to) return { ok: false, content: "error: add_effort_relation requires 'to'" };
      if (!type) return { ok: false, content: "error: add_effort_relation requires 'type'" };
      if (!isSafeSlug(project)) return { ok: false, content: `error: invalid project slug '${project}'` };
      if (!isSafeSlug(from)) return { ok: false, content: `error: invalid from slug '${from}'` };
      if (!isSafeSlug(to)) return { ok: false, content: `error: invalid to slug '${to}'` };
      if (!(VALID_RELATION_TYPES as readonly string[]).includes(type)) {
        return {
          ok: false,
          content: `error: invalid relation type '${type}' (must be one of: ${VALID_RELATION_TYPES.join(", ")})`,
        };
      }
      if (from === to) return { ok: false, content: "error: from and to must differ" };
      const workspace = builderWorkspace ?? ctx?.workspace ?? process.cwd();
      try {
        // Verify endpoints exist (the store does not, by design).
        const fromMeta = await readEffortMetadata(workspace, project, from);
        if (!fromMeta) return { ok: false, content: `from effort not found: ${from}` };
        const toMeta = await readEffortMetadata(workspace, project, to);
        if (!toMeta) return { ok: false, content: `to effort not found: ${to}` };
        const description = typeof args.description === "string" ? args.description : undefined;
        const confidence = typeof args.confidence === "number" ? args.confidence : undefined;
        const edge = await addRelation(workspace, project, {
          from,
          to,
          type: type as any,
          ...(description !== undefined ? { description } : {}),
          ...(confidence !== undefined ? { confidence } : {}),
          source: "llm",
        });
        return { ok: true, content: JSON.stringify(edge, null, 2) };
      } catch (err: any) {
        return { ok: false, content: `add_effort_relation error: ${err?.message ?? String(err)}` };
      }
    },
  };
}
