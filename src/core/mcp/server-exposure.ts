/**
 * server-exposure.ts — the policy gate deciding which mathran builtin tools are
 * exposed when mathran runs *as* an MCP server (`mathran mcp-server`).
 *
 * Security invariants (PLAN 安全):
 *   1. `bash` (and anything on {@link NEVER_EXPOSED_TOOLS}) is NEVER exposed —
 *      a hard denylist that overrides everything, even an explicit
 *      `allowedTools` entry.
 *   2. Mutating tools (riskClass `write` / `exec` / `net`) are only exposed
 *      when `exposeMutating: true`. The default is read-only.
 *   3. When `allowedTools` is non-empty it is an *intersection* filter: a tool
 *      must also be on the allow-list. The denylist still wins.
 *
 * All functions here are pure so they can be unit-tested without spinning up
 * the SDK server.
 */

import type { RiskClass } from "../approval/types.js";
import type { ToolSpec } from "../chat/session.js";
import {
  NEVER_EXPOSED_TOOLS,
  type McpServerExposureConfig,
} from "./schema.js";

/** A tool the gate reasons about (name + coarse risk bucket). */
export interface ExposureCandidate {
  name: string;
  riskClass?: RiskClass;
}

/** Per-tool decision with a human-readable reason (for logs / `--list`). */
export interface ExposureDecision {
  name: string;
  exposed: boolean;
  reason: string;
}

const NEVER = new Set<string>(NEVER_EXPOSED_TOOLS);

/** True for risk buckets that can change disk / run code / hit the network. */
export function isMutatingRisk(riskClass?: RiskClass): boolean {
  return riskClass === "write" || riskClass === "exec" || riskClass === "net";
}

/** True when a tool may NEVER be exposed regardless of config. */
export function isNeverExposed(name: string): boolean {
  return NEVER.has(name);
}

/**
 * Decide exposure for a single candidate. Order of checks mirrors the
 * invariants: denylist → allow-list → mutating gate.
 */
export function decideExposureFor(
  candidate: ExposureCandidate,
  config: McpServerExposureConfig,
): ExposureDecision {
  const { name, riskClass } = candidate;
  if (isNeverExposed(name)) {
    return { name, exposed: false, reason: "denied: on the permanent denylist (never exposed)" };
  }
  const allow = config.allowedTools ?? [];
  if (allow.length > 0 && !allow.includes(name)) {
    return { name, exposed: false, reason: "denied: not in allowedTools" };
  }
  if (isMutatingRisk(riskClass) && !config.exposeMutating) {
    return {
      name,
      exposed: false,
      reason: `denied: mutating tool (riskClass ${riskClass}) and exposeMutating is false`,
    };
  }
  return { name, exposed: true, reason: "exposed" };
}

/** Decide exposure for every candidate. */
export function decideExposure(
  candidates: ExposureCandidate[],
  config: McpServerExposureConfig,
): ExposureDecision[] {
  return candidates.map((c) => decideExposureFor(c, config));
}

/**
 * Filter a list of {@link ToolSpec}s down to the ones the policy allows to be
 * exposed. The returned specs are the *same* objects (no mutation).
 */
export function selectExposedTools(
  specs: ToolSpec[],
  config: McpServerExposureConfig,
): ToolSpec[] {
  return specs.filter(
    (s) => decideExposureFor({ name: s.name, riskClass: s.riskClass }, config).exposed,
  );
}
