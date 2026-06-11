/**
 * Builtin agent template registry.
 *
 * Codex parity: `codex-rs/core/src/agent/builtins/`. A builtin agent is a
 * named role + prompt + tool whitelist that can be spawned as a sub-agent
 * with a single function call (instead of the caller composing system
 * prompt + tool list ad-hoc).
 *
 * Mathub uses these for long-running utility roles (awaiter, etc.) that the
 * main agent invokes via a tool like `spawn_awaiter`.
 *
 * Ported: 2026-06-10 (commit 08/sprint-2 of mathub-ai-codex-upgrade).
 */

import type { AgentRole } from "../agent-roles";

export interface BuiltinAgentTemplate {
  /** Unique name (e.g. "awaiter"). Used as the spawn key. */
  name: string;
  /** Agent role tag. Drives ROLE_BUDGETS lookup. */
  role: AgentRole;
  /** Short human-facing description (shown in tool spec). */
  description: string;
  /** Baked system prompt the spawned agent runs with. */
  developerInstructions: string;
  /** Reasoning effort hint for the LLM router. */
  modelReasoningEffort: "low" | "medium" | "high";
  /**
   * Hard cap on run wall-clock seconds. Used as a safety net so a hung
   * awaiter cannot hold a TPM token slot forever.
   */
  maxRunTimeSeconds: number;
  /**
   * Optional restricted tool whitelist. When omitted, the spawned agent
   * inherits the parent's tool set. When set, only these tools are
   * available to the spawned agent (defense-in-depth: an awaiter should
   * not be writing files).
   */
  allowedTools?: string[];
}

const REGISTRY: Map<string, BuiltinAgentTemplate> = new Map();

export function registerBuiltinAgent(t: BuiltinAgentTemplate): void {
  if (!t.name || !t.name.trim()) {
    throw new Error("builtin agent name must be non-empty");
  }
  REGISTRY.set(t.name, t);
}

export function getBuiltinTemplate(name: string): BuiltinAgentTemplate | null {
  return REGISTRY.get(name) ?? null;
}

export function listBuiltinTemplates(): BuiltinAgentTemplate[] {
  return Array.from(REGISTRY.values());
}

/** Test-only: drop all registrations. Builtins re-register at module-load. */
export function _resetBuiltinAgentsForTest(): void {
  REGISTRY.clear();
}
