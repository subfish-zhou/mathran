/**
 * get_subagent_status tool — read-only. Look up a single sub-agent by either
 * sessionId (always present) or nickname (commit 4b will populate it on
 * spawn; for now this lookup will return "not found" on nickname-only calls
 * until session-manager is wired up).
 *
 * Pairs with `list_subagents`. Use `list_subagents` to discover, then
 * `get_subagent_status` for full detail on one.
 *
 * Ported: 2026-06-10 (commit 4/6 of mathub-ai-codex-upgrade).
 */

import type { ToolDefinition, ToolResult, ToolContext } from "./types";
import { SessionManager } from "../session-manager";

interface SubagentDetail {
  sessionId: string;
  parentSessionId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  lastActivityAt: string;
  nickname?: string;
  role?: string;
  agentPath?: string[];
  providerKey?: string;
  reservedTokens?: number;
  result?: string;
}

export const getSubagentStatusTool: ToolDefinition = {
  name: "get_subagent_status",
  description:
    "Look up one sub-agent's current state. Resolves by sessionId or nickname " +
    "(when assigned). Returns status, start/last-activity time, nickname, role, " +
    "agentPath, and (for terminal sessions) the full result body. Use this " +
    "after list_subagents to drill into a specific session.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Sub-agent session id (returned by spawn / list_subagents).",
      },
      nickname: {
        type: "string",
        description:
          "Human-readable nickname assigned at spawn. Match is case-sensitive.",
      },
    },
    required: [],
  },
  projectOnly: false,
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const sessionId = (args.sessionId as string | undefined)?.trim();
    const nickname = (args.nickname as string | undefined)?.trim();

    if (!sessionId && !nickname) {
      return {
        success: false,
        data: null,
        displayText: "must provide either sessionId or nickname",
      };
    }

    const manager = SessionManager.getInstance();
    let target = sessionId ? manager.getSession(sessionId) : undefined;

    if (!target && nickname) {
      for (const session of manager.allSessions()) {
        if ((session as { nickname?: string }).nickname === nickname) {
          target = session;
          break;
        }
      }
    }

    if (!target) {
      const key = sessionId ?? `nickname=${nickname}`;
      return {
        success: false,
        data: null,
        displayText: `no sub-agent matching ${key}`,
      };
    }

    if (target.userId && target.userId !== ctx.userId) {
      return {
        success: false,
        data: null,
        displayText: `not authorized to view session ${target.id}`,
      };
    }

    const detail: SubagentDetail = {
      sessionId: target.id,
      parentSessionId: target.parentId,
      status: target.status,
      startedAt: target.startedAt.toISOString(),
      lastActivityAt: target.lastActivityAt.toISOString(),
      nickname: (target as { nickname?: string }).nickname,
      role: (target as { role?: string }).role,
      agentPath: (target as { agentPath?: string[] }).agentPath,
      providerKey: target.providerKey,
      reservedTokens: target.reservedTokens,
    };

    if (target.status !== "running" && target.result !== undefined) {
      detail.result = target.result;
    }

    return {
      success: true,
      data: detail,
      displayText: `sub-agent ${target.id}: ${target.status}`,
    };
  },
};
