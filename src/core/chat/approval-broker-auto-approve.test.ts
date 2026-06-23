/**
 * Permission Profiles (C-1) — broker × autoApprovePatterns precedence tests.
 *
 * Pins down the priority chain spelled out in PLAN.md §1:
 *
 *     denylist > hardReject > autoApprovePattern > policy prompt
 *
 * The hardReject row of that chain lives at the dispatch entry point (BEFORE
 * the broker is asked), so the broker-only tests here cover:
 *   - autoApprovePattern hit → allow (no prompt).
 *   - autoApprovePattern miss → still asks the policy.
 *   - denylist beats autoApprovePattern even on a pattern hit.
 *
 * The dispatch-level hardReject precedence over autoApprovePattern is covered
 * end-to-end in `profile-hard-reject-precedence.test.ts`.
 */

import { describe, it, expect, vi } from "vitest";
import { ApprovalBroker } from "./approval-broker.js";

describe("ApprovalBroker × autoApprovePatterns (C-1 §1)", () => {
  it("matched pattern auto-approves a write_file without invoking the resolver", async () => {
    const resolver = vi.fn();
    const broker = new ApprovalBroker({
      policy: "on-request", // would normally `ask` on write
      autoApprovePatterns: ["src/**/*.test.ts"],
      resolver,
    });
    const result = await broker.preCheck({
      tool: "write_file",
      riskClass: "write",
      args: { path: "src/foo.test.ts", content: "ok" },
    });
    expect(result.kind).toBe("allow");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("non-matched pattern falls through to the policy prompt", async () => {
    const broker = new ApprovalBroker({
      policy: "on-request",
      autoApprovePatterns: ["src/**/*.test.ts"],
    });
    const result = await broker.preCheck({
      tool: "write_file",
      riskClass: "write",
      args: { path: "src/foo.ts", content: "x" }, // NOT a *.test.ts
    });
    expect(result.kind).toBe("ask");
  });

  it("autoApprovePattern does NOT cover bash even when '*' is in the pattern", async () => {
    // bash is path-blind for auto-approve purposes — the denylist + suspicious
    // command check are the only acceptable gates for shell execution.
    const broker = new ApprovalBroker({
      policy: "on-request",
      autoApprovePatterns: ["*"],
    });
    const result = await broker.preCheck({
      tool: "bash",
      riskClass: "exec",
      args: { command: "echo hi" },
    });
    // Falls through to policy → `ask` (no auto-approve bypass).
    expect(result.kind).toBe("ask");
  });

  it("denylist beats autoApprovePattern even on a pattern hit", async () => {
    const broker = new ApprovalBroker({
      policy: "on-request",
      autoApprovePatterns: ["src/**"],
      denylist: ["write_file:src/secret.ts"],
    });
    const result = await broker.preCheck({
      tool: "write_file",
      riskClass: "write",
      args: { path: "src/secret.ts" },
    });
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("denylist");
    }
  });

  it("standing rule allow still short-circuits without consulting autoApprovePatterns", async () => {
    // Standing rules run BEFORE autoApprovePatterns; they're an explicit user
    // decision and should keep their existing semantics.
    const broker = new ApprovalBroker({
      policy: "on-request",
      autoApprovePatterns: [], // empty
      inlineRules: [
        {
          tool: "write_file",
          pathGlob: "src/**",
          action: "allow",
        },
      ],
    });
    const result = await broker.preCheck({
      tool: "write_file",
      riskClass: "write",
      args: { path: "src/foo.ts" },
    });
    expect(result.kind).toBe("allow");
  });

  it("empty / unset autoApprovePatterns is a no-op (default broker behaviour preserved)", async () => {
    const broker = new ApprovalBroker({ policy: "on-request" });
    const result = await broker.preCheck({
      tool: "write_file",
      riskClass: "write",
      args: { path: "src/foo.ts" },
    });
    expect(result.kind).toBe("ask"); // no auto-approve, still gated by policy
  });
});
