/**
 * Granular approval — tests for the 5-channel kill-switch system added
 * 2026-06-30 (sprint-3 续, commit 93b7d30 follow-up).
 *
 * Covers:
 *   - `shouldPromptFor` precedence: `policy="never"` overrides granular,
 *     `granular[channel]===false` mutes the channel.
 *   - `resolveGranularApprovalConfig` fail-open (non-boolean → true, missing
 *     keys → true) — i.e. back-compat default is "always prompt".
 *   - ApprovalBroker `granularConfig` getter wires the channel through.
 *   - ApprovalBroker `tool_execution=false` short-circuits the policy matrix
 *     in `preCheck` (deny rules still fire; auto-approve still wins; only
 *     the "ask" fallback is collapsed to "allow").
 *   - `policy="never"` overrides a granular `true` — never can't be relaxed.
 */

import { describe, it, expect } from "vitest";
import { shouldPromptFor } from "./policy.js";
import {
  resolveGranularApprovalConfig,
  DEFAULT_GRANULAR_APPROVAL_CONFIG,
  GRANULAR_CHANNELS,
} from "./types.js";
import { ApprovalBroker, type ApprovalCall } from "../chat/approval-broker.js";

describe("shouldPromptFor (granular policy gate)", () => {
  const allOn = DEFAULT_GRANULAR_APPROVAL_CONFIG;

  it("default config prompts every channel (back-compat)", () => {
    for (const ch of GRANULAR_CHANNELS) {
      expect(shouldPromptFor(ch, "on-request", allOn)).toBe(true);
    }
  });

  it("policy='never' silences every channel (granular cannot loosen 'never')", () => {
    const aggressive = { ...allOn, tool_execution: true, ask_user: true };
    for (const ch of GRANULAR_CHANNELS) {
      expect(shouldPromptFor(ch, "never", aggressive)).toBe(false);
    }
  });

  it("granular[channel]=false silences just that channel", () => {
    const mcpMuted = { ...allOn, mcp_elicitation: false };
    expect(shouldPromptFor("mcp_elicitation", "on-request", mcpMuted)).toBe(false);
    // Other channels still prompt.
    expect(shouldPromptFor("tool_execution", "on-request", mcpMuted)).toBe(true);
    expect(shouldPromptFor("rule_proposal", "on-request", mcpMuted)).toBe(true);
    expect(shouldPromptFor("ask_user", "on-request", mcpMuted)).toBe(true);
  });

  it("muting multiple channels independently", () => {
    const cfg = {
      ...allOn,
      tool_execution: false,
      mcp_elicitation: false,
    };
    expect(shouldPromptFor("tool_execution", "on-request", cfg)).toBe(false);
    expect(shouldPromptFor("mcp_elicitation", "on-request", cfg)).toBe(false);
    expect(shouldPromptFor("ask_user", "on-request", cfg)).toBe(true);
    expect(shouldPromptFor("rule_proposal", "on-request", cfg)).toBe(true);
    expect(shouldPromptFor("request_permissions", "on-request", cfg)).toBe(true);
  });
});

describe("resolveGranularApprovalConfig (fail-open coercion)", () => {
  it("undefined input → full default (all true)", () => {
    expect(resolveGranularApprovalConfig(undefined)).toEqual(DEFAULT_GRANULAR_APPROVAL_CONFIG);
  });

  it("empty object → all true (missing keys default to prompt)", () => {
    expect(resolveGranularApprovalConfig({})).toEqual(DEFAULT_GRANULAR_APPROVAL_CONFIG);
  });

  it("non-boolean values coerce to true (fail-open)", () => {
    const out = resolveGranularApprovalConfig({
      tool_execution: "off" as unknown as boolean,
      ask_user: 0 as unknown as boolean,
      rule_proposal: null as unknown as boolean,
    });
    expect(out.tool_execution).toBe(true);
    expect(out.ask_user).toBe(true);
    expect(out.rule_proposal).toBe(true);
  });

  it("explicit false is preserved", () => {
    const out = resolveGranularApprovalConfig({
      mcp_elicitation: false,
      tool_execution: false,
    });
    expect(out.mcp_elicitation).toBe(false);
    expect(out.tool_execution).toBe(false);
    expect(out.ask_user).toBe(true);
  });
});

describe("ApprovalBroker.granularConfig + tool_execution wiring", () => {
  it("default broker exposes all-true granular config", () => {
    const b = new ApprovalBroker({ policy: "on-request" });
    expect(b.granularConfig).toEqual(DEFAULT_GRANULAR_APPROVAL_CONFIG);
  });

  it("broker preserves explicit granular settings", () => {
    const b = new ApprovalBroker({
      policy: "on-request",
      granular: { tool_execution: false, ask_user: false },
    });
    expect(b.granularConfig.tool_execution).toBe(false);
    expect(b.granularConfig.ask_user).toBe(false);
    // Untouched channels default true.
    expect(b.granularConfig.rule_proposal).toBe(true);
    expect(b.granularConfig.request_permissions).toBe(true);
    expect(b.granularConfig.mcp_elicitation).toBe(true);
  });

  it("tool_execution=false → preCheck collapses the policy 'ask' to 'allow'", async () => {
    const b = new ApprovalBroker({
      policy: "on-request",
      granular: { tool_execution: false },
    });
    const call: ApprovalCall = {
      tool: "write_file",
      riskClass: "write",
      args: { path: "/tmp/foo", content: "x" },
    };
    const result = await b.preCheck(call);
    // With tool_execution gated off, an otherwise-prompting call goes straight
    // through: kind === "allow", no `ask` request surfaced.
    expect(result.kind).toBe("allow");
  });

  it("tool_execution=true (default) preserves prompting behavior", async () => {
    const b = new ApprovalBroker({ policy: "on-request" });
    const call: ApprovalCall = {
      tool: "write_file",
      riskClass: "write",
      args: { path: "/tmp/foo", content: "x" },
    };
    const result = await b.preCheck(call);
    // Without granular muting, the on-request policy for a write tool
    // should surface an `ask` (or any non-allow verdict — the key is it
    // did NOT collapse to "allow" silently).
    expect(result.kind).not.toBe("allow");
  });

  it("policy='never' overrides even a fully open granular config", async () => {
    const b = new ApprovalBroker({
      policy: "never",
      granular: { tool_execution: true, ask_user: true, mcp_elicitation: true },
    });
    // shouldPromptFor with policy never always returns false regardless
    // of channel:
    expect(shouldPromptFor("tool_execution", "never", b.granularConfig)).toBe(false);
    expect(shouldPromptFor("ask_user", "never", b.granularConfig)).toBe(false);
  });
});
