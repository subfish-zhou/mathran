/**
 * Built-in `effort_dep_neighbors` tool (sync-upgrade P3-C).
 *
 * Read-only. Given a project slug + effort slug, returns the
 * effort's immediate neighbors in the dep graph:
 *   - predecessors: efforts that THIS depends on
 *   - successors:   efforts that depend on THIS
 *
 * Use case: agent is about to write a new effort under a project;
 * it queries the existing dep graph for "what already exists in
 * this area" before generating duplicates.
 *
 * Returns metadata-rich rows (title, status, relation type +
 * confidence) so the model can decide which neighbors are worth
 * actually reading.
 */

import * as path from "node:path";
import type { ToolSpec, ToolExecuteContext } from "../session.js";
import {
  listEffortRelations,
  listEffortDependents,
  readEffortMetadata,
} from "../../effort/store.js";

export function createEffortDepNeighborsTool(): ToolSpec {
  return {
    name: "effort_dep_neighbors",
    riskClass: "read",
    readOnly: true,
    description:
      "Inspect an effort's immediate neighbors in the dep graph. " +
      "Returns predecessors (efforts this one depends on) and " +
      "successors (efforts that depend on this one), with titles, " +
      "status, relation type, and confidence. Use BEFORE generating " +
      "a new effort to discover existing work in the area. Read-only.",
    parameters: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project slug (e.g. 'goldbach-conjecture').",
        },
        effort: {
          type: "string",
          description: "Effort slug within the project.",
        },
      },
      required: ["project", "effort"],
    },
    async execute(rawArgs: Record<string, unknown>, ctx: ToolExecuteContext) {
      const project = typeof rawArgs.project === "string" ? rawArgs.project.trim() : "";
      const effort = typeof rawArgs.effort === "string" ? rawArgs.effort.trim() : "";
      if (!project || !effort) {
        return { ok: false, content: "effort_dep_neighbors: project + effort required" };
      }
      const ws = ctx.workspace ?? "";
      const wsAbs = ws ? path.resolve(ws) : "";
      if (!wsAbs) {
        return { ok: false, content: "effort_dep_neighbors: no active workspace" };
      }

      // Verify the effort exists; otherwise return a clear message
      // instead of an empty list (which would be ambiguous).
      const meta = await readEffortMetadata(wsAbs, project, effort).catch(() => null);
      if (!meta) {
        return { ok: false, content: `effort_dep_neighbors: effort '${effort}' not found in project '${project}'` };
      }

      // Predecessors: edges FROM this effort. The relation says "this
      // {depends_on,extends,uses,...} that", so the `to` side is
      // what this effort depends on.
      const out: { predecessors: any[]; successors: any[] } = {
        predecessors: [],
        successors: [],
      };
      try {
        const fromMe = await listEffortRelations(wsAbs, project, effort);
        for (const r of fromMe) {
          const neighbor = await readEffortMetadata(wsAbs, project, r.to).catch(() => null);
          out.predecessors.push({
            slug: r.to,
            title: neighbor?.title ?? "(missing)",
            status: neighbor?.status ?? "?",
            relation: r.type,
            confidence: r.confidence,
            source: r.source,
            description: r.description,
          });
        }
      } catch (err: any) {
        return { ok: false, content: `effort_dep_neighbors: failed to read predecessors: ${err?.message ?? err}` };
      }
      try {
        const toMe = await listEffortDependents(wsAbs, project, effort);
        for (const r of toMe) {
          const neighbor = await readEffortMetadata(wsAbs, project, r.from).catch(() => null);
          out.successors.push({
            slug: r.from,
            title: neighbor?.title ?? "(missing)",
            status: neighbor?.status ?? "?",
            relation: r.type,
            confidence: r.confidence,
            source: r.source,
            description: r.description,
          });
        }
      } catch (err: any) {
        return { ok: false, content: `effort_dep_neighbors: failed to read successors: ${err?.message ?? err}` };
      }

      // Pretty-print for the model.
      const fmt = (rows: any[], dir: "predecessors" | "successors"): string => {
        if (rows.length === 0) return `  (no ${dir})\n`;
        return rows
          .map(
            (r) =>
              `  - [${r.relation}] ${r.slug} — "${r.title}" (status: ${r.status}, conf: ${r.confidence?.toFixed?.(2) ?? "?"})` +
              (r.description ? `\n      ${r.description}` : ""),
          )
          .join("\n") + "\n";
      };
      return {
        ok: true,
        content:
          `# ${project}/${effort} — "${meta.title}" (${meta.status})\n\n` +
          `## Predecessors (this depends on)\n${fmt(out.predecessors, "predecessors")}\n` +
          `## Successors (depend on this)\n${fmt(out.successors, "successors")}`,
      };
    },
  };
}
