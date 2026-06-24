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
