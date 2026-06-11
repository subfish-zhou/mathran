import type { ToolDefinition, ToolResult, ToolContext } from "./types";
import { SessionManager } from "../session-manager";

export const checkSubAgentTool: ToolDefinition = {
  name: "check_sub_agent",
  description:
    "Check status of a running sub-agent by session ID. POLLING CONTRACT: after you " +
    "spawn a sub-agent you MUST call check_sub_agent on a later turn to retrieve its " +
    "result — sub-agent results are not pushed to you mid-turn and a session is " +
    "reclaimed after its TTL, so a result you never poll for is lost. Completed/failed " +
    "results are also mirrored into this conversation's history, so they may already " +
    "appear in your context on the next turn; checking explicitly is the reliable path.",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Sub-agent session ID" },
    },
    required: ["sessionId"],
  },
  projectOnly: false,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string;
    const session = SessionManager.getInstance().getSession(sessionId);

    if (!session) {
      return {
        success: false,
        data: null,
        displayText: `No sub-agent session found: ${sessionId}`,
      };
    }

    if (session.userId && session.userId !== ctx.userId) {
      return {
        success: false,
        data: null,
        displayText: `Not authorized to access session: ${sessionId}`,
      };
    }

    const data: Record<string, unknown> = {
      sessionId: session.id,
      status: session.status,
      startedAt: session.startedAt.toISOString(),
    };

    // Surface the result for ALL terminal states (completed AND failed) so the
    // main agent can read failure detail too, not just success.
    if (
      (session.status === "completed" || session.status === "failed") &&
      session.result !== undefined
    ) {
      data.result = session.result;
    }

    return {
      success: true,
      data,
      displayText: `Sub-agent ${sessionId}: ${session.status}`,
    };
  },
};

export const cancelSubAgentTool: ToolDefinition = {
  name: "cancel_sub_agent",
  description:
    "Cancel a running sub-agent. Set cascade=true to also cancel the entire " +
    "descendant sub-tree (every sub-agent this one spawned, recursively).",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Sub-agent session ID" },
      cascade: {
        type: "boolean",
        description:
          "When true, recursively cancel this sub-agent AND all of its descendant sub-agents.",
      },
    },
    required: ["sessionId"],
  },
  projectOnly: false,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const sessionId = args.sessionId as string;
    const cascade = args.cascade === true;
    const manager = SessionManager.getInstance();
    const session = manager.getSession(sessionId);

    if (session?.userId && session.userId !== ctx.userId) {
      return {
        success: false,
        data: null,
        displayText: `Not authorized to cancel session: ${sessionId}`,
      };
    }

    if (cascade) {
      const cancelledIds = manager.cancelSessionCascade(sessionId);
      if (cancelledIds.length === 0) {
        return {
          success: false,
          data: { sessionId, cancelledIds },
          displayText: `Could not cancel session ${sessionId} (not found or not running, and no running descendants)`,
        };
      }
      return {
        success: true,
        data: { sessionId, status: "cancelled", cascade: true, cancelledIds },
        displayText: `Cancelled ${cancelledIds.length} sub-agent(s) (cascade): ${cancelledIds.join(", ")}`,
      };
    }

    const cancelled = manager.cancelSession(sessionId);

    if (!cancelled) {
      return {
        success: false,
        data: null,
        displayText: `Could not cancel session ${sessionId} (not found or not running)`,
      };
    }

    return {
      success: true,
      data: { sessionId, status: "cancelled" },
      displayText: `Sub-agent ${sessionId} cancelled`,
    };
  },
};
