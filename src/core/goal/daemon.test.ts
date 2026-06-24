/**
 * Tests for GoalDaemon / GoalTurnRunner (C1 commit — skeleton).
 *
 * These exercise the loop structure and lifecycle hooks without bringing
 * the full goal stack online. The real runOneIteration is injected via
 * GoalTurnRunner.opts.iterationFn (test seam).
 *
 * Design doc: ~/.openclaw/workspace/_tasks/todo1-design.md §9.1
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

import {
  GoalDaemon,
  GoalTurnRunner,
  type DaemonEvent,
  type DaemonIterationResult,
  type IterationFn,
} from "./daemon.js";

// ───────────────────────── helpers ──────────────────────────

function collectEvents(daemon: GoalDaemon, goalId: string): DaemonEvent[] {
  const events: DaemonEvent[] = [];
  daemon.eventBus.on(`goal:${goalId}`, (ev: DaemonEvent) => events.push(ev));
  return events;
}

function localEvents(): {
  events: DaemonEvent[];
  emit: (ev: DaemonEvent) => void;
} {
  const events: DaemonEvent[] = [];
  return { events, emit: (ev) => events.push(ev) };
}

/** A scripted iteration function that resolves the Nth call with the
 *  supplied result (or `{}` continuation by default). */
function scriptedIterFn(
  results: Partial<DaemonIterationResult>[],
): IterationFn {
  let i = 0;
  return async () => {
    const r = results[i] ?? {};
    i++;
    return {
      completed: false,
      failed: false,
      exhausted: false,
      aborted: false,
      ...r,
    };
  };
}

const baseRunnerOpts = (overrides: Partial<{
  iterationBudget: number;
  iterIdleMs: number;
  initialUserMessage?: string;
  iterationFn: IterationFn;
  onEvent: (ev: DaemonEvent) => void;
  isGoalStillActive?: () => Promise<boolean>;
}>) => ({
  goalId: "g1",
  iterationBudget: 5,
  iterIdleMs: 0, // no delay in tests
  iterationFn: scriptedIterFn([{ completed: true }]),
  onEvent: () => {},
  ...overrides,
});

// ─────────────────────── GoalDaemon ────────────────────────

