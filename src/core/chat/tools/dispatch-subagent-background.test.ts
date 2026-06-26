/**
 * Tests for `dispatch_subagent` background mode (#3).
 *
 * A controllable FakeScheduler lets us drive the async lifecycle: a background
 * dispatch must return immediately with `{subagentId, status:"running"}`, then
 * land its result back in the BackgroundSubagentRegistry (firing a
 * `subagent-completed` event) when the underlying dispatch settles.
 */

import { describe, it, expect } from "vitest";

import { createDispatchSubagentTool } from "./dispatch-subagent.js";
import type { SubagentTask, SubagentResult } from "../../subagent/types.js";
import type { SubagentScheduler, DispatchOpts } from "../../subagent/scheduler.js";
import {
  BackgroundSubagentRegistry,
  MAX_BACKGROUND_PER_CONVERSATION,
} from "../../subagent/background.js";

/** Scheduler stand-in whose dispatch resolves only when we tell it to. */
class DeferredScheduler {
  readonly calls: Array<{ task: SubagentTask; opts?: DispatchOpts }> = [];
  private resolvers: Array<(r: SubagentResult) => void> = [];

  async dispatch(task: SubagentTask, opts?: DispatchOpts): Promise<SubagentResult> {
    this.calls.push({ task, opts });
    return new Promise<SubagentResult>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Resolve the Nth (default last) pending dispatch with a result. */
  settle(result: SubagentResult, index = this.resolvers.length - 1): void {
    const r = this.resolvers[index];
    if (r) r(result);
  }

  inFlightCount(): number {
    return 0;
  }
  // 2026-06-26 — L5 audit follow-up: scheduler exposes cap state to tools.
  maxConcurrent(): number {
    return 5;
  }
  isAtCapacity(): boolean {
    return false;
  }
}

function asScheduler(s: DeferredScheduler): SubagentScheduler {
  return s as unknown as SubagentScheduler;
}

function okResult(over: Partial<SubagentResult> = {}): SubagentResult {
  return {
    runId: "sub-deadbeef",
    type: "search",
    status: "ok",
    summary: "done",
    artifactPath: null,
    stats: { startedAt: "", endedAt: "", durationMs: 5 },
    ...over,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("dispatch_subagent — background mode", () => {
  it("returns immediately with {subagentId,status:running} and does not block", async () => {
    const sched = new DeferredScheduler();
    const registry = new BackgroundSubagentRegistry();
    const tool = createDispatchSubagentTool({
      scheduler: asScheduler(sched),
      background: { registry, parentConversationId: "c1" },
    });

    const res = await tool.execute({
      type: "search",
      input: { query: "find the lemma" },
      mode: "background",
    });

    expect(res.ok).toBe(true);
    const payload = JSON.parse(res.content);
    expect(payload.status).toBe("running");
    expect(payload.subagentId).toMatch(/^bg-[0-9a-f]{8}$/);
    // The scheduler is still mid-flight (we never settled it).
    expect(registry.get(payload.subagentId)!.status).toBe("running");
    // The dispatch was handed an abort signal for cooperative cancel.
    expect(sched.calls[0].opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("lands the result + emits subagent-completed when the dispatch settles", async () => {
    const sched = new DeferredScheduler();
    const registry = new BackgroundSubagentRegistry();
    const events: string[] = [];
    registry.onCompleted((e) => events.push(`${e.subagentId}:${e.status}`));
    const tool = createDispatchSubagentTool({
      scheduler: asScheduler(sched),
      background: { registry, parentConversationId: "c1" },
    });

    const res = await tool.execute({ type: "search", input: {}, mode: "background" });
    const id = JSON.parse(res.content).subagentId;

    sched.settle(okResult({ summary: "the answer" }));
    await tick();

    expect(registry.get(id)!.status).toBe("done");
    expect(registry.get(id)!.result?.summary).toBe("the answer");
    expect(events).toEqual([`${id}:done`]);
  });

  it("rejects a 4th concurrent background dispatch for the same conversation", async () => {
    const sched = new DeferredScheduler();
    const registry = new BackgroundSubagentRegistry();
    const tool = createDispatchSubagentTool({
      scheduler: asScheduler(sched),
      background: { registry, parentConversationId: "c1" },
    });

    for (let i = 0; i < MAX_BACKGROUND_PER_CONVERSATION; i++) {
      const ok = await tool.execute({ type: "search", input: {}, mode: "background" });
      expect(ok.ok).toBe(true);
    }
    const overflow = await tool.execute({ type: "search", input: {}, mode: "background" });
    expect(overflow.ok).toBe(false);
    expect(overflow.content).toMatch(/max 3 background subagents/i);
  });

  it("background mode without registry wiring is rejected (sync-only context)", async () => {
    const sched = new DeferredScheduler();
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(sched) });
    const res = await tool.execute({ type: "search", input: {}, mode: "background" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/background mode is not available/i);
  });

  it("default (mode omitted) stays synchronous + blocks on the result", async () => {
    const sched = new DeferredScheduler();
    const registry = new BackgroundSubagentRegistry();
    const tool = createDispatchSubagentTool({
      scheduler: asScheduler(sched),
      background: { registry, parentConversationId: "c1" },
    });

    let settled = false;
    const p = tool.execute({ type: "search", input: {} }).then((r) => {
      settled = true;
      return r;
    });
    await tick();
    // Still blocked — nothing landed in the background registry either.
    expect(settled).toBe(false);
    expect(registry.list()).toHaveLength(0);

    sched.settle(okResult({ summary: "sync done" }));
    const res = await p;
    expect(settled).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("sync done");
  });

  it("invalid mode value is rejected", async () => {
    const sched = new DeferredScheduler();
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(sched) });
    const res = await tool.execute({ type: "search", input: {}, mode: "later" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/invalid mode/i);
  });
});
