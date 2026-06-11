/**
 * spawn_awaiter — bootstrap a builtin awaiter sub-agent.
 *
 * Codex parity: `core/src/agent/builtins/awaiter.toml` + the multi-agent v2
 * spawn tool. We deliver the same semantics through Mathub's existing
 * sub-agent tool plumbing (executor.ts inspects tool.type === "sub-agent"
 * + agentConfig).
 *
 * The model passes:
 *   - subject:           human-readable task description (e.g. "deep-research
 *                        about LRC paper 25") — becomes the first user
 *                        message to the awaiter.
 *   - target_session_id: optional. When provided, the awaiter is told this
 *                        is the session it should poll. Otherwise the
 *                        awaiter is expected to figure it out from the
 *                        subject and its read-only status tools.
 *   - timeout_seconds:   optional override on the awaiter's max wall-clock.
 *                        Capped at maxRunTimeSeconds from the template.
 *
 * Returns the awaiter's final report (a single line in the form
 * "done: …" / "failed: …" / "timeout: …").
 *
 * Ported: 2026-06-10 (commit 08/sprint-2 of mathub-ai-codex-upgrade).
 */

import { getBuiltinTemplate } from "../builtins/registry";
// Side-effect import: ensure the awaiter template is registered before
// spawn_awaiter is ever called.
import "../builtins/boot";
import type { ToolDefinition } from "./types";

const AWAITER_NAME = "awaiter";

export const spawnAwaiterTool: ToolDefinition = (() => {
  const template = getBuiltinTemplate(AWAITER_NAME);
  // Defensive: if the registry is somehow empty at module load (e.g.
  // a test that called _resetBuiltinAgentsForTest()), fall back to a
  // minimal placeholder. Real production loads boot.ts side-effect first.
  const sysPrompt = template?.developerInstructions ??
    "You are an awaiter. Wait for the given task to finish and report.";
  const allowedTools = template?.allowedTools;
  const hardCap = template?.maxRunTimeSeconds ?? 3600;

  return {
    name: "spawn_awaiter",
    description:
      template?.description ??
      "Spawn an awaiter sub-agent that waits for a long-running task to finish and reports its outcome.",
    type: "sub-agent",
    // Wall-clock TTL on the awaiter spawn itself. We cap at 1h regardless of
    // model arg so the parent can't accidentally hold a TPM slot for days.
    timeoutMs: hardCap * 1000,
    parameters: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description:
            "One-line description of what to await (e.g. the sub-agent id or task name).",
          minLength: 1,
          maxLength: 500,
        },
        target_session_id: {
          type: "string",
          description:
            "Optional id of a sub-agent session the awaiter should poll. When omitted, the awaiter infers from `subject`.",
        },
        timeout_seconds: {
          type: "integer",
          description: `Soft wall-clock budget for the awaiter (default ${hardCap}s, capped at ${hardCap}s).`,
          minimum: 1,
          maximum: hardCap,
        },
      },
      required: ["subject"],
    },
    agentConfig: {
      systemPrompt: sysPrompt,
      // Awaiter doesn't need many iterations — it polls. 8 covers a few
      // exponential-backoff cycles. Real wall-clock TTL is enforced by
      // timeoutMs above (cheaper than the iteration cap).
      maxIterations: 8,
      tools: allowedTools,
    },
    // Mathub sub-agent tools are dispatched by the executor (executor.ts
    // recognises tool.type === "sub-agent" and routes through runAgentLoop).
    // The execute() body below is only called if the dispatcher path is
    // bypassed — it surfaces a clear error message instead of silently
    // returning success.
    execute: async (args) => {
      const subject = typeof args.subject === "string" ? args.subject.trim() : "";
      if (!subject) {
        return {
          success: false,
          data: null,
          displayText: "spawn_awaiter: 'subject' is required",
        };
      }
      // If the executor sub-agent dispatch path is broken (or this tool is
      // called from an environment that lacks it), report a controlled
      // failure rather than silently no-op.
      return {
        success: false,
        data: null,
        displayText:
          "spawn_awaiter: sub-agent dispatcher not engaged (tool routed through fallback execute path). Check executor sub-agent handling.",
      };
    },
  };
})();
