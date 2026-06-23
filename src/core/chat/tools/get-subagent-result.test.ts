import { describe, it, expect } from "vitest";

import { createGetSubagentResultTool } from "./get-subagent-result.js";
import { BackgroundSubagentRegistry } from "../../subagent/background.js";
import type { SubagentResult } from "../../subagent/types.js";

function okResult(over: Partial<SubagentResult> = {}): SubagentResult {
  return {
    runId: "sub-deadbeef",
    type: "search",
    status: "ok",
    summary: "the bounded summary",
    artifactPath: ".mathran/subagents/sub-deadbeef/output.txt",
    stats: { startedAt: "", endedAt: "", durationMs: 7 },
    ...over,
  };
}

describe("get_subagent_result", () => {
  it("unknown id → ok:false", async () => {
    const reg = new BackgroundSubagentRegistry();
    const tool = createGetSubagentResultTool({ registry: reg });
    const res = await tool.execute({ subagentId: "bg-nope" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no background subagent/i);
  });

  it("missing arg → ok:false", async () => {
    const reg = new BackgroundSubagentRegistry();
    const tool = createGetSubagentResultTool({ registry: reg });
    const res = await tool.execute({});
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/missing required argument/i);
  });

  it("running run → ok:true, status running, no summary yet", async () => {
    const reg = new BackgroundSubagentRegistry();
    const { record } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t" });
    const tool = createGetSubagentResultTool({ registry: reg });
    const res = await tool.execute({ subagentId: record.id });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/status: running/);
    expect(res.content).toMatch(/still running/i);
  });

  it("completed run → ok:true with summary + artifactPath", async () => {
    const reg = new BackgroundSubagentRegistry();
    const { record } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t" });
    reg.complete(record.id, okResult());
    const tool = createGetSubagentResultTool({ registry: reg });
    const res = await tool.execute({ subagentId: record.id });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/status: done/);
    expect(res.content).toContain("the bounded summary");
    expect(res.content).toMatch(/artifactPath:/);
  });
});
