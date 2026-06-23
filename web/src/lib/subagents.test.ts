import { describe, it, expect } from "vitest";

import {
  applyCompletedFrame,
  elapsedMs,
  formatDuration,
  isRunning,
  shouldPoll,
  type BackgroundSubagentRow,
  type SubagentCompletedFrame,
} from "./subagents.ts";

function row(over: Partial<BackgroundSubagentRow> = {}): BackgroundSubagentRow {
  return {
    id: "bg-00000001",
    type: "search",
    mode: "background",
    status: "running",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    parentConversationId: "c1",
    taskSummary: "find foo",
    ...over,
  };
}

describe("formatDuration", () => {
  it("sub-10s shows one decimal", () => {
    expect(formatDuration(4200)).toBe("4.2s");
  });
  it("10–60s shows whole seconds", () => {
    expect(formatDuration(42_000)).toBe("42s");
  });
  it("past a minute rolls up to m+ss", () => {
    expect(formatDuration(95_000)).toBe("1m35s");
  });
  it("guards against junk input", () => {
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(NaN)).toBe("0s");
  });
});

describe("shouldPoll / isRunning", () => {
  it("polls while any row runs", () => {
    expect(shouldPoll([row({ status: "done" }), row({ status: "running" })])).toBe(true);
  });
  it("stops once everything is terminal", () => {
    expect(shouldPoll([row({ status: "done" }), row({ status: "cancelled" })])).toBe(false);
  });
  it("isRunning reflects status", () => {
    expect(isRunning(row({ status: "running" }))).toBe(true);
    expect(isRunning(row({ status: "failed" }))).toBe(false);
  });
});

describe("elapsedMs", () => {
  it("terminal rows use durationMs", () => {
    expect(elapsedMs(row({ status: "done", durationMs: 1234 }), Date.now())).toBe(1234);
  });
  it("running rows use now - startedAt", () => {
    const start = Date.now() - 3000;
    const r = row({ status: "running", startedAt: new Date(start).toISOString() });
    const got = elapsedMs(r, start + 3000);
    expect(got).toBeGreaterThanOrEqual(2900);
    expect(got).toBeLessThanOrEqual(3100);
  });
});

describe("applyCompletedFrame", () => {
  const frame: SubagentCompletedFrame = {
    type: "subagent-completed",
    subagentId: "bg-00000001",
    status: "done",
    durationMs: 8888,
  };

  it("flips the matching row to its terminal status + duration", () => {
    const next = applyCompletedFrame([row()], frame);
    expect(next[0].status).toBe("done");
    expect(next[0].durationMs).toBe(8888);
  });

  it("records an errorMessage for failed completions", () => {
    const failed: SubagentCompletedFrame = {
      type: "subagent-completed",
      subagentId: "bg-00000001",
      status: "failed",
      durationMs: 10,
      result: { status: "error", summary: "kaboom", artifactPath: null },
    };
    const next = applyCompletedFrame([row()], failed);
    expect(next[0].status).toBe("failed");
    expect(next[0].errorMessage).toBe("kaboom");
  });

  it("returns the original array (no-op) for unknown ids", () => {
    const rows = [row()];
    const next = applyCompletedFrame(rows, { ...frame, subagentId: "bg-99999999" });
    expect(next).toBe(rows);
  });
});
