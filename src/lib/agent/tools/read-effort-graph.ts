import { workspaceEffortRelations, workspaceEfforts } from "@/server/db/schema";
import { eq, or, inArray } from "drizzle-orm";
import type { ToolDefinition } from "./types";

export const readEffortGraphTool: ToolDefinition = {
  name: "read_effort_graph",
  description:
    "Read the effort dependency graph for a project or a specific effort. Returns nodes (efforts) and edges (relations) with dependency type statistics.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Project ID to scope the graph (optional)" },
      effortId: { type: "string", description: "Specific effort ID to get its direct dependency subgraph (optional)" },
    },
  },
  projectOnly: true,
  async execute(args, ctx) {
    // P0-4: project scope is a server capability, not an LLM-supplied ID.
    const projectId = ctx.projectId;
    const effortId = args.effortId ? String(args.effortId) : undefined;

    if (!projectId && !effortId) {
      return { success: false, data: null, displayText: "Provide projectId or effortId" };
    }

    // P0-2 / P1-4: cache key includes BOTH scopes because the graph differs
    // sharply between "project-wide subgraph" and "single-effort neighbourhood".
    // Empty-string placeholders keep the key unambiguous when one is missing.
    // Tool-name prefix mandatory (see types.ts contract).
    const cacheKey = `read_effort_graph:${projectId ?? ""}:${effortId ?? ""}`;
    if (ctx.runCache instanceof Map && ctx.runCache.has(cacheKey)) {
      const cached = ctx.runCache.get(cacheKey) as {
        data: { nodes: unknown[]; edges: unknown[]; stats: Record<string, number> };
        displayText: string;
      };
      return {
        success: true,
        data: cached.data,
        displayText: `${cached.displayText} (已从本 run 缓存复用)`,
      };
    }

    let edges: { id: string; fromEffortId: string; toEffortId: string; relationType: string }[];

    if (effortId) {
      edges = await ctx.db
        .select({
          id: workspaceEffortRelations.id,
          fromEffortId: workspaceEffortRelations.fromEffortId,
          toEffortId: workspaceEffortRelations.toEffortId,
          relationType: workspaceEffortRelations.relationType,
        })
        .from(workspaceEffortRelations)
        .where(
          or(
            eq(workspaceEffortRelations.fromEffortId, effortId),
            eq(workspaceEffortRelations.toEffortId, effortId),
          ),
        );
    } else {
      // Get all efforts for the project, then find relations among them
      const projectEfforts = await ctx.db
        .select({ id: workspaceEfforts.id })
        .from(workspaceEfforts)
        .where(eq(workspaceEfforts.projectId, projectId!));

      const effortIds = projectEfforts.map((e) => e.id);
      if (effortIds.length === 0) {
        const emptyResult = { nodes: [], edges: [], stats: {} as Record<string, number> };
        // Empty-graph case also gets cached — a project with no efforts won't
        // gain any between rounds of the same run, and another tool call
        // hitting the same scope would otherwise re-issue the same query.
        if (ctx.runCache instanceof Map) {
          ctx.runCache.set(cacheKey, { data: emptyResult, displayText: "No efforts in project" });
        }
        return { success: true, data: emptyResult, displayText: "No efforts in project" };
      }

      edges = await ctx.db
        .select({
          id: workspaceEffortRelations.id,
          fromEffortId: workspaceEffortRelations.fromEffortId,
          toEffortId: workspaceEffortRelations.toEffortId,
          relationType: workspaceEffortRelations.relationType,
        })
        .from(workspaceEffortRelations)
        .where(
          or(
            inArray(workspaceEffortRelations.fromEffortId, effortIds),
            inArray(workspaceEffortRelations.toEffortId, effortIds),
          ),
        );
    }

    // Collect unique node IDs from edges
    const nodeIdSet = new Set<string>();
    for (const e of edges) {
      nodeIdSet.add(e.fromEffortId);
      nodeIdSet.add(e.toEffortId);
    }

    const nodeIds = [...nodeIdSet];
    let nodes: { id: string; title: string; type: string | null; status: string | null }[] = [];

    if (nodeIds.length > 0) {
      nodes = await ctx.db
        .select({
          id: workspaceEfforts.id,
          title: workspaceEfforts.title,
          type: workspaceEfforts.type,
          status: workspaceEfforts.status,
        })
        .from(workspaceEfforts)
        .where(inArray(workspaceEfforts.id, nodeIds));
    }

    // Compute dependency type stats
    const stats: Record<string, number> = {};
    for (const e of edges) {
      stats[e.relationType] = (stats[e.relationType] ?? 0) + 1;
    }

    const lines: string[] = [
      `# Effort Dependency Graph`,
      `Nodes: ${nodes.length} | Edges: ${edges.length}`,
      "",
      "## Nodes",
    ];

    for (const n of nodes) {
      lines.push(`- ${n.title} (${n.id}) [${n.type ?? "unknown"}, ${n.status ?? "unknown"}]`);
    }

    lines.push("", "## Edges");
    for (const e of edges) {
      lines.push(`- ${e.fromEffortId} --[${e.relationType}]--> ${e.toEffortId}`);
    }

    lines.push("", "## Dependency Type Stats");
    for (const [type, count] of Object.entries(stats)) {
      lines.push(`- ${type}: ${count}`);
    }

    const text = lines.join("\n");
    const resultData = { nodes, edges, stats };
    // Cache the successful graph snapshot. write_effort_relation et al. could
    // theoretically invalidate this mid-run, but the PLAN explicitly opts out
    // of write-side invalidation — the agent already knows what it just wrote.
    if (ctx.runCache instanceof Map) {
      ctx.runCache.set(cacheKey, { data: resultData, displayText: text });
    }
    return {
      success: true,
      data: resultData,
      displayText: text,
    };
  },
};
