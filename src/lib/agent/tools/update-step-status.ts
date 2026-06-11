// TODO(mathran-v0.1): import { updateStepStatus } from "@/server/agent-gateway/services/effort-structure";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const updateStepStatusTool: ToolDefinition = {
  name: "update_step_status",
  description:
    "Update the verification status of a single proof step within an effort's structure. Status must be one of: 'verified', 'disputed', or 'unverified'.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "ID of the effort (effortId)" },
      stepId: { type: "string", description: "ID of the proof step to update" },
      status: {
        type: "string",
        enum: ["verified", "disputed", "unverified"],
        description: "New status for the step: 'verified', 'disputed', or 'unverified'",
      },
    },
    required: ["id", "stepId", "status"],
  },
  requiresConfirmation: true,
  async execute(args, ctx) {
    return withToolSpan("update_step_status", { userId: ctx.userId }, async () => {
      const id = String(args.id);
      const stepId = String(args.stepId);
      const status = String(args.status) as "verified" | "disputed" | "unverified";

      const principal = await userIdToPrincipal(ctx.userId);
      if (!principal) return noPrincipalToolResult();

      try {
        await updateStepStatus(principal, { id, stepId, status });
        return {
          success: true,
          data: { id, stepId, status },
          displayText: `Set step ${stepId} status to ${status}`,
        };
      } catch (e) {
        return serviceErrorToToolResult(e, {
          notFound: "Effort or step not found",
          forbidden: "You don't have permission to update this effort's structure.",
        });
      }
    });
  },
};
