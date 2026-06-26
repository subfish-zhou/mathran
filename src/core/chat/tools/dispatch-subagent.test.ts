/**
 * Tests for `createDispatchSubagentTool` (v0.5 Gap #4 + #5).
 *
 * We don't construct a real SubagentScheduler here — that's the scheduler
 * tests' job. Instead a `FakeScheduler` captures each `dispatch()` call and
 * returns a canned `SubagentResult`. That keeps these tests focused on the
 * tool's contract: validation, task construction, result formatting,
 * status/ok mapping.
 */

import { describe, it, expect } from "vitest";

import { createDispatchSubagentTool } from "./dispatch-subagent.js";
import type { SubagentTask, SubagentResult } from "../../subagent/types.js";
import type {
  SubagentScheduler,
  SubagentTaskWithRuntime,
} from "../../subagent/scheduler.js";

/** Minimal scheduler stand-in: records each dispatch + returns a fixture. */
class FakeScheduler {
  readonly dispatched: SubagentTask[] = [];
  private next: SubagentResult | ((task: SubagentTask) => SubagentResult);
  // 2026-06-26 — Lets tests toggle the cap-reached path of the tool.
  capReached = false;
  inflight = 0;
  cap = 5;

  constructor(next: SubagentResult | ((task: SubagentTask) => SubagentResult)) {
    this.next = next;
  }

  setNext(next: SubagentResult | ((task: SubagentTask) => SubagentResult)) {
    this.next = next;
  }

  async dispatch(task: SubagentTask): Promise<SubagentResult> {
    this.dispatched.push(task);
    return typeof this.next === "function" ? this.next(task) : this.next;
  }

  // Methods of SubagentScheduler the tool doesn't touch — stubbed for type
  // compatibility when we cast to SubagentScheduler below.
  inFlightCount(): number {
    return this.inflight;
  }
  maxConcurrent(): number {
    return this.cap;
  }
  isAtCapacity(): boolean {
    return this.capReached || this.inflight >= this.cap;
  }
}

function asScheduler(fs: FakeScheduler): SubagentScheduler {
  return fs as unknown as SubagentScheduler;
}

function okResult(over: Partial<SubagentResult> = {}): SubagentResult {
  return {
    runId: "sub-deadbeef",
    type: "search",
    status: "ok",
    summary: "ran fine",
    artifactPath: null,
    stats: {
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
    },
    ...over,
  };
}

