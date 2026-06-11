/**
 * spawn_awaiter tool tests — spec/08-awaiter.md.
 *
 * Tests the surface area: shape of the tool spec + the fallback execute
 * path. End-to-end "actually spawn an awaiter and poll" is exercised
 * indirectly via the executor sub-agent dispatcher; that path is too
 * heavy for a unit test.
 *
 * Ported: 2026-06-10 (commit 08/sprint-2 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect } from "vitest";
import { spawnAwaiterTool } from "../spawn-awaiter";
import type { ToolContext } from "../types";

describe("spawnAwaiterTool spec", () => {
  it("is a sub-agent type tool", () => {
    expect(spawnAwaiterTool.type).toBe("sub-agent");
  });

  it("has the expected name", () => {
    expect(spawnAwaiterTool.name).toBe("spawn_awaiter");
  });

  it("requires 'subject' parameter", () => {
    const params = spawnAwaiterTool.parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(params.required).toContain("subject");
    expect(params.properties).toHaveProperty("subject");
    expect(params.properties).toHaveProperty("target_session_id");
    expect(params.properties).toHaveProperty("timeout_seconds");
  });

  it("agentConfig carries the awaiter system prompt", () => {
    const cfg = spawnAwaiterTool.agentConfig;
    expect(cfg).toBeDefined();
    expect(cfg?.systemPrompt).toMatch(/awaiter/i);
    expect(cfg?.systemPrompt).toMatch(/poll/i);
  });

  it("agentConfig restricts tools to the awaiter whitelist", () => {
    const cfg = spawnAwaiterTool.agentConfig;
    expect(cfg?.tools).toBeDefined();
    expect(cfg?.tools).toContain("get_subagent_status");
    // Negative: destructive tools should not be in the whitelist.
    expect(cfg?.tools).not.toContain("write_file");
    expect(cfg?.tools).not.toContain("delete");
  });

  it("timeoutMs caps at the 1h awaiter wall-clock budget", () => {
    expect(spawnAwaiterTool.timeoutMs).toBe(3600 * 1000);
  });
});

describe("spawnAwaiterTool fallback execute path", () => {
  // The executor routes sub-agent tools through runAgentLoop, not through
  // execute(). The fallback execute is a defensive surface: if anything
  // ever calls it directly, it must return a clear error.

  const fakeCtx: ToolContext = {
    userId: "user-test",
    conversationId: "conv-test",
  } as unknown as ToolContext;

  it("returns a failure when 'subject' is missing", async () => {
    const r = await spawnAwaiterTool.execute({}, fakeCtx);
    expect(r.success).toBe(false);
    expect(r.displayText).toMatch(/subject/);
  });

  it("returns a controlled error (NOT silent success) when dispatcher bypassed", async () => {
    const r = await spawnAwaiterTool.execute({ subject: "wait for task X" }, fakeCtx);
    expect(r.success).toBe(false);
    expect(r.displayText).toMatch(/dispatcher/i);
  });
});
