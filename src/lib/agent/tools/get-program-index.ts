import { getProgramIndex } from "@/server/agent-gateway/services/programs";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const getProgramIndexTool: ToolDefinition = {
  name: "get_program_index",
  description:
    "Get a full overview of a research program: metadata, associated projects with effort/wiki/thread counts, dependencies, and members. Call this first to understand the program structure.",
  parameters: {
    type: "object",
    properties: {
      programId: { type: "string", description: "The program ID" },
    },
    required: ["programId"],
  },
  async execute(args, ctx) {
    return withToolSpan(
      "get_program_index",
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
        projects: associatedProjects,
        dependencies: deps,
        members,
      } = await getProgramIndex(principal, { idOrSlug: programId });

      // Build output
      const sections: string[] = [];
      sections.push(`# Program: ${program.title}`);
      if (program.subtitle) sections.push(`*${program.subtitle}*`);
      sections.push(`Status: ${program.status} | Math Status: ${program.mathStatus} | Visibility: ${program.visibility}`);
      sections.push(`Slug: ${program.slug} | Created: ${program.createdAt?.toISOString() ?? "unknown"}`);
      if (program.mscCodes && (program.mscCodes as unknown as string[]).length > 0) {
        sections.push(`MSC codes: ${(program.mscCodes as unknown as string[]).join(", ")}`);
      }
      if (program.parentId) {
        sections.push(`Parent program: ${program.parentId}`);
      }
      if (program.description) {
        sections.push("", program.description.slice(0, 800));
      }

      // Projects with stats
      sections.push("", `## Projects (${associatedProjects.length})`);
      if (associatedProjects.length === 0) {
        sections.push("No projects linked yet.");
      } else {
        const sorted = [...associatedProjects].sort((a, b) => a.order - b.order);
        for (const p of sorted) {
          const statsStr = `${p.effortCount} efforts, ${p.wikiPageCount} wiki pages, ${p.threadCount} threads`;
          sections.push(
            `- ${p.title ?? "unknown"} [${p.role}] (id: ${p.id}) — ${statsStr}`,
          );
        }
      }

      // Dependencies
      sections.push("", `## Dependencies (${deps.length})`);
      if (deps.length === 0) {
        sections.push("No inter-project dependencies.");
      } else {
        for (const d of deps) {
          sections.push(
            `- ${d.sourceProjectId} --[${d.relationKind}]--> ${d.targetProjectId}${d.label ? ` (${d.label})` : ""}`,
          );
        }
      }

      // Members
      sections.push("", `## Members (${members.length})`);
      if (members.length === 0) {
        sections.push("No members.");
      } else {
        for (const m of members) {
          const displayName = m.userUsername ? `${m.userName ?? "unknown"} (@${m.userUsername})` : (m.userName ?? "unknown");
          sections.push(`- ${displayName} [${m.role}]`);
        }
      }

      const text = sections.join("\n");
      return {
        success: true,
        data: text,
        displayText: `Program index: ${associatedProjects.length} projects, ${deps.length} dependencies, ${members.length} members`,
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
