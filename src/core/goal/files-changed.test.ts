/**
 * Tests for files-changed extractor — NEW-F8.
 */

import { describe, it, expect } from "vitest";
import { extractFilesChanged } from "./files-changed.js";
import type { Goal, GoalStep } from "./store.js";

function fakeGoal(steps: GoalStep[]): Goal {
  return {
    id: "g-test",
    objective: "test",
    scope: { kind: "global" },
    model: "fake",
    status: "active",
    conversationIds: [],
    createdAt: new Date().toISOString(),
    steps,
    budget: { tokensMax: null, roundsMax: null },
    stats: {
      tokensUsed: 0,
      iterationsRun: 0,
      roundsRun: 0,
      assistantTurnsTotal: 0,
      llmCallsTotal: 0,
      toolCallCount: 0,
      compactionRuns: 0,
      compactionTokensDropped: 0,
      lastCompactionReason: null,
      lastCompactionAt: null,
    },
  } as Goal;
}

function call(name: string, args: object, callId = "c1", at = "2026-06-24T22:00:00.000Z"): GoalStep {
  return { at, kind: "tool-call", payload: { name, argsJson: JSON.stringify(args), toolCallId: callId } } as any;
}

function result(callId: string, ok = true, at = "2026-06-24T22:00:01.000Z"): GoalStep {
  return { at, kind: "tool-result", payload: { toolCallId: callId, ok } } as any;
}

describe("extractFilesChanged", () => {
  it("returns [] for an empty goal", () => {
    expect(extractFilesChanged(fakeGoal([]))).toEqual([]);
  });

  it("ignores read-only / non-file tools", () => {
    const g = fakeGoal([
      call("read_file", { path: "should-not-show" }),
      call("list_efforts", {}),
      call("ask_user", { question: "x" }),
      call("mark_done", { reason: "done" }),
    ]);
    expect(extractFilesChanged(g)).toEqual([]);
  });

  it("captures a single write_file event", () => {
    const g = fakeGoal([
      call("write_file", { path: "src/foo.ts", content: "..." }, "c1", "2026-06-24T22:00:00.000Z"),
      result("c1", true, "2026-06-24T22:00:01.000Z"),
    ]);
    const out = extractFilesChanged(g);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: "src/foo.ts",
      tool: "write_file",
      op: "write",
      ok: true,
      writeCount: 1,
    });
  });

  it("captures edit_file as op=edit", () => {
    const g = fakeGoal([
      call("edit_file", { path: "src/bar.ts", old_string: "a", new_string: "b" }, "c2"),
      result("c2", true),
    ]);
    const out = extractFilesChanged(g);
    expect(out[0]!.op).toBe("edit");
  });

  it("deduplicates by path and accumulates writeCount", () => {
    const g = fakeGoal([
      call("write_file", { path: "a.ts" }, "c1", "2026-06-24T22:00:00.000Z"),
      result("c1", true),
      call("edit_file", { path: "a.ts", old_string: "x", new_string: "y" }, "c2", "2026-06-24T22:01:00.000Z"),
      result("c2", true),
      call("edit_file", { path: "a.ts", old_string: "y", new_string: "z" }, "c3", "2026-06-24T22:02:00.000Z"),
      result("c3", true),
    ]);
    const out = extractFilesChanged(g);
    expect(out).toHaveLength(1);
    expect(out[0]!.writeCount).toBe(3);
    expect(out[0]!.at).toBe("2026-06-24T22:02:00.000Z");
    // Most-recent tool wins on dedupe.
    expect(out[0]!.tool).toBe("edit_file");
    expect(out[0]!.op).toBe("edit");
  });

  it("sorts entries newest-first", () => {
    const g = fakeGoal([
      call("write_file", { path: "old.ts" }, "c1", "2026-06-24T20:00:00.000Z"),
      result("c1", true, "2026-06-24T20:00:00.000Z"),
      call("write_file", { path: "new.ts" }, "c2", "2026-06-24T22:00:00.000Z"),
      result("c2", true, "2026-06-24T22:00:00.000Z"),
    ]);
    const out = extractFilesChanged(g);
    expect(out.map((e) => e.path)).toEqual(["new.ts", "old.ts"]);
  });

  it("propagates ok=false from a failed tool-result", () => {
    const g = fakeGoal([
      call("write_file", { path: "doomed.ts" }, "c1"),
      result("c1", false),
    ]);
    const out = extractFilesChanged(g);
    expect(out[0]!.ok).toBe(false);
  });

  it("synthesises a pseudo-path for create_wiki_page (slug)", () => {
    const g = fakeGoal([
      call("create_wiki_page", { slug: "intro", body: "..." }, "c1"),
      result("c1", true),
    ]);
    const out = extractFilesChanged(g);
    expect(out[0]!.path).toBe("wiki/intro.md");
  });

  it("synthesises a pseudo-path for create_doc_page (slug)", () => {
    const g = fakeGoal([
      call("create_doc_page", { slug: "guide", body: "..." }, "c1"),
      result("c1", true),
    ]);
    const out = extractFilesChanged(g);
    expect(out[0]!.path).toBe("docs/guide.md");
  });

  it("marks delete_wiki_page as op=delete", () => {
    const g = fakeGoal([
      call("delete_wiki_page", { slug: "old" }, "c1"),
      result("c1", true),
    ]);
    const out = extractFilesChanged(g);
    expect(out[0]!.op).toBe("delete");
    expect(out[0]!.path).toBe("wiki/old.md");
  });

  it("tolerates malformed argsJson", () => {
    const g = fakeGoal([
      { at: "2026-06-24T22:00:00.000Z", kind: "tool-call", payload: { name: "write_file", argsJson: "not-json{{", toolCallId: "c1" } } as any,
    ]);
    expect(extractFilesChanged(g)).toEqual([]);
  });

  it("tolerates missing path / unrecognized args shape", () => {
    const g = fakeGoal([
      call("write_file", { some_other_field: "x" }, "c1"),
    ]);
    expect(extractFilesChanged(g)).toEqual([]);
  });

  it("defaults ok=true when no matching tool-result step exists", () => {
    const g = fakeGoal([
      call("write_file", { path: "inflight.ts" }, "c1"),
      // no result step yet — write is still in flight
    ]);
    const out = extractFilesChanged(g);
    expect(out[0]!.ok).toBe(true);
  });
});
