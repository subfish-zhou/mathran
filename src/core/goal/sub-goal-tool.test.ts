/**
 * Tests for the `spawn_sub_goal` tool's Layer 3 `template` integration.
 *
 * We stub the recursive `runRound` so no real LLM is needed: it captures the
 * input it receives and immediately reports the sub-goal completed. That lets
 * us assert the expanded template body became the sub-goal objective, the
 * template's `allowedTools` filtered the inherited tool list, and the
 * template's `budgetTokens` landed on the persisted sub-goal record.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ToolSpec } from "../chat/session.js";
import type { LLMProvider } from "../providers/llm.js";

import { buildSpawnSubGoalTool, type SubGoalRunInput, type SubGoalRunResult } from "./sub-goal-tool.js";
import { createGoal, readGoal, type Goal } from "./store.js";

async function mkWs(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "mathran-subgoal-tpl-"));
}

function fakeTool(name: string): ToolSpec {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { ok: true, content: "" };
    },
  };
}

const fakeLLM = {} as unknown as LLMProvider;

async function setup(): Promise<{ ws: string; parent: Goal }> {
  const ws = await mkWs();
  const parent = await createGoal(ws, {
    objective: "parent objective",
    scope: { kind: "global" },
    model: "copilot/gpt-5.5",
    budgetTokensMax: 999999,
  });
  return { ws, parent };
}

describe("spawn_sub_goal — template integration", () => {
  let ws: string;
  let parent: Goal;
  let captured: SubGoalRunInput | null;

  beforeEach(async () => {
    ({ ws, parent } = await setup());
    captured = null;
  });

  const runRound = async (input: SubGoalRunInput): Promise<SubGoalRunResult> => {
    captured = input;
    const goal = (await readGoal(input.workspace, input.goalId))!;
    return {
      goal,
      text: "done",
      completed: true,
      exhausted: false,
      failed: false,
      aborted: false,
      endReason: "mark_done",
    };
  };

  it("expands the awaiter template body into the sub-goal objective", async () => {
    const tool = buildSpawnSubGoalTool({
      workspace: ws,
      parent,
      llm: fakeLLM,
      tools: [fakeTool("bash"), fakeTool("read_file"), fakeTool("search_files"), fakeTool("write_file")],
      runRound,
    });

    const res = await tool.execute({ template: "awaiter", vars: { target: "build-123" } });
    expect(res.ok).toBe(true);
    expect(captured).not.toBeNull();
    // Objective = expanded body.
    expect(captured!.userMessage).toContain("You are an awaiter sub-goal");
    expect(captured!.userMessage).toContain("Target: build-123");
    expect(captured!.userMessage).not.toContain("{target}");
  });

  it("applies the template allowedTools to the sub-goal tool list", async () => {
    const tool = buildSpawnSubGoalTool({
      workspace: ws,
      parent,
      llm: fakeLLM,
      tools: [fakeTool("bash"), fakeTool("read_file"), fakeTool("search_files"), fakeTool("write_file")],
      runRound,
    });

    await tool.execute({ template: "awaiter", vars: { target: "x" } });
    const names = (captured!.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["bash", "read_file", "search_files"]);
    expect(names).not.toContain("write_file");
  });

  it("applies the template budgetTokens to the persisted sub-goal", async () => {
    const tool = buildSpawnSubGoalTool({
      workspace: ws,
      parent,
      llm: fakeLLM,
      tools: [fakeTool("bash")],
      runRound,
    });

    await tool.execute({ template: "awaiter", vars: { target: "x" } });
    const sub = (await readGoal(ws, captured!.goalId))!;
    expect(sub.budget.tokensMax).toBe(30000);
    expect(sub.parentGoalId).toBe(parent.id);
  });

  it("errors on an unknown template name", async () => {
    const tool = buildSpawnSubGoalTool({
      workspace: ws,
      parent,
      llm: fakeLLM,
      tools: [fakeTool("bash")],
      runRound,
    });
    const res = await tool.execute({ template: "no-such-template", vars: {} });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("not found");
    expect(captured).toBeNull();
  });

  it("errors when a required template variable is missing", async () => {
    const tool = buildSpawnSubGoalTool({
      workspace: ws,
      parent,
      llm: fakeLLM,
      tools: [fakeTool("bash")],
      runRound,
    });
    const res = await tool.execute({ template: "awaiter", vars: {} });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/requires variable "target"/);
    expect(captured).toBeNull();
  });

  it("backward compat: omitting template uses the raw objective + inherits parent budget/tools", async () => {
    const tool = buildSpawnSubGoalTool({
      workspace: ws,
      parent,
      llm: fakeLLM,
      tools: [fakeTool("bash"), fakeTool("write_file")],
      runRound,
    });

    const res = await tool.execute({ objective: "do a plain thing" });
    expect(res.ok).toBe(true);
    expect(captured!.userMessage).toBe("do a plain thing");
    // No template → full inherited tool list, parent budget.
    expect((captured!.tools ?? []).map((t) => t.name)).toEqual(["bash", "write_file"]);
    const sub = (await readGoal(ws, captured!.goalId))!;
    expect(sub.budget.tokensMax).toBe(999999);
  });

  it("still rejects an empty objective with no template", async () => {
    const tool = buildSpawnSubGoalTool({
      workspace: ws,
      parent,
      llm: fakeLLM,
      tools: [fakeTool("bash")],
      runRound,
    });
    const res = await tool.execute({ objective: "   " });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("must be a non-empty string");
  });
});
