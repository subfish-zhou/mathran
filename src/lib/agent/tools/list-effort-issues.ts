import { listEffortIssues } from "@/server/agent-gateway/services/efforts";
import { serviceErrorToToolResult, noPrincipalToolResult } from "./_lib/tool-error";
import { userIdToPrincipal } from "./_lib/user-principal";
import type { ToolDefinition } from "./types";
import { withToolSpan } from "./_lib/tool-span";

export const listEffortIssuesTool: ToolDefinition = {
  name: "list_effort_issues",
  description:
    "List issues for a specific effort. Optionally filter by status (open or closed).",
  parameters: {
    type: "object",
    properties: {
      effortId: { type: "string", description: "The effort ID to list issues for" },
      status: { type: "string", enum: ["open", "closed"], description: "Filter by issue status (optional)" },
    },
    required: ["effortId"],
  },
  projectOnly: true,
  async execute(args, ctx) {
    return withToolSpan(
      "list_effort_issues",
      { userId: ctx.userId },
      async () => {
    const effortId = String(args.effortId);
    const status = args.status ? String(args.status) : undefined;
    const principal = await userIdToPrincipal(ctx.userId);
    if (!principal) return noPrincipalToolResult();

    try {
      const { issues } = await listEffortIssues(principal, { effortId, status });
      const formattedIssues = issues.map((issue) => ({
        id: issue.id,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        authorName: issue.authorName,
        authorId: issue.authorId,
        createdAt: issue.createdAt,
      }));
      const lines: string[] = [`# Effort Issues (${issues.length})`, ""];

      for (const issue of formattedIssues) {
        lines.push(
          `- [${issue.status}] **${issue.title}** (${issue.id}) — ${issue.priority} priority, by ${issue.authorName ?? "unknown"} at ${issue.createdAt?.toISOString() ?? "unknown"}`,
        );
      }

      const text = lines.join("\n");
      return {
        success: true,
        data: formattedIssues,
        displayText: text,
      };
    } catch (e) {
      return serviceErrorToToolResult(e, {
        notFound: "Effort not found",
        forbidden: "You don't have access to this effort.",
      });
    }
  },
    );
  },
};