describe("GoalDaemon", () => {
  it("constructs and exposes empty status", () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    expect(d.status()).toEqual({ running: [], iterations: {} });
    expect(d.isRunning("g1")).toBe(false);
  });

  it("kickGoal without runner factory throws (C1 skeleton)", () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    expect(() => d.kickGoal("g1")).toThrow(/not yet wired/);
  });

  it("kickGoalWithRunner registers and auto-removes after run completes", async () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    const events = collectEvents(d, "g1");
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: scriptedIterFn([{ completed: true }]),
        onEvent: (ev) => d.eventBus.emit("goal:g1", ev),
      }) as any,
    );
    d.kickGoalWithRunner("g1", runner);
    expect(d.isRunning("g1")).toBe(true);

    // Wait for runner.run() to settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(d.isRunning("g1")).toBe(false);
    const types = events.map((e) => e.type);
    expect(types).toContain("iteration-start");
    expect(types).toContain("iteration-end");
    expect(types).toContain("turn-end");
  });

  it("re-registering the same goalId throws", () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    const r1 = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: () => new Promise(() => {}), // never resolves
      }) as any,
    );
    d.kickGoalWithRunner("g1", r1);
    const r2 = new GoalTurnRunner(baseRunnerOpts({}) as any);
    expect(() => d.kickGoalWithRunner("g1", r2)).toThrow(/already registered/);
    // cleanup
    r1.forceStop();
  });

  it("interrupt/abort/enqueueSteer return false for unknown goal", () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    expect(d.interrupt("ghost")).toBe(false);
    expect(d.abort("ghost")).toBe(false);
    expect(d.enqueueSteer("ghost", "hi")).toBe(false);
  });

  it("interrupt fires the runner's interrupt flag", async () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    const events = collectEvents(d, "g1");
    let resolveIter: (r: DaemonIterationResult) => void = () => {};
    const iterationFn: IterationFn = async ({ signal }) => {
      return new Promise<DaemonIterationResult>((resolve) => {
        resolveIter = resolve;
        signal.addEventListener("abort", () =>
          resolve({
            completed: false,
            failed: false,
            exhausted: false,
            aborted: true,
          }),
        );
      });
    };
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn,
        onEvent: (ev) => d.eventBus.emit("goal:g1", ev),
      }) as any,
    );
    d.kickGoalWithRunner("g1", runner);
    await new Promise((r) => setTimeout(r, 5));

    expect(d.interrupt("g1")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.isRunning("g1")).toBe(false);
    const reasons = events
      .filter((e) => e.type === "turn-end")
      .map((e) => (e as any).reason);
    expect(reasons.some((r) => /interrupt/.test(r))).toBe(true);
  });

  it("status() reports running goals + iteration counts", async () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    const blocker = new Promise<DaemonIterationResult>(() => {});
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: () => blocker,
      }) as any,
    );
    d.kickGoalWithRunner("g1", runner);
    await new Promise((r) => setTimeout(r, 5));
    const s = d.status();
    expect(s.running).toEqual(["g1"]);
    expect(s.iterations.g1).toBeGreaterThanOrEqual(1);
    runner.forceStop();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("stop() force-resolves hung runners within timeout", async () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    // iterationFn that DOES respect AbortSignal, so forceStop can complete it.
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: ({ signal }) =>
          new Promise<DaemonIterationResult>((resolve) => {
            signal.addEventListener("abort", () =>
              resolve({
                completed: false,
                failed: false,
                exhausted: false,
                aborted: true,
              }),
            );
          }),
      }) as any,
    );
    d.kickGoalWithRunner("g1", runner);
    await new Promise((r) => setTimeout(r, 5));
    await d.stop(100);
    expect(d.isRunning("g1")).toBe(false);
  });

  it("stop() returns even if a runner ignores AbortSignal (best-effort)", async () => {
    const d = new GoalDaemon({ workspace: "/tmp/x" });
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: () => new Promise(() => {}), // truly hung
      }) as any,
    );
    d.kickGoalWithRunner("g1", runner);
    await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    await d.stop(80);
    // stop() must return within deadline + cleanup grace (~300ms total)
    expect(Date.now() - t0).toBeLessThan(400);
    // Daemon refuses further kicks (silent no-op when stopped).
    expect(() => d.kickGoal("g2")).not.toThrow();
  });

  it("MATHRAN_DISABLE_GOAL_DAEMON makes start() a no-op", async () => {
    const prev = process.env.MATHRAN_DISABLE_GOAL_DAEMON;
    process.env.MATHRAN_DISABLE_GOAL_DAEMON = "1";
    try {
      const d = new GoalDaemon({ workspace: "/tmp/x" });
      await d.start();
      expect(d.status().running.length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.MATHRAN_DISABLE_GOAL_DAEMON;
      else process.env.MATHRAN_DISABLE_GOAL_DAEMON = prev;
    }
  });
});

// ───────────────────── GoalTurnRunner ─────────────────────

