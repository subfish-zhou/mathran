import { describe, it, expect } from "vitest";

import {
  BackgroundSubagentRegistry,
  BackgroundConcurrencyError,
  MAX_BACKGROUND_PER_CONVERSATION,
  globalBackgroundRegistry,
  summarizeTask,
  _resetGlobalBackgroundRegistryForTests,
  type BackgroundCompletedEvent,
} from "../background.js";
import type { SubagentResult } from "../types.js";

function okResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    runId: "sub-deadbeef",
    type: "search",
    status: "ok",
    summary: "found it",
    artifactPath: null,
    stats: {
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 42,
    },
    ...overrides,
  };
}

describe("BackgroundSubagentRegistry", () => {
  it("register returns a running record with a bg-<hex> id + signal", () => {
    const reg = new BackgroundSubagentRegistry();
    const { record, signal } = reg.register({
      type: "search",
      parentConversationId: "c1",
      taskSummary: "find foo",
    });
    expect(record.id).toMatch(/^bg-[0-9a-f]{8}$/);
    expect(record.status).toBe("running");
    expect(record.mode).toBe("background");
    expect(record.parentConversationId).toBe("c1");
    expect(signal.aborted).toBe(false);
    expect(reg.get(record.id)).toBe(record);
  });

  it("enforces the per-conversation cap (4th register throws)", () => {
    const reg = new BackgroundSubagentRegistry();
    for (let i = 0; i < MAX_BACKGROUND_PER_CONVERSATION; i++) {
      reg.register({ type: "search", parentConversationId: "c1", taskSummary: `t${i}` });
    }
    expect(() =>
      reg.register({ type: "search", parentConversationId: "c1", taskSummary: "overflow" }),
    ).toThrow(BackgroundConcurrencyError);
    // A different conversation is unaffected.
    expect(() =>
      reg.register({ type: "search", parentConversationId: "c2", taskSummary: "ok" }),
    ).not.toThrow();
  });

  it("cap counts only running records — completing one frees a slot", () => {
    const reg = new BackgroundSubagentRegistry();
    const ids = [0, 1, 2].map(
      (i) =>
        reg.register({ type: "search", parentConversationId: "c1", taskSummary: `t${i}` })
          .record.id,
    );
    expect(reg.runningCountFor("c1")).toBe(3);
    reg.complete(ids[0], okResult());
    expect(reg.runningCountFor("c1")).toBe(2);
    expect(() =>
      reg.register({ type: "search", parentConversationId: "c1", taskSummary: "now ok" }),
    ).not.toThrow();
  });

  it("complete on an ok result flips status to done + emits event", () => {
    const reg = new BackgroundSubagentRegistry();
    const events: BackgroundCompletedEvent[] = [];
    reg.onCompleted((e) => events.push(e));
    const { record } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t" });
    reg.complete(record.id, okResult({ stats: { startedAt: "", endedAt: "", durationMs: 99 } }));
    expect(reg.get(record.id)!.status).toBe("done");
    expect(reg.get(record.id)!.result?.summary).toBe("found it");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subagentId: record.id, status: "done", durationMs: 99 });
  });

  it("complete on a non-ok result flips status to failed with errorMessage", () => {
    const reg = new BackgroundSubagentRegistry();
    const { record } = reg.register({ type: "research", parentConversationId: "c1", taskSummary: "t" });
    reg.complete(record.id, okResult({ status: "timeout", summary: "", errorMessage: "too slow" }));
    const got = reg.get(record.id)!;
    expect(got.status).toBe("failed");
    expect(got.errorMessage).toBe("too slow");
  });

  it("cancelSubagent aborts the signal + flips to cancelled; complete keeps cancelled", () => {
    const reg = new BackgroundSubagentRegistry();
    const { record, signal } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t" });
    expect(reg.cancelSubagent(record.id)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(reg.get(record.id)!.status).toBe("cancelled");
    // A late-arriving result must NOT resurrect the run to done.
    reg.complete(record.id, okResult());
    expect(reg.get(record.id)!.status).toBe("cancelled");
  });

  it("cancelSubagent returns false for unknown / already-terminal ids", () => {
    const reg = new BackgroundSubagentRegistry();
    expect(reg.cancelSubagent("bg-nope")).toBe(false);
    const { record } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t" });
    reg.complete(record.id, okResult());
    expect(reg.cancelSubagent(record.id)).toBe(false);
  });

  it("getActiveSubagents returns running + recently-completed, drops aged-out", () => {
    const reg = new BackgroundSubagentRegistry({ completedRetentionMs: 0 });
    const a = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "running" });
    const b = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "done" });
    reg.complete(b.record.id, okResult());
    // retention 0 → completed record immediately excluded; running stays.
    const active = reg.getActiveSubagents();
    expect(active.map((r) => r.id)).toEqual([a.record.id]);
  });

  it("onCompleted unsubscribe stops delivery + subscriberCount tracks listeners", () => {
    const reg = new BackgroundSubagentRegistry();
    let n = 0;
    const off = reg.onCompleted(() => n++);
    expect(reg.subscriberCount()).toBe(1);
    const { record } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t" });
    reg.complete(record.id, okResult());
    expect(n).toBe(1);
    off();
    expect(reg.subscriberCount()).toBe(0);
    const { record: r2 } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t2" });
    reg.complete(r2.id, okResult());
    expect(n).toBe(1);
  });

  it("fail() flips a running record to failed and emits", () => {
    const reg = new BackgroundSubagentRegistry();
    const events: BackgroundCompletedEvent[] = [];
    reg.onCompleted((e) => events.push(e));
    const { record } = reg.register({ type: "search", parentConversationId: "c1", taskSummary: "t" });
    reg.fail(record.id, "boom");
    expect(reg.get(record.id)!.status).toBe("failed");
    expect(reg.get(record.id)!.errorMessage).toBe("boom");
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("failed");
  });

  it("globalBackgroundRegistry is a stable singleton, resettable for tests", () => {
    _resetGlobalBackgroundRegistryForTests();
    const a = globalBackgroundRegistry();
    const b = globalBackgroundRegistry();
    expect(a).toBe(b);
    _resetGlobalBackgroundRegistryForTests();
    expect(globalBackgroundRegistry()).not.toBe(a);
  });
});

describe("summarizeTask", () => {
  it("picks a meaningful field from an object input + truncates at 60", () => {
    expect(summarizeTask({ query: "search for the lemma" })).toBe("search for the lemma");
    const long = "x".repeat(100);
    expect(summarizeTask({ objective: long }).length).toBe(60);
    expect(summarizeTask({ goal: long }).endsWith("…")).toBe(true);
  });

  it("collapses whitespace + handles plain strings", () => {
    expect(summarizeTask("a\n  b\tc")).toBe("a b c");
  });
});
