import { listPrograms } from "@/server/agent-gateway/services/programs";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const listProgramsTool: ToolDefinition = {
  name: "list_programs",
  description:
    "List all programs, or programs associated with a specific project. Returns each program with its parent hierarchy and project count.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Optional project ID to filter programs by" },
    },
  },
  async execute(args, ctx) {
    return withToolSpan(
      "list_programs",
      { userId: ctx.userId },
      async () => {
    // P0-4: project scope is a server capability, not an LLM-supplied ID.
    const projectId = ctx.projectId;
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const programRows: Awaited<ReturnType<typeof listPrograms>> = [];
      let offset = 0;
      const limit = 100;
      while (true) {
        const page = await listPrograms(principal, { projectId, limit, offset });
        programRows.push(...page);
        if (page.length < limit) break;
        offset += limit;
      }

      if (projectId && programRows.length === 0) {
        return { success: true, data: [], displayText: "No programs found for this project" };
      }

      const lines: string[] = [`# Programs (${programRows.length})`, ""];

      for (const p of programRows) {
        const projCount = p.projectCount ?? 0;
        const parent = p.parentId ? ` (parent: ${p.parentId})` : "";
        lines.push(
          `- **${p.title}** (${p.id}) [${p.status}, ${p.mathStatus}] — ${projCount} project(s)${parent}`,
        );
      }

      const text = lines.join("\n");
      return {
        success: true,
        data: programRows.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          mathStatus: p.mathStatus,
          parentId: p.parentId,
          createdAt: p.createdAt,
          projectCount: p.projectCount ?? 0,
        })),
        displayText: text,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        forbidden: "You don't have access to these programs.",
      });
    }
  },
    );
  },
};