describe("GoalTurnRunner", () => {
  it("runs until iterationFn returns completed:true", async () => {
    const { events, emit } = localEvents();
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: scriptedIterFn([{}, {}, { completed: true }]),
        onEvent: emit,
      }) as any,
    );
    await runner.run();
    expect(runner.iterationCount()).toBe(3);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "iteration-start").length).toBe(3);
    expect(
      events.find((e) => e.type === "turn-end" && (e as any).reason === "completed"),
    ).toBeTruthy();
  });

  it("respects iterationBudget", async () => {
    const { events, emit } = localEvents();
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationBudget: 2,
        iterationFn: scriptedIterFn([{}, {}, {}, {}]),
        onEvent: emit,
      }) as any,
    );
    await runner.run();
    expect(runner.iterationCount()).toBe(2);
    expect(
      events.find(
        (e) =>
          e.type === "turn-end" && /budget-exhausted/.test(String((e as any).reason)),
      ),
    ).toBeTruthy();
  });

  it("naturalTurnEnd halts loop and waits for notify/enqueue", async () => {
    const { events, emit } = localEvents();
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: scriptedIterFn([{ naturalTurnEnd: true }, { completed: true }]),
        onEvent: emit,
      }) as any,
    );
    const runP = runner.run();
    // give it time to land in the wait-state
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.iterationCount()).toBe(1);
    // wake it with a fresh user message
    runner.enqueueUserMessage("next thing please");
    await runP;
    expect(runner.iterationCount()).toBe(2);
  });

  it("enqueueSteer is consumed by the very next iteration", async () => {
    const { events, emit } = localEvents();
    const seen: (string | undefined)[] = [];
    const iterationFn: IterationFn = async ({ steerText }) => {
      seen.push(steerText);
      return seen.length >= 2
        ? { completed: true, failed: false, exhausted: false, aborted: false }
        : { completed: false, failed: false, exhausted: false, aborted: false };
    };
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn,
        onEvent: emit,
      }) as any,
    );
    runner.enqueueSteer("steer A");
    runner.enqueueSteer("steer B");
    await runner.run();
    expect(seen[0]).toBe("steer A\nsteer B");
    expect(seen[1]).toBeUndefined();
  });

  it("isGoalStillActive=false exits without running iteration", async () => {
    const { events, emit } = localEvents();
    let calls = 0;
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        isGoalStillActive: async () => false,
        iterationFn: () => {
          calls++;
          return Promise.resolve({
            completed: false,
            failed: false,
            exhausted: false,
            aborted: false,
          });
        },
        onEvent: emit,
      }) as any,
    );
    await runner.run();
    expect(calls).toBe(0);
    expect(runner.iterationCount()).toBe(0);
    const turnEnd = events.find((e) => e.type === "turn-end");
    expect((turnEnd as any)?.reason).toBe("status-flipped");
  });

  it("iterationFn throw is caught, emits error + turn-end", async () => {
    const { events, emit } = localEvents();
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterationFn: async () => {
          throw new Error("boom");
        },
        onEvent: emit,
      }) as any,
    );
    await runner.run();
    expect(events.find((e) => e.type === "error")).toMatchObject({
      type: "error",
      message: "boom",
    });
    expect(events.find((e) => e.type === "turn-end")).toMatchObject({
      reason: "iteration-threw",
    });
  });

  it("initialUserMessage is delivered to first iteration", async () => {
    const seen: (string | undefined)[] = [];
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        initialUserMessage: "hello",
        iterationFn: async ({ userMessage }) => {
          seen.push(userMessage);
          return {
            completed: true,
            failed: false,
            exhausted: false,
            aborted: false,
          };
        },
      }) as any,
    );
    await runner.run();
    expect(seen[0]).toBe("hello");
  });

  it("subsequent iterations get undefined userMessage (self-continuation)", async () => {
    const seen: (string | undefined)[] = [];
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        initialUserMessage: "first",
        iterationFn: async ({ userMessage }) => {
          seen.push(userMessage);
          return seen.length >= 2
            ? { completed: true, failed: false, exhausted: false, aborted: false }
            : { completed: false, failed: false, exhausted: false, aborted: false };
        },
      }) as any,
    );
    await runner.run();
    expect(seen).toEqual(["first", undefined]);
  });

  it("forceStop() exits even while iterationFn is pending", async () => {
    let abortSeen = false;
    const runner = new GoalTurnRunner(
      baseRunnerOpts({
        iterIdleMs: 1_000_000, // very long
        iterationFn: ({ signal }) =>
          new Promise<DaemonIterationResult>((resolve) => {
            signal.addEventListener("abort", () => {
              abortSeen = true;
              resolve({
                completed: false,
                failed: false,
                exhausted: false,
                aborted: true,
              });
            });
          }),
      }) as any,
    );
    const runP = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    runner.forceStop();
    await runP;
    expect(abortSeen).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// C5 (graceful shutdown + boot-resume + dangling-tool repair).
// ────────────────────────────────────────────────────────────────────────
describe("GoalDaemon C5 — boot-resume + graceful stop + dangling-tool repair", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkTmpWorkspace();
  });

  it("start() boot-resumes every active goal via the injected runnerFactory", async () => {
    // Create three goals: two active, one already-completed. Boot-resume
    // should kick only the active two.
    const { createGoal, endGoal } = await import("./store.js");
    const g1 = await createGoal(workspace, { objective: "g1", scope: { kind: "global" }, model: "fake" });
    const g2 = await createGoal(workspace, { objective: "g2", scope: { kind: "global" }, model: "fake" });
    const g3 = await createGoal(workspace, { objective: "g3", scope: { kind: "global" }, model: "fake" });
    await endGoal(workspace, g3.id, "done");

    // Build a runnerFactory that records its calls + returns runners
    // that exit immediately. Each runner emits one iteration-end /
    // turn-end so the daemon's runners map self-clears.
    const kicks: { goalId: string; source?: string }[] = [];
    const runnerFactory = (goalId: string, kickOpts: { source?: string }) => {
      kicks.push({ goalId, ...(kickOpts.source ? { source: kickOpts.source } : {}) });
      const noopIter: IterationFn = async () => ({
        completed: true,
        failed: false,
        exhausted: false,
        aborted: false,
      });
      return new GoalTurnRunner({
        goalId,
        iterationBudget: 1,
        iterIdleMs: 1,
        iterationFn: noopIter,
        onEvent: () => undefined,
      });
    };

    const daemon = new GoalDaemon({ workspace, runnerFactory });
    await daemon.start();
    // Wait a tick so the kicked runners actually run their no-op iteration.
    await new Promise((r) => setTimeout(r, 30));

    // Both active goals got kicked exactly once, with source: boot-resume.
    expect(kicks.map((k) => k.goalId).sort()).toEqual([g1.id, g2.id].sort());
    for (const k of kicks) {
      expect(k.source).toBe("boot-resume");
    }
    // The completed goal was NOT kicked.
    expect(kicks.some((k) => k.goalId === g3.id)).toBe(false);

    await daemon.stop(1_000);
  });

  it("start() is a no-op when MATHRAN_DISABLE_GOAL_DAEMON=1", async () => {
    const prior = process.env.MATHRAN_DISABLE_GOAL_DAEMON;
    process.env.MATHRAN_DISABLE_GOAL_DAEMON = "1";
    try {
      const { createGoal } = await import("./store.js");
      await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
      const kicks: string[] = [];
      const runnerFactory = (goalId: string) => {
        kicks.push(goalId);
        return new GoalTurnRunner({
          goalId,
          iterationBudget: 1,
          iterIdleMs: 1,
          iterationFn: async () => ({ completed: true, failed: false, exhausted: false, aborted: false }),
          onEvent: () => undefined,
        });
      };
      const daemon = new GoalDaemon({ workspace, runnerFactory });
      await daemon.start();
      expect(kicks).toEqual([]);
      await daemon.stop(100);
    } finally {
      if (prior === undefined) delete process.env.MATHRAN_DISABLE_GOAL_DAEMON;
      else process.env.MATHRAN_DISABLE_GOAL_DAEMON = prior;
    }
  });

  it("start() patches a dangling assistant tool-call before kicking the goal", async () => {
    // Set up a goal with a single conversation whose last assistant
    // message has two tool_calls, only ONE of which has a follower.
    const { createGoal } = await import("./store.js");
    const g = await createGoal(workspace, {
      objective: "dangling",
      scope: { kind: "global" },
      model: "fake",
    });
    const cid = "conv-dangling-001";
    // We have to teach the goal record about this conversation id so
    // boot-resume sees it. Direct file mutation: simplest path that
    // matches the v0.17 store layout.
    const { default: path } = await import("node:path");
    const fs = await import("node:fs/promises");
    const goalPath = path.join(workspace, ".mathran", "goals", `${g.id}.json`);
    const raw = JSON.parse(await fs.readFile(goalPath, "utf-8"));
    raw.conversationIds = [cid];
    await fs.writeFile(goalPath, JSON.stringify(raw, null, 2));

    // Write the conversation jsonl with a dangling tool-call.
    const { flushConversationHistory } = await import("../chat/store.js");
    await flushConversationHistory(
      workspace,
      { kind: "global" },
      cid,
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_A", name: "toolA", arguments: "{}" },
            { id: "call_B", name: "toolB", arguments: "{}" },
          ],
        },
        // Only call_A is answered; call_B is dangling.
        { role: "tool", content: "ok", toolCallId: "call_A", name: "toolA" },
      ],
    );

    // Boot-resume should: (1) splice in a synthetic tool-result for
    // call_B, (2) kick the goal.
    const kicks: string[] = [];
    const runnerFactory = (goalId: string) => {
      kicks.push(goalId);
      return new GoalTurnRunner({
        goalId,
        iterationBudget: 1,
        iterIdleMs: 1,
        iterationFn: async () => ({ completed: true, failed: false, exhausted: false, aborted: false }),
        onEvent: () => undefined,
      });
    };
    const daemon = new GoalDaemon({ workspace, runnerFactory });
    await daemon.start();
    await new Promise((r) => setTimeout(r, 30));

    expect(kicks).toEqual([g.id]);

    // Re-read the jsonl: there should now be 4 messages, with the new
    // call_B placeholder slotted right after the assistant turn.
    const { loadConversationHistory } = await import("../chat/store.js");
    const repaired = await loadConversationHistory(workspace, { kind: "global" }, cid);
    expect(repaired).toHaveLength(4);
    expect(repaired[0]!.role).toBe("user");
    expect(repaired[1]!.role).toBe("assistant");
    // The synthetic placeholder is inserted BEFORE the existing call_A
    // tool-result — the splice walks left-to-right and patches AFTER
    // the assistant turn before continuing on. Both id mappings still
    // resolve in the same conversation so the LLM provider is happy.
    const toolMsgs = repaired.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    const byId = new Map(toolMsgs.map((m) => [m.toolCallId!, m]));
    expect(byId.get("call_A")?.content).toBe("ok");
    const placeholder = byId.get("call_B");
    expect(placeholder?.toolCallId).toBe("call_B");
    expect(placeholder?.name).toBe("toolB");
    const parsed = JSON.parse(placeholder?.content as string);
    expect(parsed).toEqual({ aborted: true, reason: "server restart" });

    await daemon.stop(1_000);
  });

  it("start() is robust to a goal whose kick throws (missing runnerFactory)", async () => {
    // Daemon constructed WITHOUT runnerFactory — boot-resume should
    // still complete (logging the kick failures), not throw.
    const { createGoal } = await import("./store.js");
    await createGoal(workspace, { objective: "x", scope: { kind: "global" }, model: "fake" });
    const daemon = new GoalDaemon({ workspace });
    await expect(daemon.start()).resolves.toBeUndefined();
    await daemon.stop(100);
  });

  it("stop(ms) interrupts a runner that won't finish on its own within the budget", async () => {
    // A runner whose iterationFn hangs forever (resolves only on
    // signal.aborted). stop(50) should force-stop it within ~100ms
    // total, not wait forever.
    let abortObserved = false;
    const hangingIter: IterationFn = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          abortObserved = true;
          resolve({ completed: false, failed: false, exhausted: false, aborted: true });
        });
      });
    const daemon = new GoalDaemon({ workspace });
    const runner = new GoalTurnRunner({
      goalId: "hanging",
      iterationBudget: 1,
      iterIdleMs: 1,
      iterationFn: hangingIter,
      onEvent: () => undefined,
    });
    daemon.kickGoalWithRunner("hanging", runner);
    // Let the iteration start.
    await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    await daemon.stop(50);
    const elapsed = Date.now() - t0;
    // Generous upper bound — stop should have interrupted within
    // 50ms + a tiny overhead.
    expect(elapsed).toBeLessThan(500);
    expect(abortObserved).toBe(true);
  });

  it("start() called after stop() logs + returns without throwing", async () => {
    const daemon = new GoalDaemon({ workspace });
    await daemon.stop(10);
    await expect(daemon.start()).resolves.toBeUndefined();
  });
});

// Tiny mktemp helper used by C5 tests above (mirrors the runner.test.ts
// helper so this file stays self-contained).
async function mkTmpWorkspace(): Promise<string> {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-daemon-c5-"));
  return dir;
}
