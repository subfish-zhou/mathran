import { getProjectIndex } from "@/server/agent-gateway/services/projects";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

interface WikiNode {
  id: string;
  title: string;
  slug: string | null;
  children: WikiNode[];
}

function buildWikiTree(
  pages: { id: string; title: string; slug: string | null; parentId: string | null }[],
): WikiNode[] {
  const nodeMap = new Map<string, WikiNode>();
  const roots: WikiNode[] = [];

  for (const p of pages) {
    nodeMap.set(p.id, { id: p.id, title: p.title, slug: p.slug, children: [] });
  }

  for (const p of pages) {
    const node = nodeMap.get(p.id)!;
    if (p.parentId && nodeMap.has(p.parentId)) {
      nodeMap.get(p.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function renderTree(nodes: WikiNode[], indent = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const prefix = "  ".repeat(indent);
    lines.push(`${prefix}- ${node.title} (id: ${node.id})`);
    if (node.children.length > 0) {
      lines.push(renderTree(node.children, indent + 1));
    }
  }
  return lines.join("\n");
}

export const getProjectIndexTool: ToolDefinition = {
  name: "get_project_index",
  description:
    "Get an overview of everything in the project: metadata, efforts, wiki pages, and forum threads. Call this first to understand what the project contains.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "The project ID" },
    },
    required: ["projectId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    return withToolSpan(
      "get_project_index",
      { userId: ctx.userId },
      async () => {
    // P0-4: project scope is a server capability, not an LLM-supplied ID.
    const projectId = ctx.projectId;

    if (!projectId) {
      return { success: false, data: null, displayText: "No project context available" };
    }

    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    // P0-2 / P1-4: project index is the single most-repeated read in a goal-
    // run loop (agent re-orients itself almost every round). Tool-name prefix
    // mandatory — see types.ts contract.
    const cacheKey = `get_project_index:${projectId}`;
    if (ctx.runCache instanceof Map && ctx.runCache.has(cacheKey)) {
      const cached = ctx.runCache.get(cacheKey) as {
        text: string;
        displayText: string;
      };
      return {
        success: true,
        data: cached.text,
        displayText: `${cached.displayText} (已从本 run 缓存复用)`,
      };
    }

    try {
      const { project, efforts: effortRows, wikiPages: wikiRows, threads: threadRows } =
        await getProjectIndex(principal, { id: projectId });

      // Project metadata
      const sections: string[] = [];
      sections.push("# Project: " + project.title);
      sections.push(`Status: ${project.status ?? "unknown"} | Math status: ${project.mathStatus ?? "unknown"} | Visibility: ${project.visibility ?? "unknown"}`);
      if (project.description) sections.push(project.description.slice(0, 500));
      if (project.mscCodes && (project.mscCodes as unknown as string[]).length > 0) {
        sections.push(`MSC codes: ${(project.mscCodes as unknown as string[]).join(", ")}`);
      }

      // Efforts grouped by type
      sections.push("\n## Efforts");
      if (effortRows.length === 0) {
        sections.push("No efforts yet.");
      } else {
        const byType = new Map<string, typeof effortRows>();
        for (const e of effortRows) {
          const t = e.type ?? "other";
          if (!byType.has(t)) byType.set(t, []);
          byType.get(t)!.push(e);
        }
        for (const [type, items] of byType) {
          sections.push(`### ${type} (${items.length})`);
          for (const e of items) {
            sections.push(`- ${e.title} [${e.status ?? "unknown"}] (id: ${e.id})`);
          }
        }
      }

      // Wiki pages as tree
      sections.push("\n## Wiki Pages");
      if (wikiRows.length === 0) {
        sections.push("No wiki pages yet.");
      } else {
        const tree = buildWikiTree(wikiRows);
        sections.push(renderTree(tree));
      }

      // Threads grouped by stream
      sections.push("\n## Forum Threads");
      if (threadRows.length === 0) {
        sections.push("No threads yet.");
      } else {
        const byStream = new Map<string, typeof threadRows>();
        for (const t of threadRows) {
          const s = t.stream ?? "general";
          if (!byStream.has(s)) byStream.set(s, []);
          byStream.get(s)!.push(t);
        }
        for (const [stream, items] of byStream) {
          sections.push(`### ${stream} (${items.length} threads)`);
          for (const t of items) {
            sections.push(`- ${t.title} — ${t.postCount} posts (id: ${t.id})`);
          }
        }
      }

      const text = sections.join("\n");
      const displayText = `Project index: ${effortRows.length} efforts, ${wikiRows.length} wiki pages, ${threadRows.length} threads`;
      // Cache successes only. Same intentional trade-off as the other tools:
      // PLAN explicitly skips write-side invalidation, so an agent that writes
      // an effort and re-reads the index in the SAME run will see the prior
      // snapshot. It already knows what it wrote.
      if (ctx.runCache instanceof Map) {
        ctx.runCache.set(cacheKey, { text, displayText });
      }
      return {
        success: true,
        data: text,
        displayText,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        notFound: "Project not found",
        forbidden: "You don't have access to this project.",
      });
    }
  },
    );
  },
};
