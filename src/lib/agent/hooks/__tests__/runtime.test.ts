/**
 * Hook runtime tests. ≥10 cases per spec/02-hooks.md §4.4.
 *
 * Covers: empty chain, priority ordering, input/output mutation chaining,
 * blocked short-circuit, injectContext accumulation, error isolation,
 * timeout handling, PreCompact skip, SubagentLifecycle optional methods.
 *
 * Ported: 2026-06-10 (commit 2/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerPreToolUse,
  registerPostToolUse,
  registerPreCompact,
  registerPostCompact,
  registerSubagentLifecycle,
  resetForTest,
} from "../registry";
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  runPreCompactHooks,
  runPostCompactHooks,
  runSubagentStartHooks,
  runSubagentStopHooks,
} from "../runtime";
import type {
  PreToolUseHook,
  PostToolUseHook,
  PreCompactHook,
  PostCompactHook,
  SubagentLifecycleHook,
} from "../types";

function makePreTool(
  name: string,
  priority: number,
  impl: PreToolUseHook["run"],
): PreToolUseHook {
  return { name, priority, run: impl };
}

function makePostTool(
  name: string,
  priority: number,
  impl: PostToolUseHook["run"],
): PostToolUseHook {
  return { name, priority, run: impl };
}

function makePreCompact(
  name: string,
  priority: number,
  impl: PreCompactHook["run"],
): PreCompactHook {
  return { name, priority, run: impl };
}

function makePostCompact(
  name: string,
  priority: number,
  impl: PostCompactHook["run"],
): PostCompactHook {
  return { name, priority, run: impl };
}

const baseCtx = { conversationId: "conv-1", turnId: "turn-1" };

describe("hook runtime", () => {
  beforeEach(() => {
    resetForTest();
  });

  afterEach(() => {
    resetForTest();
    vi.useRealTimers();
  });

  // 1
  it("PreToolUse: empty chain → continue, input unchanged, additionalContext=[]", async () => {
    const r = await runPreToolUseHooks({
      ...baseCtx,
      toolName: "search",
      toolCallId: "t1",
      input: { q: "hi" },
    });
    expect(r.kind).toBe("continue");
    if (r.kind !== "continue") return; // narrow for TS
    expect(r.updatedInput).toEqual({ q: "hi" });
    expect(r.additionalContext).toEqual([]);
  });

  // 2
  it("PreToolUse: hooks execute in ascending priority order", async () => {
    const trace: string[] = [];
    registerPreToolUse(
      makePreTool("c", 30, async () => {
        trace.push("c");
        return { kind: "continue" };
      }),
    );
    registerPreToolUse(
      makePreTool("a", 10, async () => {
        trace.push("a");
        return { kind: "continue" };
      }),
    );
    registerPreToolUse(
      makePreTool("b", 20, async () => {
        trace.push("b");
        return { kind: "continue" };
      }),
    );

    await runPreToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t1",
      input: {},
    });
    expect(trace).toEqual(["a", "b", "c"]);
  });

  // 3
  it("PreToolUse: updatedInput chains across multiple hooks", async () => {
    registerPreToolUse(
      makePreTool("addX", 10, async (ev) => {
        const input = (ev.input as Record<string, unknown>) ?? {};
        return { kind: "continue", updatedInput: { ...input, x: 1 } };
      }),
    );
    registerPreToolUse(
      makePreTool("addY", 20, async (ev) => {
        const input = (ev.input as Record<string, unknown>) ?? {};
        return { kind: "continue", updatedInput: { ...input, y: 2 } };
      }),
    );

    const r = await runPreToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t1",
      input: { a: 0 },
    });
    expect(r.kind).toBe("continue");
    if (r.kind !== "continue") return;
    expect(r.updatedInput).toEqual({ a: 0, x: 1, y: 2 });
  });

  // 4
  it("PreToolUse: first blocked short-circuits the chain", async () => {
    const trace: string[] = [];
    registerPreToolUse(
      makePreTool("a", 10, async () => {
        trace.push("a");
        return { kind: "continue" };
      }),
    );
    registerPreToolUse(
      makePreTool("blocker", 20, async () => {
        trace.push("blocker");
        return { kind: "blocked", reason: "policy violation" };
      }),
    );
    registerPreToolUse(
      makePreTool("c", 30, async () => {
        trace.push("c");
        return { kind: "continue" };
      }),
    );

    const r = await runPreToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t1",
      input: {},
    });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.reason).toBe("policy violation");
    expect(r.hookName).toBe("blocker");
    expect(trace).toEqual(["a", "blocker"]); // "c" never ran
  });

  // 4b [P0-3 fix] blocked carries forward additionalContext from earlier hooks
  it("PreToolUse: blocked still surfaces additionalContext from earlier injectContext hooks", async () => {
    registerPreToolUse(
      makePreTool("ctx-pre", 10, async () => ({
        kind: "injectContext",
        additionalContext: "user is in restricted mode",
      })),
    );
    registerPreToolUse(
      makePreTool("another-ctx", 15, async () => ({
        kind: "injectContext",
        additionalContext: "prior step warned about scope",
      })),
    );
    registerPreToolUse(
      makePreTool("blocker", 20, async () => ({
        kind: "blocked",
        reason: "out of allowed scope",
      })),
    );
    const r = await runPreToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t-blocked-with-ctx",
      input: {},
    });
    expect(r.kind).toBe("blocked");
    if (r.kind !== "blocked") return;
    expect(r.hookName).toBe("blocker");
    expect(r.additionalContext).toEqual([
      "user is in restricted mode",
      "prior step warned about scope",
    ]);
  });

  // 5
  it("PreToolUse: injectContext accumulates additionalContext entries", async () => {
    registerPreToolUse(
      makePreTool("ctx-a", 10, async () => ({
        kind: "injectContext",
        additionalContext: "alpha",
      })),
    );
    registerPreToolUse(
      makePreTool("ctx-b", 20, async () => ({
        kind: "injectContext",
        additionalContext: "beta",
      })),
    );

    const r = await runPreToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t1",
      input: { keep: true },
    });
    expect(r.kind).toBe("continue");
    if (r.kind !== "continue") return;
    expect(r.additionalContext).toEqual(["alpha", "beta"]);
    expect(r.updatedInput).toEqual({ keep: true }); // injectContext does NOT mutate input
  });

  // 6
  it("PreToolUse: a throwing hook does not break the chain", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const trace: string[] = [];
    registerPreToolUse(
      makePreTool("ok-1", 10, async () => {
        trace.push("ok-1");
        return { kind: "continue", updatedInput: { stage: "ok-1" } };
      }),
    );
    registerPreToolUse(
      makePreTool("boom", 20, async () => {
        trace.push("boom");
        throw new Error("boom");
      }),
    );
    registerPreToolUse(
      makePreTool("ok-2", 30, async (ev) => {
        trace.push("ok-2");
        return {
          kind: "continue",
          updatedInput: { ...(ev.input as object), final: true },
        };
      }),
    );

    const r = await runPreToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t1",
      input: {},
    });
    expect(r.kind).toBe("continue");
    if (r.kind !== "continue") return;
    expect(trace).toEqual(["ok-1", "boom", "ok-2"]);
    expect(r.updatedInput).toEqual({ stage: "ok-1", final: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // 7
  it("PreToolUse: timeout treated as no-mutation (chain continues)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.MATHUB_HOOK_TIMEOUT_MS = "20";
    try {
      registerPreToolUse(
        makePreTool(
          "slow",
          10,
          () =>
            new Promise<PreToolUseHook extends infer _ ? never : never>(
              () => {
                /* never resolves */
              },
            ) as unknown as ReturnType<PreToolUseHook["run"]>,
        ),
      );
      registerPreToolUse(
        makePreTool("after", 20, async (ev) => {
          const input = ev.input as Record<string, unknown>;
          return { kind: "continue", updatedInput: { ...input, k: 1 } };
        }),
      );

      const r = await runPreToolUseHooks({
        ...baseCtx,
        toolName: "x",
        toolCallId: "t1",
        input: { a: 0 },
      });
      expect(r.kind).toBe("continue");
      if (r.kind !== "continue") return;
      expect(r.updatedInput).toEqual({ a: 0, k: 1 });
      expect(warn).toHaveBeenCalled();
    } finally {
      delete process.env.MATHUB_HOOK_TIMEOUT_MS;
      warn.mockRestore();
    }
  });

  // 8
  it("PostToolUse: updatedOutput chains and additionalContext accumulates", async () => {
    registerPostToolUse(
      makePostTool("strip-secret", 10, async (ev) => {
        const out = ev.output as Record<string, unknown>;
        const clone = { ...out, secret: "[REDACTED]" };
        return { kind: "continue", updatedOutput: clone };
      }),
    );
    registerPostToolUse(
      makePostTool("annotate", 20, async () => ({
        kind: "injectContext",
        additionalContext: "tool result reviewed",
      })),
    );

    const r = await runPostToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t1",
      input: {},
      output: { secret: "abc", k: 1 },
      durationMs: 12,
      success: true,
    });
    expect(r.updatedOutput).toEqual({ secret: "[REDACTED]", k: 1 });
    expect(r.additionalContext).toEqual(["tool result reviewed"]);
  });

  // 9
  it("PreCompact: skip short-circuits with reason + hookName, post-skip hooks not run", async () => {
    const trace: string[] = [];
    registerPreCompact(
      makePreCompact("a", 10, async () => {
        trace.push("a");
        return { kind: "continue" };
      }),
    );
    registerPreCompact(
      makePreCompact("veto", 20, async () => {
        trace.push("veto");
        return { kind: "skip", reason: "lock held" };
      }),
    );
    registerPreCompact(
      makePreCompact("c", 30, async () => {
        trace.push("c");
        return { kind: "continue" };
      }),
    );

    const r = await runPreCompactHooks({
      ...baseCtx,
      reason: "budget_exceeded",
      phase: "pre_turn",
      inputMessages: 50,
      inputTokens: 10000,
    });
    expect(r.proceed).toBe(false);
    expect(r.skipReason).toBe("lock held");
    expect(r.skipHookName).toBe("veto");
    expect(trace).toEqual(["a", "veto"]);
  });

  // 10
  it("PostCompact: observe-only, all hooks invoked, no short-circuit", async () => {
    const seen: string[] = [];
    registerPostCompact(
      makePostCompact("a", 10, async () => {
        seen.push("a");
        return { kind: "ack" };
      }),
    );
    registerPostCompact(
      makePostCompact("b", 20, async () => {
        seen.push("b");
        return { kind: "ack" };
      }),
    );

    await runPostCompactHooks({
      ...baseCtx,
      telemetry: {
        trigger: "auto",
        reason: "budget_exceeded",
        phase: "pre_turn",
        strategy: "local",
        policy: "compaction",
        inputTokens: 10000,
        outputTokens: 2000,
        inputMessages: 50,
        outputMessages: 20,
        durationMs: 500,
        status: "ok",
        retryCount: 0,
      },
    });
    expect(seen).toEqual(["a", "b"]);
  });

  // 11
  it("SubagentLifecycle: only hooks that provide the matching method are invoked", async () => {
    const startSeen: string[] = [];
    const stopSeen: string[] = [];
    const hookStartOnly: SubagentLifecycleHook = {
      name: "start-only",
      priority: 10,
      runStart: async () => {
        startSeen.push("start-only");
        return { kind: "ack" };
      },
    };
    const hookStopOnly: SubagentLifecycleHook = {
      name: "stop-only",
      priority: 10,
      runStop: async () => {
        stopSeen.push("stop-only");
        return { kind: "ack" };
      },
    };
    const hookBoth: SubagentLifecycleHook = {
      name: "both",
      priority: 20,
      runStart: async () => {
        startSeen.push("both");
        return { kind: "ack" };
      },
      runStop: async () => {
        stopSeen.push("both");
        return { kind: "ack" };
      },
    };
    registerSubagentLifecycle(hookStartOnly);
    registerSubagentLifecycle(hookStopOnly);
    registerSubagentLifecycle(hookBoth);

    await runSubagentStartHooks({
      ...baseCtx,
      childSessionId: "child-1",
      depth: 1,
    });
    expect(startSeen).toEqual(["start-only", "both"]);

    await runSubagentStopHooks({
      ...baseCtx,
      childSessionId: "child-1",
      status: "completed",
      durationMs: 1234,
    });
    expect(stopSeen).toEqual(["stop-only", "both"]);
  });

  // 12
  it("registry: name-tiebreak gives deterministic order for equal priority", async () => {
    const trace: string[] = [];
    registerPreToolUse(
      makePreTool("zoo", 10, async () => {
        trace.push("zoo");
        return { kind: "continue" };
      }),
    );
    registerPreToolUse(
      makePreTool("alpha", 10, async () => {
        trace.push("alpha");
        return { kind: "continue" };
      }),
    );
    registerPreToolUse(
      makePreTool("mid", 10, async () => {
        trace.push("mid");
        return { kind: "continue" };
      }),
    );

    await runPreToolUseHooks({
      ...baseCtx,
      toolName: "x",
      toolCallId: "t1",
      input: {},
    });
    expect(trace).toEqual(["alpha", "mid", "zoo"]);
  });
});
