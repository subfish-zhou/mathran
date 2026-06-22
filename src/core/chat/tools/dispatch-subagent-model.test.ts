/**
 * Tests for the `model` override on `dispatch_subagent` (Copilot Opus 4.8 task
 * §B). Covers: pass-through of `model` onto the dispatched task, format and
 * provider validation (fail-fast before dispatch), and that the recommended
 * per-type model mapping is advertised in the tool description.
 */

import { describe, it, expect } from "vitest";

import {
  createDispatchSubagentTool,
  validateModelOverride,
} from "./dispatch-subagent.js";
import { RECOMMENDED_MODELS } from "../../subagent/registry.js";
import type { SubagentTask, SubagentResult } from "../../subagent/types.js";
import type {
  SubagentScheduler,
  SubagentTaskWithRuntime,
} from "../../subagent/scheduler.js";

class FakeScheduler {
  readonly dispatched: SubagentTask[] = [];
  async dispatch(task: SubagentTask): Promise<SubagentResult> {
    this.dispatched.push(task);
    return {
      runId: "sub-deadbeef",
      type: task.type,
      status: "ok",
      summary: "ok",
      artifactPath: null,
      stats: { startedAt: "t0", endedAt: "t1", durationMs: 1 },
    };
  }
  inFlightCount(): number {
    return 0;
  }
}

function asScheduler(fs: FakeScheduler): SubagentScheduler {
  return fs as unknown as SubagentScheduler;
}

describe("dispatch_subagent model override", () => {
  it("passes a valid model onto the dispatched task", async () => {
    const fake = new FakeScheduler();
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const res = await tool.execute({
      type: "lean_explore",
      input: { goal: "prove foo" },
      model: "copilot/claude-opus-4.8",
    });

    expect(res.ok).toBe(true);
    expect(fake.dispatched).toHaveLength(1);
    expect((fake.dispatched[0] as SubagentTaskWithRuntime).model).toBe(
      "copilot/claude-opus-4.8",
    );
  });

  it("omits model from the task when not supplied", async () => {
    const fake = new FakeScheduler();
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    await tool.execute({ type: "search", input: { query: "needle" } });

    expect("model" in (fake.dispatched[0] as SubagentTaskWithRuntime)).toBe(false);
  });

  it("rejects a malformed model string without dispatching", async () => {
    const fake = new FakeScheduler();
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const res = await tool.execute({
      type: "search",
      input: { query: "needle" },
      model: "claude-opus-4.8",
    });

    expect(res.ok).toBe(false);
    expect(res.content).toContain('invalid model "claude-opus-4.8"');
    expect(fake.dispatched).toHaveLength(0);
  });

  it("rejects a non-string model without dispatching", async () => {
    const fake = new FakeScheduler();
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const res = await tool.execute({
      type: "search",
      input: { query: "needle" },
      model: 123 as unknown as string,
    });

    expect(res.ok).toBe(false);
    expect(res.content).toContain('"model" must be a string');
    expect(fake.dispatched).toHaveLength(0);
  });

  it("rejects an unknown provider when knownProviders is supplied", async () => {
    const fake = new FakeScheduler();
    const tool = createDispatchSubagentTool({
      scheduler: asScheduler(fake),
      knownProviders: ["copilot", "openai"],
    });

    const res = await tool.execute({
      type: "research",
      input: { objective: "x" },
      model: "mystery/foo",
    });

    expect(res.ok).toBe(false);
    expect(res.content).toContain('unknown provider "mystery"');
    expect(fake.dispatched).toHaveLength(0);
  });

  it("accepts a known provider when knownProviders is supplied", async () => {
    const fake = new FakeScheduler();
    const tool = createDispatchSubagentTool({
      scheduler: asScheduler(fake),
      knownProviders: ["copilot"],
    });

    const res = await tool.execute({
      type: "research",
      input: { objective: "x" },
      model: "copilot/gpt-5.5",
    });

    expect(res.ok).toBe(true);
    expect((fake.dispatched[0] as SubagentTaskWithRuntime).model).toBe(
      "copilot/gpt-5.5",
    );
  });

  it("advertises the recommended-model mapping in the tool description", () => {
    const tool = createDispatchSubagentTool({
      scheduler: asScheduler(new FakeScheduler()),
    });
    const params = tool.parameters as {
      properties: { model: { description: string } };
    };
    const desc = params.properties.model.description;
    expect(desc).toContain("lean_explore → copilot/claude-opus-4.8");
    expect(desc).toContain("research → copilot/gpt-5.5");
  });
});

describe("validateModelOverride", () => {
  it("returns ok with no model for undefined/empty", () => {
    expect(validateModelOverride(undefined)).toEqual({ ok: true });
    expect(validateModelOverride("")).toEqual({ ok: true });
    expect(validateModelOverride("   ")).toEqual({ ok: true });
  });

  it("trims a valid provider/model string", () => {
    expect(validateModelOverride("  copilot/claude-opus-4.8 ")).toEqual({
      ok: true,
      model: "copilot/claude-opus-4.8",
    });
  });

  it("rejects strings without a provider prefix", () => {
    const r = validateModelOverride("gpt-5.5");
    expect(r.ok).toBe(false);
  });

  it("rejects a leading or trailing slash", () => {
    expect(validateModelOverride("/foo").ok).toBe(false);
    expect(validateModelOverride("copilot/").ok).toBe(false);
  });

  it("keeps the recommended map in sync with expected types", () => {
    expect(RECOMMENDED_MODELS.lean_explore).toBe("copilot/claude-opus-4.8");
    expect(RECOMMENDED_MODELS.research).toBe("copilot/gpt-5.5");
    expect(RECOMMENDED_MODELS.search).toBeUndefined();
  });
});
