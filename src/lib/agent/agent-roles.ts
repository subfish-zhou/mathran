/**
 * Agent role taxonomy. Mirrors codex `agent/role.rs`. A role is a declarative
 * tag attached to a sub-agent at spawn time. It changes the system prompt
 * and tool budget but does NOT change scheduling (that's session-manager's
 * job).
 *
 * Ported: 2026-06-10 (commit 1/6 of mathub-ai-codex-upgrade).
 */

export const AgentRole = {
  Main: "main", // top-level conversation handler (no parent)
  Worker: "worker", // generic worker; default role for deep-research
  Planner: "planner", // builds a plan; usually a read-only role
  Executor: "executor", // executes a planned step
  Reviewer: "reviewer", // audits / verifies completion (Goal completion_audit)
  Summarizer: "summarizer", // distills long history into summary
  Researcher: "researcher", // searches / dedupes results
  Renderer: "renderer", // renders / formats final user-facing output
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

/**
 * Per-role default budget overrides. Real budget = max(role default, caller
 * override). These are *defaults*; the session-manager / executor can still
 * tighten further based on global TPM / quota.
 */
export const ROLE_BUDGETS: Record<
  AgentRole,
  { maxIters: number; maxToolCalls: number }
> = {
  main: { maxIters: 32, maxToolCalls: 100 },
  worker: { maxIters: 16, maxToolCalls: 40 },
  planner: { maxIters: 6, maxToolCalls: 10 },
  executor: { maxIters: 16, maxToolCalls: 40 },
  reviewer: { maxIters: 4, maxToolCalls: 6 },
  summarizer: { maxIters: 2, maxToolCalls: 0 },
  researcher: { maxIters: 12, maxToolCalls: 30 },
  renderer: { maxIters: 3, maxToolCalls: 0 },
};
