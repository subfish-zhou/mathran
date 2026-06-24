/**
 * Goal Daemon — async backend driver for goal-mode loops.
 *
 * Status: SKELETON (C1 commit). This file declares the GoalDaemon and
 * GoalTurnRunner classes with their full lifecycle interface, but does NOT
 * yet wire into the serve.ts endpoints. The integration is staged for
 * commits C3 and beyond.
 *
 * Design doc: ~/.openclaw/workspace/_tasks/todo1-design.md
 * See §5.1 (daemon.ts pseudocode) and §8 (commit plan).
 *
 * Why daemon?
 *   Today, goal mode is driven by SPA setInterval(120_000) calling
 *   POST /api/goals/:id/run/stream. When that endpoint runs without a
 *   user-supplied message, runner.ts injects the literal string
 *   "Continue with the current objective." as a fake user message.
 *
 *   Problems:
 *     - closing the SPA tab freezes the goal forever (interval gone)
 *     - network blips → endpoint throws → endGoal(failed) → manual resume
 *     - conversation history is polluted by dozens of fake "Continue..."
 *
 *   Daemon-mode fixes all three: a long-lived in-process scheduler runs
 *   the iteration loop entirely server-side. SPA becomes a passive
 *   observer over SSE. Closing the SPA does not affect the goal.
 */

import { EventEmitter } from "node:events";
import { listGoals, type Goal } from "./store.js";
import {
  flushConversationHistory,
  loadConversationHistory,
} from "../chat/store.js";
import type { LLMMessage } from "../providers/llm.js";

/** Daemon-level configuration. */
export interface GoalDaemonOptions {
  workspace: string;
  /**
   * Idle gap between iterations (ms). Default 5s. Allows backend to breathe,
   * prevents tight loops on pathological models, and gives the steer queue
   * room to receive late-arriving messages.
   */
  iterIdleMs?: number;
  /**
   * Maximum number of GoalTurnRunner instances allowed concurrently. Excess
   * kicks are FIFO-queued. Default 8.
   */
  maxConcurrent?: number;
  /**
   * **C3:** production runner factory. Called by `kickGoal()` when a goal
   * is not yet running. Receives the goalId + the kick options (initial
   * user message, source label) and returns a fully-constructed
   * `GoalTurnRunner` whose `iterationFn` wraps `runOneIteration` with all
   * production deps (LLM, tools, inflight-abort registration,
   * steerProbe, SSE-event broadcast, etc).
   *
   * When `undefined` (C1 / unit-test default), `kickGoal()` falls back to
   * its skeleton behaviour and throws — tests must use
   * `kickGoalWithRunner` to inject hand-rolled runners. C3+ production
   * code (serve.ts buildApp) passes a factory so the daemon can drive
   * real goals end-to-end.
   */
  runnerFactory?: (
    goalId: string,
    kickOpts: { userMessage?: string; source?: string },
  ) => GoalTurnRunner;
}

/** Per-iteration event sent to the daemon's eventBus. Shape matches the
 *  existing onEvent contract used by runGoalRound so SSE wire format
 *  doesn't change. */
export interface DaemonEvent {
  type:
    | "session"
    | "text"
    | "tool-call"
    | "tool-result"
    | "step"
    | "round-start"
    | "round-end"
    | "ask_user"
    | "todos"
    | "steer-received"
    | "subagent-completed"
    | "iteration-start"
    | "iteration-end"
    | "turn-end"
    | "error";
  [k: string]: unknown;
}

/**
 * Daemon. Owns a Map of per-goal GoalTurnRunner instances. Each runner
 * runs a single concurrent turn-loop. New kicks for an already-running
 * goal enqueue the user message into the existing runner.
 */
export class GoalDaemon {
  static readonly ITER_IDLE_MS_DEFAULT = 5_000;
  static readonly MAX_CONCURRENT_DEFAULT = 8;

  readonly eventBus = new EventEmitter();

  private readonly opts: {
    workspace: string;
    iterIdleMs: number;
    maxConcurrent: number;
    runnerFactory?: GoalDaemonOptions["runnerFactory"];
  };
  private readonly runners = new Map<string, GoalTurnRunner>();
  private stopped = false;

  constructor(opts: GoalDaemonOptions) {
    this.opts = {
      workspace: opts.workspace,
      iterIdleMs: opts.iterIdleMs ?? GoalDaemon.ITER_IDLE_MS_DEFAULT,
      maxConcurrent: opts.maxConcurrent ?? GoalDaemon.MAX_CONCURRENT_DEFAULT,
      ...(opts.runnerFactory ? { runnerFactory: opts.runnerFactory } : {}),
    };
    // Avoid the EE memory warning under heavy multi-tab SSE load.
    this.eventBus.setMaxListeners(100);
  }

