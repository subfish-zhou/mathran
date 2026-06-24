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
import * as fs from "node:fs";
import * as path from "node:path";
import { listGoals, flipGoalStatus, type Goal } from "./store.js";
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
  /**
   * **C6:** absolute path to an append-mode JSONL log file. When set,
   * the daemon writes one line per iteration-start / iteration-end /
   * turn-end event, including `durationMs` for iteration-end. Parent
   * directories are created on demand. Errors during open/write are
   * logged but never thrown — log failures must not break the loop.
   *
   * Default: not set (no log).
   */
  iterationLogPath?: string;
}

/**
 * **Defect #2:** Live, in-iteration progress for one runner. Populated while
 * an iteration is in flight (between `iteration-start` and `iteration-end`)
 * and reset to `null` between iterations. Lets a polling observer of
 * `GET /api/goals/daemon/status` see what a long-running iteration is
 * actually doing without an SSE subscription.
 */
export interface IterationProgress {
  /** Iteration index for this runner (matches GoalRunnerStatus.iterations). */
  iteration: number;
  /** Epoch ms when this iteration started. */
  startedAt: number;
  /** Count of assistant turns seen (one per LLM `done` frame). */
  assistantTurns: number;
  /** Count of tool-call frames seen. */
  toolCalls: number;
  /** Count of tool-result frames seen. */
  toolResults: number;
  /** Count of text frames seen. */
  textChunks: number;
  /** Name of the most recent tool call, or null if none yet. */
  lastToolName: string | null;
  /** Epoch ms of the most recent tool-call frame, or null. */
  lastToolCallAt: number | null;
  /** Epoch ms of the most recent text frame, or null. */
  lastTextAt: number | null;
}

/** **C6:** Per-runner status row returned by GoalDaemon.status(). */
export interface GoalRunnerStatus {
  goalId: string;
  /** Epoch ms when GoalTurnRunner instance was constructed. */
  startedAt: number;
  /** Iteration counter (post-iteration-start). */
  iterations: number;
  /** Epoch ms of the most recent event emitted by this runner. */
  lastEventAt: number;
  /** Coarse runtime state — useful for ops dashboards. */
  state: GoalRunnerState;
  /** What kicked off this runner (e.g. "user-send" / "boot-resume" / "steer" / "answer-ask"). */
  source?: string;
  /**
   * **Defect #2:** live in-iteration progress, or `null` when the runner is
   * between iterations (sleeping / waiting-user / starting / done).
   */
  progress: IterationProgress | null;
}

export type GoalRunnerState =
  | "starting"            // constructed, run() not yet entered
  | "iterating"           // inside an iterationFn await
  | "sleeping"            // inside the iter-idle gap
  | "waiting-user"        // parked after naturalTurnEnd, awaiting kick
  | "interrupting"        // interrupt/abort requested, draining
  | "done";               // run() returned (transient — runner cleared from Map ASAP)

