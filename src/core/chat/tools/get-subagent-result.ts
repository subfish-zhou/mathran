/**
 * get_subagent_result — companion to `dispatch_subagent`'s background mode
 * (#3). After dispatching with `mode: "background"` the LLM gets back a
 * `subagentId`; this tool lets it poll that id for the run's current status
 * and (once terminal) the bounded summary, without blocking.
 *
 * The model can also simply wait for the host's `subagent-completed` SSE
 * notification — this tool is the pull alternative for agents that want to
 * check in proactively (or that lost the SSE frame because their stream had
 * already closed).
 */

import type { ToolSpec } from "../session.js";
import type { BackgroundSubagentRegistry } from "../../subagent/background.js";

export interface GetSubagentResultToolOptions {
  registry: BackgroundSubagentRegistry;
}

const PARAMETERS = {
  type: "object",
  properties: {
    subagentId: {
      type: "string",
      description:
        "The background subagent id returned by a prior dispatch_subagent " +
        "call with mode:'background' (format 'bg-xxxxxxxx').",
    },
  },
  required: ["subagentId"],
  additionalProperties: false,
} as const;

/**
 * Build a `get_subagent_result` ToolSpec bound to a background registry.
 *
 * Behavior:
 *   - Unknown id → `ok: false` with a "not found" message.
 *   - Still running → `ok: true`, status line only (no summary yet).
 *   - Terminal (done/failed/cancelled) → `ok: true` with status, duration and
 *     the bounded result summary (or error message).
 */
export function createGetSubagentResultTool(
  opts: GetSubagentResultToolOptions,
): ToolSpec {
  return {
    name: "get_subagent_result",
    riskClass: "read",
    readOnly: true,
    description:
      "Poll a background subagent (dispatched via dispatch_subagent mode: " +
      "'background') by its id. Returns its current status and, once it has " +
      "finished, the bounded result summary. Non-blocking — returns the " +
      "live state immediately.",
    parameters: PARAMETERS as unknown as Record<string, unknown>,
    async execute(args: Record<string, unknown>) {
      const id = typeof args.subagentId === "string" ? args.subagentId.trim() : "";
      if (id.length === 0) {
        return {
          ok: false,
          content: 'get_subagent_result: missing required argument "subagentId"',
        };
      }
      const record = opts.registry.get(id);
      if (!record) {
        return {
          ok: false,
          content: `get_subagent_result: no background subagent with id "${id}"`,
        };
      }

      const lines: string[] = [];
      lines.push(`subagentId: ${record.id}`);
      lines.push(`type: ${record.type}`);
      lines.push(`status: ${record.status}`);
      lines.push(`startedAt: ${record.startedAt}`);
      if (typeof record.durationMs === "number") {
        lines.push(`durationMs: ${record.durationMs}`);
      }

      if (record.status === "running") {
        lines.push("");
        lines.push("(still running — check again later or wait for the notification)");
        return { ok: true, content: lines.join("\n") };
      }

      if (record.errorMessage) {
        lines.push(`error: ${record.errorMessage}`);
      }
      const summary = record.result?.summary ?? "";
      if (summary.length > 0) {
        lines.push("");
        lines.push("summary:");
        lines.push(summary);
      }
      if (record.result?.artifactPath) {
        lines.push(`artifactPath: ${record.result.artifactPath}`);
      }
      return { ok: true, content: lines.join("\n") };
    },
  };
}