  /**
   * Boot: enumerate active goals and kick them. Called once on serve.ts
   * startup. Skips work when MATHRAN_DISABLE_GOAL_DAEMON=1.
   *
   * **C5 (boot-resume + dangling-tool repair):**
   *   1. Lists every Goal record in the workspace.
   *   2. For each goal whose `status === "active"`, scans every
   *      conversation tied to it and repairs any *dangling tool-call*
   *      — i.e. an assistant message whose `toolCalls[i].id` has no
   *      matching `{role:"tool", toolCallId: i}` follower. Splices in
   *      a synthetic `{aborted: true, reason: "server restart"}`
   *      tool-result so the next LLM call doesn't fail provider
   *      validation (OpenAI 400 "each `tool_call` must have a
   *      corresponding `tool_message`").
   *   3. Calls `kickGoal(goalId, { source: "boot-resume" })` so the
   *      daemon's runner factory drives the loop again.
   *
   * Boot-resume requires a `runnerFactory` in the daemon's options
   * (production wiring from C3). Without one, the kicks would throw the
   * "not yet wired" error, which boot-resume catches + logs (so unit
   * tests that don't provide a factory still get a no-op start). Errors
   * during disk scans or repair are logged + swallowed so a single
   * corrupt goal doesn't block boot.
   */
  async start(): Promise<void> {
    if (process.env.MATHRAN_DISABLE_GOAL_DAEMON === "1") {
      // eslint-disable-next-line no-console
      console.warn("[goal-daemon] disabled via MATHRAN_DISABLE_GOAL_DAEMON=1");
      return;
    }
    if (this.stopped) {
      // Started after stop() — reuse is unsupported. Just log and return.
      // eslint-disable-next-line no-console
      console.warn("[goal-daemon] start() called on a stopped daemon — ignoring");
      return;
    }
    let active: Goal[] = [];
    try {
      const all = await listGoals(this.opts.workspace);
      active = all.filter((g) => g.status === "active");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[goal-daemon] listGoals() failed on boot:", err);
      return;
    }
    if (active.length === 0) {
      // eslint-disable-next-line no-console
      console.log("[goal-daemon] boot-resume: no active goals to resume");
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[goal-daemon] boot-resume: ${active.length} active goal(s) to resume`,
    );
    for (const g of active) {
      // 1. Repair any dangling tool-call placeholders in this goal's
      //    conversations. Best-effort: a single goal's repair failure
      //    shouldn't block the rest of the boot-resume sweep.
      try {
        const repaired = await this.repairDanglingToolCalls(g);
        if (repaired > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[goal-daemon] boot-resume: goal ${g.id} — patched ${repaired} dangling tool-call(s)`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[goal-daemon] boot-resume: goal ${g.id} — dangling-repair failed:`,
          err,
        );
      }
      // 2. Kick the goal. Errors logged + swallowed so one bad goal
      //    can't block the rest of the sweep.
      try {
        this.kickGoal(g.id, { source: "boot-resume" });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[goal-daemon] boot-resume: goal ${g.id} — kick failed (no runner factory?):`,
          err,
        );
      }
    }
  }

  /**
   * **C5 helper:** scan each conversation attached to a goal and patch
   * any unanswered tool-call.
   *
   * A dangling tool-call is an assistant message with `toolCalls[i].id`
   * whose conversation has no subsequent `{role:"tool",
   * toolCallId: i}`. The server crashed (or was kill -9'd) between the
   * LLM emitting the call + the tool result being persisted. Replaying
   * the conversation as-is to the LLM provider returns HTTP 400
   * "messages with role 'tool' must follow a message with tool_calls"
   * — the goal is wedged until someone manually rewrites the jsonl.
   *
   * Repair: splice in a synthetic
   * `{role:"tool", toolCallId, name, content: '{"aborted":true,"reason":"server restart"}'}`
   * right after the assistant turn so the LLM sees a clean "that tool
   * call was aborted by a server restart" signal on the next round.
   *
   * Returns the number of placeholders inserted across all
   * conversations of this goal.
   */
  private async repairDanglingToolCalls(g: Goal): Promise<number> {
    if (!g.conversationIds || g.conversationIds.length === 0) return 0;
    let totalPatched = 0;
    for (const cid of g.conversationIds) {
      let history: LLMMessage[];
      try {
        history = await loadConversationHistory(this.opts.workspace, g.scope, cid);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[goal-daemon] dangling-repair: load failed for conv ${cid}:`,
          err,
        );
        continue;
      }
      if (history.length === 0) continue;
      // Walk left-to-right and splice; we mutate `history` in place
      // and re-flush if any repair was needed.
      const patched: LLMMessage[] = [];
      let patchedThisConv = 0;
      for (let i = 0; i < history.length; i++) {
        const msg = history[i]!;
        patched.push(msg);
        if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) {
          continue;
        }
        // Find which of this assistant's tool-call ids ALREADY have a
        // tool-result follower in the rest of the history. Order
        // doesn't matter for OpenAI's validator — as long as every
        // toolCallId is answered SOMEWHERE in the subsequent
        // messages, the conversation replays cleanly.
        const answered = new Set<string>();
        for (let j = i + 1; j < history.length; j++) {
          const follower = history[j]!;
          if (follower.role !== "tool") continue;
          if (typeof follower.toolCallId === "string") {
            answered.add(follower.toolCallId);
          }
        }
        for (const call of msg.toolCalls) {
          if (answered.has(call.id)) continue;
          // Splice a synthetic tool-result. Use the same shape the
          // runner uses for the tool-call-budget-exhausted branch:
          // {role:"tool", content, toolCallId, name}.
          patched.push({
            role: "tool",
            content: JSON.stringify({
              aborted: true,
              reason: "server restart",
            }),
            toolCallId: call.id,
            name: call.name,
          });
          patchedThisConv += 1;
          totalPatched += 1;
        }
      }
      if (patchedThisConv > 0) {
        try {
          await flushConversationHistory(
            this.opts.workspace,
            g.scope,
            cid,
            patched,
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[goal-daemon] dangling-repair: flush failed for conv ${cid}:`,
            err,
          );
        }
      }
    }
    return totalPatched;
  }

  /**
   * Stop daemon (called on serve.ts shutdown). Interrupts all runners,
   * waits for them to finish their current iteration gracefully.
   *
   * SKELETON: implemented for unit-test parity, but no integration yet.
   */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    for (const r of this.runners.values()) r.interrupt();
    const deadline = Date.now() + timeoutMs;
    while (this.runners.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Force-resolve any still-hanging runners, then let the runner.run()
    // promise's .finally() actually fire so the Map entry is removed.
    if (this.runners.size > 0) {
      for (const r of this.runners.values()) r.forceStop();
      const cleanupDeadline = Date.now() + 200;
      while (this.runners.size > 0 && Date.now() < cleanupDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }

  /**
   * Kick a goal: if already running, enqueue the user message; otherwise
   * spawn a fresh GoalTurnRunner. Idempotent w.r.t. concurrent kicks for
   * the same goal.
   *
   * SKELETON: uses an injectable runOneIteration so unit tests can drive
   * the loop without bringing the full goal stack online. The real
   * runner factory is wired in C3.
   */
  kickGoal(
    goalId: string,
    opts?: { userMessage?: string; source?: string },
  ): void {
    if (this.stopped) return;
    const existing = this.runners.get(goalId);
    if (existing) {
      if (opts?.userMessage) existing.enqueueUserMessage(opts.userMessage);
      else existing.notify();
      return;
    }
    // C3 production path: if the daemon was constructed with a
    // `runnerFactory`, use it to build a real GoalTurnRunner (wired to
    // runOneIteration + LLM + tools + steerProbe + SSE event
    // broadcast) and register it. Falls back to the C1 "not yet wired"
    // error when no factory was supplied (unit-test path — those tests
    // must use `kickGoalWithRunner`).
    if (this.opts.runnerFactory) {
      const runner = this.opts.runnerFactory(goalId, opts ?? {});
      this.kickGoalWithRunner(goalId, runner);
      return;
    }
    throw new Error(
      "GoalDaemon.kickGoal not yet wired to production runner factory (C3). " +
        "Use kickGoalWithRunner for tests.",
    );
  }

  /**
   * Test-only injection point. Allows unit tests to construct their own
   * GoalTurnRunner (with a mocked runOneIteration) and let the daemon
   * track it lifecycle-wise.
   */
  kickGoalWithRunner(goalId: string, runner: GoalTurnRunner): void {
    if (this.stopped) return;
    if (this.runners.has(goalId)) {
      throw new Error(`Runner for goal ${goalId} already registered`);
    }
    this.runners.set(goalId, runner);
    runner
      .run()
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[goal-daemon] runner crashed for goal ${goalId}:`, err);
        this.eventBus.emit(`goal:${goalId}`, {
          type: "error",
          message: String(
            (err as { message?: unknown })?.message ?? err,
          ),
        });
      })
      .finally(() => {
        this.runners.delete(goalId);
      });
  }

  /** Interrupt the current iteration but keep daemon entry. Goal stays active. */
  interrupt(goalId: string): boolean {
    const r = this.runners.get(goalId);
    if (!r) return false;
    r.interrupt();
    return true;
  }

  /** Forward steer to runner (which will inject pre-iteration). */
  enqueueSteer(goalId: string, text: string): boolean {
    const r = this.runners.get(goalId);
    if (!r) return false;
    r.enqueueSteer(text);
    return true;
  }

  /** Send abort: runner will mark goal cancelled and exit run() loop. */
  abort(goalId: string): boolean {
    const r = this.runners.get(goalId);
    if (!r) return false;
    r.abort();
    return true;
  }

  isRunning(goalId: string): boolean {
    return this.runners.has(goalId);
  }

  /** Snapshot for status endpoint. */
  status(): { running: string[]; iterations: Record<string, number> } {
    const iterations: Record<string, number> = {};
    for (const [id, r] of this.runners) iterations[id] = r.iterationCount();
    return { running: [...this.runners.keys()], iterations };
  }
}

/**
 * Minimal IterationResult shape used by the daemon. The real
 * src/core/goal/runner.ts.RunRoundResult is wider; we accept a subset
 * here so unit tests can construct one without importing the full
 * runner. Will be re-exported with extra fields (e.g. naturalTurnEnd)
 * in C2 once runner.ts is refactored.
 */
export interface DaemonIterationResult {
  completed: boolean;
  failed: boolean;
  exhausted: boolean;
  aborted: boolean;
  naturalTurnEnd?: boolean;
  endReason?: string;
}

/** The function each iteration calls. Will resolve to runOneIteration in C2. */
export type IterationFn = (input: {
  goalId: string;
  userMessage: string | undefined;
  steerText: string | undefined;
  iteration: number;
  signal: AbortSignal;
  emit: (ev: DaemonEvent) => void;
}) => Promise<DaemonIterationResult>;

/**
 * GoalTurnRunner — drives one goal's main loop.
 *
 * Lifecycle:
 *   1. Constructed with goalId + dependencies + initial user message (optional).
 *   2. run() is called once. It loops over iterations until terminal state:
 *      - model emits completed/failed/exhausted via tool calls (mark_done, give_up)
 *      - external interrupt() / abort() / forceStop()
 *      - iteration budget reached
 *      - no pending user message AND last assistant message was a natural turn end
 *        (model decided the turn is done; wait for next user input)
 *   3. After run() returns, the daemon removes the runner from its Map.
 *
 * SKELETON: business logic (budget enforcement, dangling tool_call repair,
 * goal status re-check) is stubbed. The loop structure and lifecycle hooks
 * are real and unit-tested.
 */
export class GoalTurnRunner {
  private interrupted = false;
  private aborted = false;
  private forceStopped = false;
  private iter = 0;
  private pendingUserMessages: string[] = [];
  private pendingSteer = "";
  private sleepResolver: (() => void) | null = null;
  private currentAbort: AbortController | null = null;

  constructor(
    private readonly opts: {
      goalId: string;
      /** Hard cap on iteration count. Sourced from goal.budget.roundsMax. */
      iterationBudget: number;
      /** Idle gap between iterations (ms). */
      iterIdleMs: number;
      /** Initial user message (if this run is being kicked off by a user). */
      initialUserMessage?: string;
      /** Test seam: function called per iteration. In production this is
       *  runOneIteration from runner.ts (wired in C2). */
      iterationFn: IterationFn;
      /** Event sink — daemon pipes these to eventBus. */
      onEvent: (ev: DaemonEvent) => void;
      /**
       * Optional check: re-read goal status from disk and return true if
       * the runner should exit (status flipped to paused/cancelled/etc).
       * Defaults to always-active for tests.
       */
      isGoalStillActive?: () => Promise<boolean>;
    },
  ) {
    if (opts.initialUserMessage)
      this.pendingUserMessages.push(opts.initialUserMessage);
  }

  iterationCount(): number {
    return this.iter;
  }

  /**
   * Main loop. Runs until a terminal condition. Returns normally — caller
   * should NOT await it inside a request handler (it can run for hours).
   */
  async run(): Promise<void> {
    const isActive = this.opts.isGoalStillActive ?? (() => Promise.resolve(true));

    while (!this.forceStopped) {
      // 1. External status check (paused/cancelled by another endpoint).
      if (!(await isActive())) {
        this.opts.onEvent({ type: "turn-end", reason: "status-flipped" });
        return;
      }

      // 2. Pre-iteration interrupt/abort guards.
      if (this.interrupted) {
        this.opts.onEvent({ type: "turn-end", reason: "interrupted" });
        return;
      }
      if (this.aborted) {
        this.opts.onEvent({ type: "turn-end", reason: "aborted" });
        return;
      }

      // 3. Take next user message (sentinel '' for self-continuation).
      const userMessage = this.pendingUserMessages.shift();

      // 4. Drain steer queue (hermes-style pre-iteration drain).
      const steerText = this.consumePendingSteer();

      // 5. Run one iteration (test seam: opts.iterationFn).
      this.iter++;
      this.opts.onEvent({
        type: "iteration-start",
        iteration: this.iter,
        budget: this.opts.iterationBudget,
      });
      this.currentAbort = new AbortController();
      let result: DaemonIterationResult;
      try {
        result = await this.opts.iterationFn({
          goalId: this.opts.goalId,
          userMessage,
          steerText,
          iteration: this.iter,
          signal: this.currentAbort.signal,
          emit: (ev) => this.opts.onEvent(ev),
        });
      } catch (err) {
        const message = String((err as { message?: unknown })?.message ?? err);
        this.opts.onEvent({ type: "error", message });
        this.opts.onEvent({ type: "turn-end", reason: "iteration-threw" });
        return;
      } finally {
        this.currentAbort = null;
      }
      this.opts.onEvent({
        type: "iteration-end",
        iteration: this.iter,
        result,
      });

      // 6. Terminal conditions check.
      if (result.completed) {
        this.opts.onEvent({ type: "turn-end", reason: "completed" });
        return;
      }
      if (result.failed) {
        this.opts.onEvent({ type: "turn-end", reason: "failed" });
        return;
      }
      if (result.exhausted) {
        this.opts.onEvent({ type: "turn-end", reason: "exhausted" });
        return;
      }
      if (result.aborted) {
        this.opts.onEvent({
          type: "turn-end",
          reason: "interrupted-mid-iteration",
        });
        return;
      }
      if (result.naturalTurnEnd) {
        // Model ended the turn voluntarily (final text, no tool_calls).
        // Wait for next user message or external notify (no polling).
        this.opts.onEvent({ type: "turn-end", reason: "natural" });
        const woke = await this.sleepUntilNotified();
        if (!woke) return; // forceStop or abort during sleep
        continue;
      }

      // 7. Iteration budget guard.
      if (this.iter >= this.opts.iterationBudget) {
        this.opts.onEvent({
          type: "turn-end",
          reason: `budget-exhausted(${this.iter}/${this.opts.iterationBudget})`,
        });
        return;
      }

      // 8. Idle gap (interruptible).
      await this.sleepInterruptible(this.opts.iterIdleMs);
    }
  }

  interrupt(): void {
    this.interrupted = true;
    this.currentAbort?.abort();
    this.wake();
  }
  abort(): void {
    this.aborted = true;
    this.currentAbort?.abort();
    this.wake();
  }
  forceStop(): void {
    this.forceStopped = true;
    this.currentAbort?.abort();
    this.wake();
  }
  notify(): void {
    this.wake();
  }
  enqueueUserMessage(m: string): void {
    this.pendingUserMessages.push(m);
    this.wake();
  }
  enqueueSteer(t: string): void {
    this.pendingSteer += (this.pendingSteer ? "\n" : "") + t;
  }

  private consumePendingSteer(): string | undefined {
    if (!this.pendingSteer) return undefined;
    const s = this.pendingSteer;
    this.pendingSteer = "";
    return s;
  }

  private wake(): void {
    const r = this.sleepResolver;
    this.sleepResolver = null;
    if (r) r();
  }

  private sleepUntilNotified(): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.forceStopped || this.aborted || this.interrupted)
        return resolve(false);
      this.sleepResolver = () =>
        resolve(!this.forceStopped && !this.aborted && !this.interrupted);
    });
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) return resolve();
      const t = setTimeout(() => {
        this.sleepResolver = null;
        resolve();
      }, ms);
      this.sleepResolver = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

// Suppress TS unused-import warnings for the Goal type once wiring lands.
// Until then we keep the import explicit so the type is visible to readers.
export type { Goal };
