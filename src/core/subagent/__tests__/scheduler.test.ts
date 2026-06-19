import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { SubagentRegistry } from "../registry.js";
import { SubagentScheduler } from "../scheduler.js";
import type { SubagentRunner, SubagentTaskType } from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function okRunner(
  type: SubagentTaskType,
  summary = "done",
): SubagentRunner {
  return {
    type,
    async run() {
      return { status: "ok" as const, summary, artifactPath: null };
    },
  };
}

describe("SubagentScheduler", () => {
  let workspace: string;
  let registry: SubagentRegistry;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-subagent-test-"));
    registry = new SubagentRegistry();
  });

  it("dispatch with ok runner → status ok, runId formatted, stats populated", async () => {
    registry.register(okRunner("search", "hi"));
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "search", input: {} });

    expect(res.status).toBe("ok");
    expect(res.runId).toMatch(/^sub-[0-9a-f]{8}$/);
    expect(res.type).toBe("search");
    expect(res.summary).toBe("hi");
    expect(typeof res.stats.startedAt).toBe("string");
    expect(typeof res.stats.endedAt).toBe("string");
    expect(res.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stats.durationMs is a number ≥ 0", async () => {
    registry.register(okRunner("search"));
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "search", input: {} });
    expect(typeof res.stats.durationMs).toBe("number");
    expect(res.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("dispatch timeout (runner sleeps > timeoutMs) → status timeout", async () => {
    registry.register({
      type: "research",
      async run() {
        await sleep(200);
        return { status: "ok" as const, summary: "late", artifactPath: null };
      },
    });
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "research", input: {}, timeoutMs: 30 });
    expect(res.status).toBe("timeout");
    expect(res.summary).toBe("");
    expect(res.errorMessage).toBeTruthy();
  });

  it("dispatch runner throws → status error, errorMessage populated", async () => {
    registry.register({
      type: "compact",
      async run() {
        throw new Error("boom");
      },
    });
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "compact", input: {} });
    expect(res.status).toBe("error");
    expect(res.errorMessage).toContain("boom");
    expect(res.summary).toBe("");
  });

  it("summary > hardCapBytes → status cap_exceeded, summary truncated", async () => {
    const big = "x".repeat(100);
    registry.register(okRunner("read_summarize", big));
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({
      type: "read_summarize",
      input: {},
      hardCapBytes: 10,
    });
    expect(res.status).toBe("cap_exceeded");
    expect(Buffer.byteLength(res.summary, "utf8")).toBeLessThanOrEqual(10);
    expect(res.summary).toBe("x".repeat(10));
  });

  it("unknown type → error status (does not throw)", async () => {
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "lean_explore", input: {} });
    expect(res.status).toBe("error");
    expect(res.errorMessage).toBeTruthy();
  });

  it("concurrent dispatch with maxConcurrent=2 → only 2 run in parallel, rest queue", async () => {
    let observedMax = 0;
    const sched = new SubagentScheduler({ workspace, registry, maxConcurrent: 2 });
    registry.register({
      type: "search",
      async run() {
        observedMax = Math.max(observedMax, sched.inFlightCount());
        await sleep(50);
        return { status: "ok" as const, summary: "", artifactPath: null };
      },
    });

    const all = Promise.all(
      Array.from({ length: 5 }, () => sched.dispatch({ type: "search", input: {} })),
    );
    // mid-flight: at most 2 in flight
    await sleep(20);
    expect(sched.inFlightCount()).toBeLessThanOrEqual(2);

    const results = await all;
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(observedMax).toBeLessThanOrEqual(2);
    expect(sched.inFlightCount()).toBe(0);
  });

  it("scheduler timeout propagates abort to runner (ctx.signal.aborted becomes true)", async () => {
    let sawAbort = false;
    registry.register({
      type: "research",
      async run(_task, ctx) {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        });
        return { status: "ok" as const, summary: "", artifactPath: null };
      },
    });
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "research", input: {}, timeoutMs: 30 });
    expect(res.status).toBe("timeout");
    expect(sawAbort).toBe(true);
  });

  it("runner can write an artifact via ctx and report its path", async () => {
    registry.register({
      type: "read_summarize",
      async run(_task, ctx) {
        const rel = await ctx.writeArtifact("output.txt", "full output");
        return { status: "ok" as const, summary: "short", artifactPath: rel };
      },
    });
    const sched = new SubagentScheduler({ workspace, registry });
    const res = await sched.dispatch({ type: "read_summarize", input: {} });
    expect(res.status).toBe("ok");
    expect(res.artifactPath).toMatch(
      /^\.mathran\/subagents\/sub-[0-9a-f]{8}\/output\.txt$/,
    );
    const onDisk = await fs.readFile(
      path.join(workspace, res.artifactPath as string),
      "utf8",
    );
    expect(onDisk).toBe("full output");
  });
});