describe("dispatch_subagent tool", () => {
  it("dispatches a compact task and returns ok with formatted summary", async () => {
    const fake = new FakeScheduler(
      okResult({ type: "compact", summary: "compacted 12 messages" }),
    );
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "compact",
      input: { messages: [{ role: "user", content: "hi" }], targetTokens: 1000 },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("status: ok");
    expect(result.content).toContain("compacted 12 messages");
    expect(result.content).toContain("runId: sub-deadbeef");

    expect(fake.dispatched).toHaveLength(1);
    expect(fake.dispatched[0].type).toBe("compact");
    expect(fake.dispatched[0].input).toEqual({
      messages: [{ role: "user", content: "hi" }],
      targetTokens: 1000,
    });
    // No runtime override set ⇒ should not appear on the task.
    expect((fake.dispatched[0] as SubagentTaskWithRuntime).runtime).toBeUndefined();
  });

  it("dispatches research with runtime: subprocess", async () => {
    const fake = new FakeScheduler(
      okResult({
        type: "research",
        summary: "found 3 findings",
        artifactPath: ".mathran/subagents/sub-x/findings.md",
      }),
    );
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "research",
      input: { objective: "explore subagent runtime", maxRounds: 2 },
      runtime: "subprocess",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("status: ok");
    expect(result.content).toContain(".mathran/subagents/sub-x/findings.md");
    expect(fake.dispatched).toHaveLength(1);
    const task = fake.dispatched[0] as SubagentTaskWithRuntime;
    expect(task.type).toBe("research");
    expect(task.runtime).toBe("subprocess");
  });

  it("rejects unknown subagent type without calling scheduler", async () => {
    const fake = new FakeScheduler(okResult());
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "totally_made_up",
      input: {},
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('unknown subagent type "totally_made_up"');
    expect(fake.dispatched).toHaveLength(0);
  });

  it("rejects missing input without calling scheduler", async () => {
    const fake = new FakeScheduler(okResult());
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({ type: "search" } as Record<string, unknown>);

    expect(result.ok).toBe(false);
    expect(result.content).toContain('missing required argument "input"');
    expect(fake.dispatched).toHaveLength(0);
  });

  it("rejects non-object input without calling scheduler", async () => {
    const fake = new FakeScheduler(okResult());
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({ type: "search", input: "not an object" });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('"input" must be a JSON object');
    expect(fake.dispatched).toHaveLength(0);
  });

  it("rejects invalid runtime value", async () => {
    const fake = new FakeScheduler(okResult());
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "search",
      input: { query: "x" },
      runtime: "spaceship",
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('invalid runtime "spaceship"');
    expect(fake.dispatched).toHaveLength(0);
  });

  it("scheduler error status maps to ok:false but content still includes summary", async () => {
    const fake = new FakeScheduler(
      okResult({
        status: "error",
        summary: "partial work before crash",
        errorMessage: "runner exploded",
      }),
    );
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "search",
      input: { query: "needle" },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("error: runner exploded");
    expect(result.content).toContain("status: error");
    expect(result.content).toContain("partial work before crash");
  });

  it("timeout status surfaces as ok:false with status:timeout in content", async () => {
    const fake = new FakeScheduler(
      okResult({
        status: "timeout",
        summary: "",
        errorMessage: "Subagent timed out after 60000ms",
      }),
    );
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "research",
      input: { objective: "..." },
      timeoutMs: 60000,
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("status: timeout");
    expect(result.content).toContain("Subagent timed out after 60000ms");
  });

  it("timeoutMs and hardCapBytes pass through to the task", async () => {
    const fake = new FakeScheduler(okResult());
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    await tool.execute({
      type: "search",
      input: { query: "needle" },
      timeoutMs: 12345,
      hardCapBytes: 999,
    });

    expect(fake.dispatched).toHaveLength(1);
    expect(fake.dispatched[0].timeoutMs).toBe(12345);
    expect(fake.dispatched[0].hardCapBytes).toBe(999);
  });

  it("runtime defaults to inline (not set) when omitted", async () => {
    const fake = new FakeScheduler(okResult());
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    await tool.execute({ type: "search", input: { query: "x" } });

    const task = fake.dispatched[0] as SubagentTaskWithRuntime;
    // Tool doesn't force the default; scheduler.dispatch's own default kicks
    // in. Verify the tool did NOT inject a `runtime` key.
    expect("runtime" in task).toBe(false);
  });

  it("artifactPath is included in formatted output when present", async () => {
    const fake = new FakeScheduler(
      okResult({
        summary: "summarized contents",
        artifactPath: ".mathran/subagents/sub-abc/source.txt",
      }),
    );
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "read_summarize",
      input: { path: "README.md", focus: "what is mathran?" },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain(
      "artifactPath: .mathran/subagents/sub-abc/source.txt",
    );
    expect(result.content).toContain("summarized contents");
  });

  it("truncates extremely long summaries with a hint", async () => {
    const longSummary = "a".repeat(10_000);
    const fake = new FakeScheduler(okResult({ summary: longSummary }));
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "search",
      input: { query: "x" },
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[truncated;");
    // The full 10k characters must NOT be embedded verbatim.
    expect(result.content.length).toBeLessThan(longSummary.length + 500);
  });

  it("scheduler.dispatch throwing maps to ok:false with the message", async () => {
    const fake = new FakeScheduler(okResult());
    fake.dispatch = async () => {
      throw new Error("scheduler is down");
    };
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });

    const result = await tool.execute({
      type: "search",
      input: { query: "x" },
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("scheduler threw: scheduler is down");
  });

  // 2026-06-26 — Option B follow-up: advisory concurrency hint.
  // The cap-reached gentle-refusal path was REPLACED with an advisory
  // line appended to every dispatch result. Tests below pin the new
  // behaviour.
  it("appends no advisory when the queue was effectively idle (inflight <= 1)", async () => {
    const fake = new FakeScheduler(okResult({ summary: "fine" }));
    fake.inflight = 0;
    fake.cap = 20;
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });
    const result = await tool.execute({ type: "search", input: { query: "x" } });
    expect(result.ok).toBe(true);
    // No [concurrency: ...] line — solo dispatch should stay quiet.
    expect(result.content).not.toContain("[concurrency:");
  });

  it("appends a plain advisory when fan-out is moderate (under 40% util)", async () => {
    const fake = new FakeScheduler(okResult({ summary: "fine" }));
    fake.inflight = 2; // 2/20 = 10%
    fake.cap = 20;
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });
    const result = await tool.execute({ type: "search", input: { query: "x" } });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[concurrency: 2/20 other subagents were running");
    // No "heavy" / "close to" guidance at low utilization.
    expect(result.content).not.toContain("heavy");
    expect(result.content).not.toContain("close to");
  });

  it("appends a 'heavy' advisory at 40-74% utilization", async () => {
    const fake = new FakeScheduler(okResult({ summary: "fine" }));
    fake.inflight = 10; // 10/20 = 50%
    fake.cap = 20;
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });
    const result = await tool.execute({ type: "search", input: { query: "x" } });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[concurrency: 10/20");
    expect(result.content).toContain("fan-out is heavy");
    expect(result.content).toContain("batch politely");
  });

  it("appends a 'close to the cap' advisory at >= 75% utilization", async () => {
    const fake = new FakeScheduler(okResult({ summary: "fine" }));
    fake.inflight = 18; // 18/20 = 90%
    fake.cap = 20;
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });
    const result = await tool.execute({ type: "search", input: { query: "x" } });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("[concurrency: 18/20");
    expect(result.content).toContain("close to the safety cap");
    expect(result.content).toContain("sequential dispatch");
  });

  it("still dispatches when over the cap (Option B: cap is a safety backstop, not a hard refuse)", async () => {
    // Even if isAtCapacity() is true (in the synthetic test fake), the
    // tool should NOT bail before await. Real scheduler would queue the
    // dispatch; the fake resolves immediately with our preset result.
    const fake = new FakeScheduler(okResult({ summary: "still ran" }));
    fake.capReached = true;
    fake.inflight = 20;
    fake.cap = 20;
    const tool = createDispatchSubagentTool({ scheduler: asScheduler(fake) });
    const result = await tool.execute({ type: "search", input: { query: "x" } });
    // The dispatch went through — that's the whole point of Option B.
    expect(result.ok).toBe(true);
    expect(result.content).toContain("still ran");
    expect(fake.dispatched.length).toBe(1);
    // And the at-or-over-cap snapshot gets the strongest advisory.
    expect(result.content).toContain("close to the safety cap");
  });
});