/** **C6:** Full daemon-level status snapshot. */
export interface GoalDaemonStatus {
  enabled: boolean;
  stopped: boolean;
  maxConcurrent: number;
  iterIdleMs: number;
  runnerCount: number;
  /**
   * Number of kicks queued beyond `maxConcurrent`. The current daemon
   * doesn't enforce that cap (see TODO §7 risk #9), so this is always
   * 0 in practice; reserved so the status shape is stable when the cap
   * lands.
   */
  queueLength: number;
  /** Path to the JSONL iteration log when enabled. */
  iterationLogPath?: string;
  runners: GoalRunnerStatus[];
  /** Backwards-compatible flat projection (kept for any pre-C6 caller). */
  running: string[];
  iterations: Record<string, number>;
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
    /** TODO-2 §3.2 / C8 — compaction lifecycle event. Forwarded from
     *  ChatSession.compactV2 via the goal runner's emit(). Persisted
     *  to daemon.log AND exposed via SSE so the SPA shows a real-time
     *  🧹 badge. */
    | "compaction"
    | "done"
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
    iterationLogPath?: string;
  };
  private readonly runners = new Map<string, GoalTurnRunner>();
  private stopped = false;
  /** **C6:** open append-mode stream for the iteration log. Created lazily on
   *  first write and closed by `stop()`. `null` when no log path configured. */
  private iterationLogStream: fs.WriteStream | null = null;
  /** **C6:** flag so we only attempt to open the stream once even if open fails. */
  private iterationLogOpenAttempted = false;

  constructor(opts: GoalDaemonOptions) {
    this.opts = {
      workspace: opts.workspace,
      iterIdleMs: opts.iterIdleMs ?? GoalDaemon.ITER_IDLE_MS_DEFAULT,
      maxConcurrent: opts.maxConcurrent ?? GoalDaemon.MAX_CONCURRENT_DEFAULT,
      ...(opts.runnerFactory ? { runnerFactory: opts.runnerFactory } : {}),
      ...(opts.iterationLogPath ? { iterationLogPath: opts.iterationLogPath } : {}),
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
    // ─── NEW-F1 (audit 2026-06-24): stale-active triage ────────────────
    // A goal whose last audit step is > STALE_HOURS_THRESHOLD ago but
    // still status="active" is almost certainly a victim of a hard crash
    // (mathran serve died mid-iteration without flipping the status).
    // Re-kicking such a goal can loop forever if the underlying failure
    // (token expired, network broken, prompt too long) is structural.
    // Strategy: don't auto-resume it. Flip it to "paused" with an audit
    // step explaining why so the user sees a yellow badge in the SPA
    // and can /resume manually after fixing the upstream issue.
    const STALE_HOURS_THRESHOLD = 6;
    const stale: Goal[] = [];
    const fresh: Goal[] = [];
    const nowMs = Date.now();
    for (const g of active) {
      const lastStep = g.steps[g.steps.length - 1];
      const lastAtMs = lastStep ? Date.parse(lastStep.at) : Date.parse(g.createdAt);
      const ageHours = Number.isFinite(lastAtMs) ? (nowMs - lastAtMs) / (60 * 60 * 1000) : Infinity;
      if (ageHours > STALE_HOURS_THRESHOLD) stale.push(g);
      else fresh.push(g);
    }
    if (stale.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[goal-daemon] boot-resume: ${stale.length} stale goal(s) (>${STALE_HOURS_THRESHOLD}h since last activity) — flipping to paused`,
      );
      for (const g of stale) {
        try {
          await flipGoalStatus(this.opts.workspace, g.id, "paused", "boot-resume: stale active (>6h since last step)");
          // eslint-disable-next-line no-console
          console.warn(
            `[goal-daemon] boot-resume: goal ${g.id.slice(0, 8)} paused (use POST /api/goals/:id/resume to revive)`,
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[goal-daemon] boot-resume: failed to pause ${g.id}:`, err);
        }
      }
    }
    if (fresh.length === 0) {
      // eslint-disable-next-line no-console
      console.log("[goal-daemon] boot-resume: no fresh active goals to resume");
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[goal-daemon] boot-resume: ${fresh.length} active goal(s) to resume`,
    );
    for (const g of fresh) {
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
    // **C6:** flush + close the iteration log stream so test workers
    // and graceful shutdowns don't leak file descriptors. Best-effort.
    if (this.iterationLogStream) {
      const s = this.iterationLogStream;
      this.iterationLogStream = null;
      await new Promise<void>((resolve) => {
        try {
          s.end(() => resolve());
        } catch {
          resolve();
        }
      });
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
      // **C6:** stamp the kick source onto the runner so the status
      // endpoint can report what set this loop in motion.
      if (opts?.source) runner.setSource(opts.source);
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

    // **C6:** subscribe to this runner's events for iteration-log
    // writing. We tap directly on the eventBus channel rather than
    // wrapping runner.onEvent so we also see events emitted by the
    // wrapped iterationFn (e.g. tool-call frames forwarded from
    // runOneIteration). Track per-iteration start timestamps so
    // iteration-end gets a `durationMs` field.
    if (this.opts.iterationLogPath) {
      const iterStartTs = new Map<number, number>();
      const channel = `goal:${goalId}`;
      const listener = (ev: DaemonEvent) => {
        const type = ev.type;
        if (type === "iteration-start") {
          const it = Number((ev as { iteration?: unknown }).iteration ?? 0);
          const now = Date.now();
          iterStartTs.set(it, now);
          this.appendIterationLog({
            ts: now,
            goalId,
            event: "iteration-start",
            iteration: it,
            budget: (ev as { budget?: unknown }).budget,
          });
        } else if (type === "iteration-end") {
          const it = Number((ev as { iteration?: unknown }).iteration ?? 0);
          const now = Date.now();
          const start = iterStartTs.get(it);
          if (start !== undefined) iterStartTs.delete(it);
          const result = (ev as { result?: unknown }).result as
            | { completed?: boolean; failed?: boolean; exhausted?: boolean; aborted?: boolean; naturalTurnEnd?: boolean; endReason?: string }
            | undefined;
          // **Defect #2:** the runner stamps the final per-iteration counts
          // onto the iteration-end frame; persist them so a long-tail log
          // observer can reconstruct in-iteration progress after the fact.
          const progress = (ev as { progress?: unknown }).progress as
            | { assistantTurns?: number; toolCalls?: number; toolResults?: number; textChunks?: number }
            | undefined;
          this.appendIterationLog({
            ts: now,
            goalId,
            event: "iteration-end",
            iteration: it,
            ...(start !== undefined ? { durationMs: now - start } : {}),
            ...(result
              ? {
                  result: {
                    completed: !!result.completed,
                    failed: !!result.failed,
                    exhausted: !!result.exhausted,
                    aborted: !!result.aborted,
                    ...(result.naturalTurnEnd ? { naturalTurnEnd: true } : {}),
                    ...(result.endReason ? { endReason: result.endReason } : {}),
                  },
                }
              : {}),
            ...(progress
              ? {
                  progress: {
                    assistantTurns: Number(progress.assistantTurns ?? 0),
                    toolCalls: Number(progress.toolCalls ?? 0),
                    toolResults: Number(progress.toolResults ?? 0),
                    textChunks: Number(progress.textChunks ?? 0),
                  },
                }
              : {}),
          });
        } else if (type === "turn-end") {
          this.appendIterationLog({
            ts: Date.now(),
            goalId,
            event: "turn-end",
            reason: (ev as { reason?: unknown }).reason,
          });
        } else if (type === "compaction") {
          // TODO-2 §3.2 / C8 — durably record compaction telemetry so a
          // long-tail log observer can audit how often compaction fires,
          // how much it saved, and which phase / reason / policy was
          // used. Mirrors the SSE event shape.
          this.appendIterationLog({
            ts: Date.now(),
            goalId,
            event: "compaction",
            outcome: (ev as { outcome?: unknown }).outcome,
            reason: (ev as { reason?: unknown }).reason,
            phase: (ev as { phase?: unknown }).phase,
            trigger: (ev as { trigger?: unknown }).trigger,
            policy: (ev as { policy?: unknown }).policy,
            originalTokens: (ev as { originalTokens?: unknown }).originalTokens,
            newTokens: (ev as { newTokens?: unknown }).newTokens,
            droppedRoundCount: (ev as { droppedRoundCount?: unknown }).droppedRoundCount,
            durationMs: (ev as { durationMs?: unknown }).durationMs,
            ...((ev as { summaryTokens?: unknown }).summaryTokens !== undefined
              ? { summaryTokens: (ev as { summaryTokens?: unknown }).summaryTokens }
              : {}),
          });
        } else if (type === "error") {
          this.appendIterationLog({
            ts: Date.now(),
            goalId,
            event: "error",
            message: (ev as { message?: unknown }).message,
          });
        }
      };
      this.eventBus.on(channel, listener);
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
          this.eventBus.off(channel, listener);
          this.runners.delete(goalId);
        });
      return;
    }

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

  /**
   * **C6:** Rich daemon status snapshot for the
   * `GET /api/goals/daemon/status` endpoint. Returns per-runner
   * timestamps, iteration counters, and coarse state so ops can see
   * what's running.
   */
  status(): GoalDaemonStatus {
    const runners: GoalRunnerStatus[] = [];
    const flatIters: Record<string, number> = {};
    for (const [id, r] of this.runners) {
      const snap = r.statusSnapshot();
      runners.push({ goalId: id, ...snap });
      flatIters[id] = snap.iterations;
    }
    const out: GoalDaemonStatus = {
      enabled: !this.stopped,
      stopped: this.stopped,
      maxConcurrent: this.opts.maxConcurrent,
      iterIdleMs: this.opts.iterIdleMs,
      runnerCount: this.runners.size,
      // The current daemon doesn't enforce maxConcurrent (see TODO
      // §7 risk #9), so queue length is always 0. The field is
      // reserved so the shape stays stable once the cap lands.
      queueLength: 0,
      runners,
      running: [...this.runners.keys()],
      iterations: flatIters,
    };
    if (this.opts.iterationLogPath) out.iterationLogPath = this.opts.iterationLogPath;
    return out;
  }

  /**
   * **C6:** Append one JSON line to the iteration log. Opens the
   * append-mode WriteStream lazily on first call. All errors are
   * swallowed (with a console warning) — log failures must NEVER
   * break the daemon's main loop.
   */
  private appendIterationLog(record: Record<string, unknown>): void {
    const p = this.opts.iterationLogPath;
    if (!p) return;
    if (!this.iterationLogStream && !this.iterationLogOpenAttempted) {
      this.iterationLogOpenAttempted = true;
      try {
        // Best-effort mkdir of the parent so the daemon can recover
        // from a missing ~/.mathran/logs directory.
        const dir = path.dirname(p);
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          /* dir may already exist or be unwritable — open will surface it */
        }
        this.iterationLogStream = fs.createWriteStream(p, {
          flags: "a",
          encoding: "utf8",
        });
        this.iterationLogStream.on("error", (err) => {
          // eslint-disable-next-line no-console
          console.warn(
            `[goal-daemon] iteration log stream error (${p}):`,
            err?.message ?? err,
          );
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[goal-daemon] failed to open iteration log at ${p}:`,
          (err as Error)?.message ?? err,
        );
        this.iterationLogStream = null;
      }
    }
    const stream = this.iterationLogStream;
    if (!stream) return;
    try {
      stream.write(JSON.stringify(record) + "\n");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[goal-daemon] iteration log write failed:`,
        (err as Error)?.message ?? err,
      );
    }
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
  /** **C6:** epoch ms when this runner instance was constructed. */
  private readonly startedAt: number = Date.now();
  /** **C6:** epoch ms of the most recent event emitted by this runner. */
  private lastEventAt: number = Date.now();
  /** **C6:** coarse runtime state for the status endpoint. */
  private state: GoalRunnerState = "starting";
  /** **C6:** label set by `kickGoal({source})` so the status snapshot can
   *  report what kicked off this loop. */
  private source: string | undefined;
  /** **Defect #2:** live progress for the in-flight iteration, or null when
   *  the runner is between iterations. */
  private currentProgress: IterationProgress | null = null;

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

  /** **C6:** Set the kick source label (e.g. "user-send" / "boot-resume"). */
  setSource(s: string): void {
    this.source = s;
  }

  /** **C6:** Per-runner snapshot for GoalDaemon.status(). */
  statusSnapshot(): {
    startedAt: number;
    iterations: number;
    lastEventAt: number;
    state: GoalRunnerState;
    source?: string;
    progress: IterationProgress | null;
  } {
    return {
      startedAt: this.startedAt,
      iterations: this.iter,
      lastEventAt: this.lastEventAt,
      state: this.state,
      ...(this.source ? { source: this.source } : {}),
      progress: this.currentProgress ? { ...this.currentProgress } : null,
    };
  }

  /** **C6:** wrap the configured onEvent so we can stamp `lastEventAt`
   *  on every emit — cheap, single property write. **Defect #2:** also
   *  fold the frame into the live in-iteration progress counters. */
  private emit(ev: DaemonEvent): void {
    this.lastEventAt = Date.now();
    this.updateProgress(ev);
    this.opts.onEvent(ev);
  }

  /** **Defect #2:** event-driven progress accumulation. No polling — this is
   *  invoked synchronously from `emit()` for every frame the iteration emits.
   *  Counters are only updated while an iteration is in flight (i.e. while
   *  `currentProgress` is non-null). */
  private updateProgress(ev: DaemonEvent): void {
    const p = this.currentProgress;
    if (!p) return;
    switch (ev.type) {
      case "text":
        p.textChunks++;
        p.lastTextAt = Date.now();
        break;
      case "tool-call":
        p.toolCalls++;
        p.lastToolName =
          typeof (ev as { name?: unknown }).name === "string"
            ? ((ev as { name?: unknown }).name as string)
            : p.lastToolName;
        p.lastToolCallAt = Date.now();
        break;
      case "tool-result":
        p.toolResults++;
        break;
      case "done":
        p.assistantTurns++;
        break;
      default:
        break;
    }
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
        this.state = "done";
        this.emit({ type: "turn-end", reason: "status-flipped" });
        return;
      }

      // 2. Pre-iteration interrupt/abort guards.
      if (this.interrupted) {
        this.state = "done";
        this.emit({ type: "turn-end", reason: "interrupted" });
        return;
      }
      if (this.aborted) {
        this.state = "done";
        this.emit({ type: "turn-end", reason: "aborted" });
        return;
      }

      // 3. Take next user message (sentinel '' for self-continuation).
      const userMessage = this.pendingUserMessages.shift();

      // 4. Drain steer queue (hermes-style pre-iteration drain).
      const steerText = this.consumePendingSteer();

      // 5. Run one iteration (test seam: opts.iterationFn).
      this.iter++;
      this.state = "iterating";
      // **Defect #2:** open a fresh progress struct for this iteration BEFORE
      // emitting iteration-start, so every subsequent frame (text/tool-call/
      // tool-result/done) folds into it via emit() → updateProgress().
      this.currentProgress = {
        iteration: this.iter,
        startedAt: Date.now(),
        assistantTurns: 0,
        toolCalls: 0,
        toolResults: 0,
        textChunks: 0,
        lastToolName: null,
        lastToolCallAt: null,
        lastTextAt: null,
      };
      this.emit({
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
          emit: (ev) => this.emit(ev),
        });
      } catch (err) {
        const message = String((err as { message?: unknown })?.message ?? err);
        this.state = "done";
        this.currentProgress = null;
        this.emit({ type: "error", message });
        this.emit({ type: "turn-end", reason: "iteration-threw" });
        return;
      } finally {
        this.currentAbort = null;
      }
      // **Defect #2:** snapshot the final per-iteration counts onto the
      // iteration-end frame so the daemon's iteration-log listener can
      // persist them (and any late status() poll between here and the next
      // iteration still sees the final tally via the event). Reset to null
      // immediately after so "between iterations" reports progress: null.
      const finalProgress = this.currentProgress;
      this.emit({
        type: "iteration-end",
        iteration: this.iter,
        result,
        ...(finalProgress
          ? {
              progress: {
                assistantTurns: finalProgress.assistantTurns,
                toolCalls: finalProgress.toolCalls,
                toolResults: finalProgress.toolResults,
                textChunks: finalProgress.textChunks,
              },
            }
          : {}),
      });
      this.currentProgress = null;

      // 6. Terminal conditions check.
      if (result.completed) {
        this.state = "done";
        this.emit({ type: "turn-end", reason: "completed" });
        return;
      }
      if (result.failed) {
        this.state = "done";
        this.emit({ type: "turn-end", reason: "failed" });
        return;
      }
      if (result.exhausted) {
        this.state = "done";
        this.emit({ type: "turn-end", reason: "exhausted" });
        return;
      }
      if (result.aborted) {
        this.state = "done";
        this.emit({
          type: "turn-end",
          reason: "interrupted-mid-iteration",
        });
        return;
      }
      if (result.naturalTurnEnd) {
        // Model ended the turn voluntarily (final text, no tool_calls).
        // Wait for next user message or external notify (no polling).
        this.state = "waiting-user";
        this.emit({ type: "turn-end", reason: "natural" });
        const woke = await this.sleepUntilNotified();
        if (!woke) {
          this.state = "done";
          return; // forceStop or abort during sleep
        }
        continue;
      }

      // 7. Iteration budget guard.
      if (this.iter >= this.opts.iterationBudget) {
        this.state = "done";
        this.emit({
          type: "turn-end",
          reason: `budget-exhausted(${this.iter}/${this.opts.iterationBudget})`,
        });
        return;
      }

      // 8. Idle gap (interruptible).
      this.state = "sleeping";
      await this.sleepInterruptible(this.opts.iterIdleMs);
    }
    this.state = "done";
  }

  interrupt(): void {
    this.state = "interrupting";
    this.interrupted = true;
    this.currentAbort?.abort();
    this.wake();
  }
  abort(): void {
    this.state = "interrupting";
    this.aborted = true;
    this.currentAbort?.abort();
    this.wake();
  }
  forceStop(): void {
    this.state = "interrupting";
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
