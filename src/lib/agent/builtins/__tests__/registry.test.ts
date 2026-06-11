/**
 * Builtin agent registry tests — spec/08-awaiter.md.
 *
 * Ported: 2026-06-10 (commit 08/sprint-2 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerBuiltinAgent,
  getBuiltinTemplate,
  listBuiltinTemplates,
  _resetBuiltinAgentsForTest,
} from "../registry";
import { AgentRole } from "../../agent-roles";

describe("BuiltinAgentRegistry", () => {
  beforeEach(() => _resetBuiltinAgentsForTest());

  it("getBuiltinTemplate returns null for unknown name", () => {
    expect(getBuiltinTemplate("nope")).toBeNull();
  });

  it("registerBuiltinAgent + getBuiltinTemplate round-trips", () => {
    registerBuiltinAgent({
      name: "test-agent",
      role: AgentRole.Executor,
      description: "test desc",
      developerInstructions: "be a good agent",
      modelReasoningEffort: "low",
      maxRunTimeSeconds: 60,
    });
    const t = getBuiltinTemplate("test-agent");
    expect(t).not.toBeNull();
    expect(t?.name).toBe("test-agent");
    expect(t?.role).toBe("executor");
    expect(t?.maxRunTimeSeconds).toBe(60);
  });

  it("empty name rejected", () => {
    expect(() =>
      registerBuiltinAgent({
        name: "",
        role: AgentRole.Worker,
        description: "x",
        developerInstructions: "x",
        modelReasoningEffort: "low",
        maxRunTimeSeconds: 10,
      }),
    ).toThrow();
  });

  it("re-registering same name replaces", () => {
    registerBuiltinAgent({
      name: "dup",
      role: AgentRole.Worker,
      description: "first",
      developerInstructions: "v1",
      modelReasoningEffort: "low",
      maxRunTimeSeconds: 10,
    });
    registerBuiltinAgent({
      name: "dup",
      role: AgentRole.Reviewer,
      description: "second",
      developerInstructions: "v2",
      modelReasoningEffort: "high",
      maxRunTimeSeconds: 20,
    });
    const t = getBuiltinTemplate("dup");
    expect(t?.description).toBe("second");
    expect(t?.role).toBe("reviewer");
  });

  it("listBuiltinTemplates returns all", () => {
    registerBuiltinAgent({
      name: "a",
      role: AgentRole.Worker,
      description: "x",
      developerInstructions: "x",
      modelReasoningEffort: "low",
      maxRunTimeSeconds: 10,
    });
    registerBuiltinAgent({
      name: "b",
      role: AgentRole.Reviewer,
      description: "x",
      developerInstructions: "x",
      modelReasoningEffort: "low",
      maxRunTimeSeconds: 10,
    });
    const all = listBuiltinTemplates();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });
});

describe("awaiter builtin (via boot side-effect)", () => {
  it("awaiter is registered after boot import", async () => {
    _resetBuiltinAgentsForTest();
    // The boot module's import has side effects: re-importing forces a
    // fresh registration.
    await import("../boot");
    // Because Node caches modules, re-import is a no-op after the first
    // call. To guarantee a registration in a fresh registry, we instead
    // import the awaiter module directly which is what boot.ts does.
    await import("../awaiter");
    const t = getBuiltinTemplate("awaiter");
    expect(t).not.toBeNull();
    expect(t?.name).toBe("awaiter");
    expect(t?.role).toBe("executor");
    expect(t?.maxRunTimeSeconds).toBe(3600);
    expect(t?.allowedTools).toContain("get_subagent_status");
    expect(t?.developerInstructions).toContain("awaiter");
  });
});
