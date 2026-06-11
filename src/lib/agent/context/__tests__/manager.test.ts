/**
 * ContextManager tests — spec/11-context-fragments.md.
 *
 * Ported: 2026-06-10 (commit 11a/sprint-3 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ContextManager,
  contextManager,
} from "../manager";
import type {
  ContextFragment,
  FragmentRenderInput,
} from "../fragment";
import { FragmentPriority } from "../fragment";

function makeFragment(
  id: string,
  priority: number,
  output: string | (() => string | Promise<string>),
  scope: "persistent" | "turn-time" = "persistent",
): ContextFragment {
  return {
    id,
    priority,
    scope,
    render: async () =>
      typeof output === "function" ? await output() : output,
  };
}

const fakeInput: FragmentRenderInput = {
  context: "personal",
  userId: "u1",
};

describe("ContextManager.register / list", () => {
  let m: ContextManager;
  beforeEach(() => {
    m = new ContextManager();
  });

  it("rejects empty id", () => {
    expect(() =>
      m.register({ id: "", priority: 0, scope: "persistent", render: () => "" }),
    ).toThrow();
    expect(() =>
      m.register({ id: "   ", priority: 0, scope: "persistent", render: () => "" }),
    ).toThrow();
  });

  it("register + has + unregister round-trip", () => {
    m.register(makeFragment("a", 0, "x"));
    expect(m.has("a")).toBe(true);
    expect(m.unregister("a")).toBe(true);
    expect(m.has("a")).toBe(false);
    expect(m.unregister("a")).toBe(false);
  });

  it("re-registering same id replaces", async () => {
    m.register(makeFragment("a", 0, "v1"));
    m.register(makeFragment("a", 0, "v2"));
    const r = await m.renderAll(fakeInput);
    expect(r.text).toBe("v2");
  });

  it("list returns priority-ascending", () => {
    m.register(makeFragment("b", 100, "x"));
    m.register(makeFragment("a", 0, "x"));
    m.register(makeFragment("c", 50, "x"));
    expect(m.list().map((f) => f.id)).toEqual(["a", "c", "b"]);
  });
});

describe("ContextManager.renderAll", () => {
  let m: ContextManager;
  beforeEach(() => {
    m = new ContextManager();
  });

  it("empty registry → empty text + empty audit", async () => {
    const r = await m.renderAll(fakeInput);
    expect(r.text).toBe("");
    expect(r.audit).toEqual([]);
  });

  it("joins fragments with double newline in priority order", async () => {
    m.register(makeFragment("late", 100, "second"));
    m.register(makeFragment("early", 0, "first"));
    const r = await m.renderAll(fakeInput);
    expect(r.text).toBe("first\n\nsecond");
  });

  it("empty render output is skipped (audit marks 'empty')", async () => {
    m.register(makeFragment("a", 0, "present"));
    m.register(makeFragment("b", 50, "   "));
    m.register(makeFragment("c", 100, ""));
    const r = await m.renderAll(fakeInput);
    expect(r.text).toBe("present");
    const skipped = r.audit.filter((a) => a.skipped);
    expect(skipped).toHaveLength(2);
    expect(skipped.every((a) => a.skipReason === "empty")).toBe(true);
  });

  it("fragment that throws is logged + skipped, others still render", async () => {
    m.register(makeFragment("good", 0, "I work"));
    m.register({
      id: "bad",
      priority: 50,
      scope: "persistent",
      render: () => {
        throw new Error("boom");
      },
    });
    m.register(makeFragment("late", 100, "I also work"));
    const r = await m.renderAll(fakeInput);
    expect(r.text).toBe("I work\n\nI also work");
    const badAudit = r.audit.find((a) => a.id === "bad");
    expect(badAudit?.skipped).toBe(true);
    expect(badAudit?.skipReason).toBe("render_error");
  });

  it("token budget cuts off later fragments (chars * 1/4 ≈ tokens)", async () => {
    // 40 chars ≈ 10 tokens. Budget 8 tokens -> 32 chars cap.
    m.register(makeFragment("a", 0, "x".repeat(20)));
    m.register(makeFragment("b", 100, "y".repeat(20))); // would push to 40 + 2 sep = 42
    const r = await m.renderAll(fakeInput, 8);
    expect(r.text).toBe("x".repeat(20));
    const bAudit = r.audit.find((a) => a.id === "b");
    expect(bAudit?.skipped).toBe(true);
    expect(bAudit?.skipReason).toBe("over_budget");
  });

  it("no budget → everything renders (sanity)", async () => {
    m.register(makeFragment("a", 0, "huge fragment content"));
    m.register(makeFragment("b", 100, "another huge fragment content"));
    const r = await m.renderAll(fakeInput);
    expect(r.text.length).toBeGreaterThan(10);
    expect(r.audit.every((a) => !a.skipped)).toBe(true);
  });

  it("priority namespaces sort sanely with mixed fragments", async () => {
    m.register(makeFragment("avoid", FragmentPriority.AvoidHint, "avoid"));
    m.register(makeFragment("persona", FragmentPriority.Persona, "persona"));
    m.register(makeFragment("memory", FragmentPriority.UserMemory, "memory"));
    m.register(makeFragment("skills", FragmentPriority.Skills, "skills"));
    const r = await m.renderAll(fakeInput);
    expect(r.text).toBe("persona\n\nmemory\n\nskills\n\navoid");
  });
});

describe("contextManager singleton", () => {
  beforeEach(() => contextManager._resetForTest());

  it("starts empty after reset", async () => {
    const r = await contextManager.renderAll(fakeInput);
    expect(r.text).toBe("");
  });

  it("registrations persist across renders", async () => {
    contextManager.register(makeFragment("a", 0, "hello"));
    const r1 = await contextManager.renderAll(fakeInput);
    const r2 = await contextManager.renderAll(fakeInput);
    expect(r1.text).toBe("hello");
    expect(r2.text).toBe("hello");
  });
});

describe("ContextManager scope filtering (11b)", () => {
  let m: ContextManager;
  beforeEach(() => {
    m = new ContextManager();
  });

  it("renderPersistent excludes turn-time fragments", async () => {
    m.register(makeFragment("per", 0, "perma", "persistent"));
    m.register(makeFragment("turn", 100, "turnly", "turn-time"));
    const r = await m.renderPersistent(fakeInput);
    expect(r.text).toBe("perma");
  });

  it("renderTurnTime excludes persistent fragments", async () => {
    m.register(makeFragment("per", 0, "perma", "persistent"));
    m.register(makeFragment("turn", 100, "turnly", "turn-time"));
    const r = await m.renderTurnTime(fakeInput);
    expect(r.text).toBe("turnly");
  });

  it("renderAll still includes both", async () => {
    m.register(makeFragment("per", 0, "perma", "persistent"));
    m.register(makeFragment("turn", 100, "turnly", "turn-time"));
    const r = await m.renderAll(fakeInput);
    expect(r.text).toBe("perma\n\nturnly");
  });

  it("listByScope filters", () => {
    m.register(makeFragment("per", 0, "", "persistent"));
    m.register(makeFragment("turn", 100, "", "turn-time"));
    expect(m.listByScope("persistent").map((f) => f.id)).toEqual(["per"]);
    expect(m.listByScope("turn-time").map((f) => f.id)).toEqual(["turn"]);
  });

  // [P1-4 fix] renderById
  it("renderById renders only the named fragments", async () => {
    m.register(makeFragment("a", 10, "AAA", "turn-time"));
    m.register(makeFragment("b", 20, "BBB", "turn-time"));
    m.register(makeFragment("c", 30, "CCC", "persistent"));
    const r = await m.renderById(["a", "c"], fakeInput);
    expect(r.text).toBe("AAA\n\nCCC");
  });

  it("renderById preserves priority order regardless of id list order", async () => {
    m.register(makeFragment("hi", 100, "HI", "turn-time"));
    m.register(makeFragment("lo", 10, "LO", "turn-time"));
    const r = await m.renderById(["hi", "lo"], fakeInput);
    expect(r.text).toBe("LO\n\nHI");
  });

  it("renderById silently skips unknown ids (warns)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.register(makeFragment("a", 10, "AAA", "turn-time"));
    const r = await m.renderById(["a", "does-not-exist"], fakeInput);
    expect(r.text).toBe("AAA");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown fragment id"),
    );
    warn.mockRestore();
  });
});
