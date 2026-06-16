import { getProgramIndex } from "@/server/agent-gateway/services/programs";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const readProgramTool: ToolDefinition = {
  name: "read_program",
  description:
    "Read full metadata for a program including associated projects, inter-program dependencies, and members. If the program has a parent, parent info is included.",
  parameters: {
    type: "object",
    properties: {
      programId: { type: "string", description: "The program ID to read" },
    },
    required: ["programId"],
  },
  async execute(args, ctx) {
    return withToolSpan(
      "read_program",
      { userId: ctx.userId },
      async () => {
    // P0-4: program scope is a server capability, not an LLM-supplied ID.
    const programId = ctx.programId;

    if (!programId) {
      return { success: false, data: null, displayText: "No program context available" };
    }

    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const {
        program,
        parent,
        projects: associatedProjects,
        dependencies: deps,
        members,
      } = await getProgramIndex(principal, { idOrSlug: programId });
      const parentTitle = parent?.title ?? null;

      const lines: string[] = [
        `# ${program.title}`,
        `Status: ${program.status} | Math Status: ${program.mathStatus}`,
        `Slug: ${program.slug} | Created: ${program.createdAt?.toISOString() ?? "unknown"}`,
      ];

      if (parentTitle) {
        lines.push(`Parent: ${parentTitle} (${program.parentId})`);
      }

      if (program.description) {
        lines.push("", "## Description", program.description);
      }

      lines.push("", `## Projects (${associatedProjects.length})`);
      for (const p of associatedProjects) {
        lines.push(`- ${p.title ?? "unknown"} (${p.id}) [${p.role}]`);
      }

      lines.push("", `## Dependencies (${deps.length})`);
      for (const d of deps) {
        lines.push(`- ${d.sourceProjectId} --[${d.relationKind}]--> ${d.targetProjectId}${d.label ? ` (${d.label})` : ""}`);
      }

      lines.push("", `## Members (${members.length})`);
      for (const m of members) {
        lines.push(`- ${m.userName ?? "unknown"} [${m.role}]`);
      }

      const text = lines.join("\n");
      return {
        success: true,
        data: text,
        displayText: `Read program: ${program.title}`,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        notFound: "Program not found",
        forbidden: "You don't have access to this program.",
      });
    }
  },
    );
  },
};
