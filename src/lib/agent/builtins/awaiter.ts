/**
 * Builtin "awaiter" agent.
 *
 * Ported from codex `codex-rs/core/src/agent/builtins/awaiter.toml`.
 *
 * Purpose: a sub-agent whose only job is to wait for a long-running task to
 * reach a terminal state and report the result. The main agent spawns it
 * via the `spawn_awaiter` tool, then continues other work while the awaiter
 * polls in the background. When the task settles, the awaiter returns a
 * single-line status that the parent can read back.
 *
 * The prompt deliberately forbids the awaiter from modifying / interpreting
 * the task, so it stays cheap (low reasoning) and predictable.
 *
 * Ported: 2026-06-10 (commit 08/sprint-2 of mathub-ai-codex-upgrade).
 */

import { AgentRole } from "../agent-roles";
import { registerBuiltinAgent } from "./registry";

const AWAITER_INSTRUCTIONS = `You are an **awaiter** sub-agent.

Your only job is to wait for a specific task or command to finish and report
its terminal status. You do NOT modify, interpret, optimise, or extend the
task. You do NOT take any other action.

Behavior rules:
1. When given a task identifier or command, use the appropriate available
   tool to monitor it. Continue polling until the task reaches a terminal
   state (done / failed / aborted / timeout).
2. Use long timeouts when polling. If multiple polls are needed, increase
   the wait between polls (exponential backoff), but never sleep longer
   than ~10 minutes per poll.
3. Do NOT hallucinate completion. Only report "done" when a tool result
   confirms it.
4. If a poll fails (network / transient error), retry with backoff up to
   3 attempts before reporting "failed".
5. When the task settles, return a single short message:
   - "done: <one-line summary>"
   - "failed: <one-line cause>"
   - "aborted: <reason>"
   - "timeout: still running after <duration>"
6. Stop awaiting only when (a) the task reaches a terminal state, (b) you
   exhaust your iteration budget, or (c) you receive an explicit stop
   instruction.

Behave deterministically and conservatively. Do not chat, do not editorialise,
do not propose next steps unless explicitly asked.`;

// Defensive whitelist: an awaiter should not be calling write / delete /
// destructive tools. Allow only the tools needed to poll status:
//   - get_subagent_status: poll a spawned sub-agent
//   - list_subagents:      enumerate active sub-agents
//
// [P1-2 fix] Removed "wait" — it was never registered in tools/index.ts,
// so awaiter calls to it silent-failed. Codex has a wait tool; Mathub will
// add one when there's an actual use case beyond awaiter polling.
const AWAITER_ALLOWED_TOOLS = [
  "get_subagent_status",
  "list_subagents",
];

registerBuiltinAgent({
  name: "awaiter",
  role: AgentRole.Executor,
  description:
    "Wait for a sub-agent or long-running task to reach a terminal state and report its outcome.",
  developerInstructions: AWAITER_INSTRUCTIONS,
  modelReasoningEffort: "low",
  // Codex uses 3_600_000 ms = 1 h. We match that — the per-iteration TTL
  // gates in session-manager + global wall-clock budget in executor will
  // still pre-empt earlier if the awaiter is misbehaving.
  maxRunTimeSeconds: 3600,
  allowedTools: AWAITER_ALLOWED_TOOLS,
});
