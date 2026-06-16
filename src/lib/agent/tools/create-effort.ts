import { createProjectEffort } from "@/server/agent-gateway/services/efforts";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const createEffortTool: ToolDefinition = {
  name: "create_effort",
  description:
    "Create a new workspace effort (proof attempt, construction, computation, etc.) in the project.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Title of the effort" },
      type: {
        type: "string",
        description: "Type of effort: CONSTRUCTION, PROOF_ATTEMPT, ESTIMATE, COUNTEREXAMPLE, COMPUTATION, REDUCTION, FORMALIZATION, AUXILIARY, REFERENCE",
      },
      projectId: { type: "string", description: "The project ID" },
      description: { type: "string", description: "Description of the effort" },
    },
    required: ["title", "type", "projectId", "description"],
  },
  projectOnly: true,
  requiresConfirmation: true,
  async execute(args, ctx) {
    return withToolSpan(
      "create_effort",
      { userId: ctx.userId },
      async () => {
    const title = String(args.title);
    const type = String(args.type);
    // P0-4: project scope is a server capability, not an LLM-supplied ID.
    const projectId = ctx.projectId;
    const description = String(args.description);

    if (!projectId) {
      return { success: false, data: null, displayText: "No project context available" };
    }

    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const effort = await createProjectEffort(principal, {
        projectId,
        type,
        title,
        description,
      });

      return {
        success: true,
        data: { id: effort?.id, title: effort?.title },
        displayText: `Created effort "${title}" (${type}) as draft`,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        notFound: "Project not found",
        forbidden: "You don't have permission to create efforts in this project.",
      });
    }
  },
    );
  },
};
