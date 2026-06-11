/**
 * list_subagents tool — read-only. Returns the live sub-agent inventory the
 * caller's user owns, scoped to this conversation tree (root_conversation_id
 * inferred from the caller's session).
 *
 * Pairs with `check_sub_agent` (single-session probe). Where `check_sub_agent`
 * tells you about *one* session by id, `list_subagents` answers "which
 * sessions did I spawn that are still relevant?".
 *
 * NOTE (commit 4/6 of mathub-ai-codex-upgrade): nickname / agentPath / role
 * are surfaced if present on the in-memory AgentSession but are currently
 * always undefined — commit 4b will populate them in session-manager. The
 * tool ships now so the model surface is stable.
 *
 * Ported: 2026-06-10.
 */

import type { ToolDefinition, ToolResult, ToolContext } from "./types";
import { SessionManager } from "../session-manager";

const RECENT_TERMINAL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface SubagentSummary {
  sessionId: string;
  parentSessionId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  lastActivityAt: string;
  nickname?: string;
  role?: string;
  agentPath?: string[];
  resultPreview?: string;
}

export const listSubagentsTool: ToolDefinition = {
  name: "list_subagents",
  description:
    "List active and recently-completed (≤1h) sub-agents that the caller owns. " +
    "Returns each session's id, status, parent, start/last-activity time, and — " +
    "when assigned — nickname / role / agentPath. Use this when you spawned " +
    "sub-agents earlier in this conversation and want a refresh on who is doing " +
    "what without polling each by id.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["any", "running", "terminal"],
        description:
          "Filter by status group. 'any' = running + recently terminal (default). 'running' only. 'terminal' = completed/failed/cancelled within the last hour.",
      },
      maxResults: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Cap the number of summaries returned. Default 50.",
      },
    },
    required: [],
  },
  projectOnly: false,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const statusFilter =
      (args.status as "any" | "running" | "terminal" | undefined) ?? "any";
    const maxResults = Math.min(
      Math.max(1, Number(args.maxResults ?? 50)),
      200,
    );

    const manager = SessionManager.getInstance();
    const now = Date.now();
    const out: SubagentSummary[] = [];

    for (const session of manager.allSessions()) {
      // Authorization: only this user's sessions. Unowned (system) sessions
      // are excluded from the listing too — the caller has no business poking
      // at system work.
      if (session.userId !== ctx.userId) continue;

      const terminal = session.status !== "running";
      if (statusFilter === "running" && terminal) continue;
      if (statusFilter === "terminal" && !terminal) continue;

      if (terminal) {
        const ageMs = now - session.lastActivityAt.getTime();
        if (ageMs > RECENT_TERMINAL_WINDOW_MS) continue;
      }

      const summary: SubagentSummary = {
        sessionId: session.id,
        parentSessionId: session.parentId,
        status: session.status,
        startedAt: session.startedAt.toISOString(),
        lastActivityAt: session.lastActivityAt.toISOString(),
        nickname: (session as { nickname?: string }).nickname,
        role: (session as { role?: string }).role,
        agentPath: (session as { agentPath?: string[] }).agentPath,
      };

      // Truncate any terminal result for the listing — the caller can use
      // get_subagent_status for the full body.
      if (terminal && session.result) {
        summary.resultPreview = session.result.slice(0, 200);
      }

      out.push(summary);
      if (out.length >= maxResults) break;
    }

    // Newest first.
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const summaryLine =
      out.length === 0
        ? "no sub-agents found"
        : `${out.length} sub-agent${out.length === 1 ? "" : "s"} (filter=${statusFilter})`;

    return {
      success: true,
      data: { items: out, count: out.length },
      displayText: summaryLine,
    };
  },
};
