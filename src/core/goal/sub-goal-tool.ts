/**
 * `spawn_sub_goal` tool — synchronous, in-process recursion (v0.3 §15).
 *
 * Lets a goal at depth 0 decompose its objective into a focused side quest:
 * a brand-new {@link Goal} record gets created in the parent's scope, then
 * `runGoalRound` is invoked recursively until the sub-goal reaches a
 * terminal state (mark_done / give_up / exhausted / cancelled) or hits the
 * sub-goal turn cap (default 12). The sub-goal's summary is returned as a
 * tool-result string and fed back into the parent ChatSession via the
 * existing tool-result message-injection path (no special parent-history
 * mutation is required).
 *
 * Design choices
 * --------------
 *
 * 1) **Synchronous, same process.** No subprocess: that's Task 16. Sub-goals
 *    share the parent's `subagentScheduler`, `toolContext`, and process
 *    memory. The parent's `runGoalRound` does NOT return until the sub-goal
 *    finishes — we want the assistant to see the sub-goal's summary in the
 *    same conversation turn that called `spawn_sub_goal`.
 *
 * 2) **Depth limit = 1.** The parent runs at depth 0; sub-goals run at
 *    depth 1. The tool is registered ONLY when `depth === 0`, so a sub-goal
 *    at depth 1 cannot recurse further — its model will see no
 *    `spawn_sub_goal` in its tool list at all. If a misbehaving sub-goal
 *    still emits a `spawn_sub_goal` tool-call (e.g. via a memorised name),
 *    the existing `ChatSession` "unknown tool" branch will return a benign
 *    `error: unknown tool "spawn_sub_goal"` tool-result string. We deliberately
 *    do NOT register a "throw at depth 1" stub — silent omission is safer.
 *
 * 3) **No schema change.** The parent linkage lives in this closure only:
 *    the recursive `runGoalRound` call doesn't need to know who its parent
 *    is, and the on-disk goal record does not gain a `parentGoalId` field.
 *    A future "show goal tree" feature can reconstruct parentage from the
 *    goal-runner audit log (the `tool-call` step records the sub-goal id).
 *
 * 4) **Abort propagation.** The parent's `signal` is forwarded verbatim to
 *    every recursive `runGoalRound` call. Aborting the parent immediately
 *    interrupts whatever round of the sub-goal is in flight; the sub-goal's
 *    round-level abort handling (defined in `runner.ts`) persists partial
 *    progress and returns `aborted: true`. The tool then returns a
 *    "sub-goal aborted" tool-result so the parent's ChatSession sees a
 *    well-formed turn before its own abort propagates upward.
 *
 * 5) **Tool-result size cap.** We cap the formatted return string at
 *    {@link SUB_GOAL_RESULT_CAP} bytes. The cap matches the per-tool
 *    truncation budget used elsewhere in the runner (see `appendStep`'s
 *    4 KB tool-result truncation in `runner.ts`).
 */

import type { ToolSpec, ToolExecuteContext } from "../chat/session.js";
import type { LLMProvider } from "../providers/llm.js";

import { addSubGoalId, createGoal, readGoal } from "./store.js";
import type { Goal } from "./store.js";
import { readGoalTemplate, expandTemplate } from "./templates.js";

/** Inline byte cap on the formatted sub-goal summary returned to the parent. */
export const SUB_GOAL_RESULT_CAP = 4000;

/** Default maximum rounds a single sub-goal may run before we bail. */
export const DEFAULT_SUB_GOAL_MAX_ROUNDS = 12;

/**
 * Inputs the {@link buildSpawnSubGoalTool} factory needs from its parent
 * runner. Captured at registration time and threaded into the recursive
 * `runGoalRound` call.
 *
 * `runRound` is passed in (rather than imported) to avoid a runtime cycle
 * between `runner.ts` and `sub-goal-tool.ts` — the runner imports this
 * module, so this module cannot import the runner.
 */
export interface SpawnSubGoalContext {
  /** Workspace root the parent goal lives under. */
  workspace: string;
  /** Parent goal whose scope + model the sub-goal inherits. */
  parent: Goal;
  /** LLM provider passed to recursive rounds (typically the parent's). */
  llm: LLMProvider;
  /** Tool list available to the sub-goal (same as parent's user-tools). */
  tools: ToolSpec[];
  /** Tool execution context (workspace + scope) forwarded to recursion. */
  toolContext?: ToolExecuteContext;
  /** Base system prompt forwarded to recursion. */
  systemPromptBase?: string;
  /** Parent's abort signal — forwarded verbatim. */
  signal?: AbortSignal;
  /** Maximum rounds a sub-goal can run before we stop driving it. */
  maxSubGoalRounds?: number;
  /**
   * Recursive runner reference. Injected to break the runner.ts ↔
   * sub-goal-tool.ts cycle. Always called with `depth: parentDepth + 1`.
   */
  runRound: (input: SubGoalRunInput) => Promise<SubGoalRunResult>;
}

/** Input to the recursive runner call (mirrors `RunRoundOptions` in runner.ts). */
export interface SubGoalRunInput {
  workspace: string;
  goalId: string;
  userMessage: string;
  llm: LLMProvider;
  tools: ToolSpec[];
  toolContext?: ToolExecuteContext;
  systemPromptBase?: string;
  signal?: AbortSignal;
  /** Forces the recursive call to register zero `spawn_sub_goal` tooling. */
  depth: number;
  /** Threaded through so deep recursion (impossible at depth>=1) reuses cap. */
  maxSubGoalRounds?: number;
}

/** Result shape `runGoalRound` returns. Re-declared to avoid a circular import. */
export interface SubGoalRunResult {
  goal: Goal;
  text: string;
  completed: boolean;
  exhausted: boolean;
  failed: boolean;
  aborted: boolean;
  endReason?: string;
}

/** Truncate a string to `cap` bytes (UTF-8 bytes, conservatively). */
function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + " …[truncated]";
}

/**
 * Build the `spawn_sub_goal` ToolSpec the runner injects at depth 0. The
 * closure holds the parent's runner inputs so the tool can drive a recursive
 * `runGoalRound` loop that survives until the sub-goal terminates.
 */
export function buildSpawnSubGoalTool(ctx: SpawnSubGoalContext): ToolSpec {
  const maxRounds =
    ctx.maxSubGoalRounds && ctx.maxSubGoalRounds > 0
      ? ctx.maxSubGoalRounds
      : DEFAULT_SUB_GOAL_MAX_ROUNDS;

  return {
    name: "spawn_sub_goal",
    description:
      "Run a focused sub-goal to completion synchronously and return its summary. " +
      "Use this to decompose the current objective into a smaller, self-contained piece. " +
      "Optionally pass `template` (e.g. \"awaiter\") to instantiate a built-in or user " +
      "goal-template as the sub-goal's objective, expanded with `vars`. " +
      "The sub-goal cannot spawn its own sub-goal (depth limit = 1).",
    parameters: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          description:
            "Concrete sub-objective the sub-goal must accomplish. Required unless `template` is given.",
        },
        scope: {
          type: "string",
          description:
            "Brief scope/constraint hint for the sub-goal (what it may or may not touch). Optional.",
        },
        template: {
          type: "string",
          description:
            "Name of a goal template (built-in or user) whose expanded body becomes the sub-goal's " +
            "objective. The template may also constrain the sub-goal's tools and budget.",
        },
        vars: {
          type: "object",
          description:
            "Variable values used to expand the chosen `template` (e.g. {\"target\": \"build-job\"}). " +
            "Ignored when `template` is omitted.",
        },
      },
      required: [],
    },
    async execute(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
      const hint = typeof args.scope === "string" ? args.scope.trim() : "";

      // 0) If a template is requested, resolve + expand it. The expanded body
      // becomes the sub-objective, and the template may constrain the
      // sub-goal's tool list / token budget (Layer 3 awaiter role).
      const templateName = typeof args.template === "string" ? args.template.trim() : "";
      let templateTools: ToolSpec[] | null = null;
      let templateBudgetTokens: number | null | undefined;
      let templateBody: string | null = null;
      if (templateName.length > 0) {
        let tpl;
        try {
          tpl = await readGoalTemplate(ctx.workspace, templateName);
        } catch (err: any) {
          return {
            ok: false,
            content: `spawn_sub_goal error: failed to load template "${templateName}" (${String(err?.message ?? err)})`,
          };
        }
        if (!tpl) {
          return {
            ok: false,
            content: `spawn_sub_goal error: template "${templateName}" not found (built-in or user).`,
          };
        }
        const vars: Record<string, string> = {};
        if (args.vars && typeof args.vars === "object") {
          for (const [k, v] of Object.entries(args.vars as Record<string, unknown>)) {
            vars[k] = typeof v === "string" ? v : String(v);
          }
        }
        try {
          templateBody = expandTemplate(tpl, vars);
        } catch (err: any) {
          return {
            ok: false,
            content: `spawn_sub_goal error: ${String(err?.message ?? err)}`,
          };
        }
        if (tpl.allowedTools && tpl.allowedTools.length > 0) {
          const allow = new Set(tpl.allowedTools);
          templateTools = ctx.tools.filter((t) => allow.has(t.name));
        }
        if (typeof tpl.budgetTokens === "number") {
          templateBudgetTokens = tpl.budgetTokens;
        }
      }

      // 1) Validate the assistant's request. We refuse empty objectives —
      // there is nothing the sub-goal could possibly do, and creating a
      // record on disk just to abort it pollutes the goal directory. A
      // template's expanded body counts as the objective.
      const rawObjective = typeof args.objective === "string" ? args.objective.trim() : "";
      const objective = templateBody !== null ? templateBody.trim() : rawObjective;
      if (objective.length === 0) {
        return {
          ok: false,
          content:
            'spawn_sub_goal error: "objective" must be a non-empty string (or pass a non-empty "template"). ' +
            "Provide a concrete sub-objective.",
        };
      }

      // Pre-flight abort check: if the parent is already cancelling, do not
      // create a sub-goal record we'd immediately have to tear down.
      if (ctx.signal?.aborted) {
        return {
          ok: false,
          content: "spawn_sub_goal aborted: parent signal already fired before sub-goal could start.",
        };
      }

      // 2) Create the sub-goal. We inherit the parent's scope and model so
      // the sub-goal lives under the same effort/project (its summary will
      // be appended to the same document.md by the parent runner's
      // finalize-with-summary logic).
      //
      // If the assistant supplied a `scope` hint, we splice it into the
      // objective rather than touching the schema. The hint is purely
      // informational — the assistant only sees it via its own audit log
      // when reviewing the sub-goal.
      const subObjective =
        hint.length > 0 ? `${objective}\n\nScope hint: ${hint}` : objective;

      let subGoal: Goal;
      try {
        subGoal = await createGoal(ctx.workspace, {
          objective: subObjective,
          scope: ctx.parent.scope,
          model: ctx.parent.model,
          // Round budget. We do NOT touch the token budget — the sub-goal
          // shares the same upstream LLM and accounting will roll up via
          // the audit log. The round cap protects against runaway spend.
          budgetRoundsMax: maxRounds,
          budgetTokensMax:
            templateBudgetTokens !== undefined ? templateBudgetTokens : ctx.parent.budget.tokensMax,
          // v0.16 §3: stamp the parent link so the SPA can navigate up
          // from a sub-goal back to the conversation that spawned it.
          parentGoalId: ctx.parent.id,
        });
        // Best-effort: link the new sub-goal into the parent's
        // `subGoalIds` so the parent's audit dump is self-describing.
        // We swallow errors here because the sub-goal record itself
        // already exists; a missed back-link only affects UI affordances.
        try {
          await addSubGoalId(ctx.workspace, ctx.parent.id, subGoal.id);
        } catch {
          /* non-fatal — the sub-goal can still run without back-link. */
        }
      } catch (err: any) {
        return {
          ok: false,
          content: `spawn_sub_goal error: failed to create sub-goal record (${
            String(err?.message ?? err)
          })`,
        };
      }

      // 3) Drive the sub-goal until it terminates. We loop because each
      // call to `runGoalRound` performs exactly ONE LLM round (one
      // `ChatSession.send`). If the sub-goal needs multiple rounds to
      // reach `mark_done` we keep re-entering. The recursive call is at
      // `depth: 1`, which causes runner.ts to omit `spawn_sub_goal` from
      // the inner tool list — our depth limit.
      const initialPrompt = subObjective;
      const continuePrompt =
        "Continue working on the sub-objective above. Call `mark_done(reason)` when you're finished, " +
        "or `give_up(reason)` if you can't make progress.";

      let result: SubGoalRunResult | null = null;
      let rounds = 0;
      let userMessage = initialPrompt;
      let abortedDuringLoop = false;

      while (rounds < maxRounds) {
        try {
          result = await ctx.runRound({
            workspace: ctx.workspace,
            goalId: subGoal.id,
            userMessage,
            llm: ctx.llm,
            tools: templateTools ?? ctx.tools,
            toolContext: ctx.toolContext,
            systemPromptBase: ctx.systemPromptBase,
            signal: ctx.signal,
            depth: 1,
            maxSubGoalRounds: maxRounds,
          });
        } catch (err: any) {
          // Recursive runner threw an unexpected error (not an abort —
          // those return `aborted: true` from runGoalRound). Surface it
          // to the assistant so it can decide whether to retry.
          return {
            ok: false,
            content:
              `Sub-goal ${subGoal.id} crashed: ${String(err?.message ?? err)}\n` +
              "The sub-goal record exists but its outcome is undefined.",
          };
        }

        rounds++;

        // Terminal states: completed / failed / exhausted exit the loop.
        if (result.completed || result.failed || result.exhausted) break;
        if (result.aborted) {
          abortedDuringLoop = true;
          break;
        }
        // After the first round the assistant has the prior turn in its
        // history — switch to the short continuation prompt so we don't
        // waste tokens repeating the objective.
        userMessage = continuePrompt;
      }

      // 4) Format the tool-result string. We intentionally always re-read
      // the sub-goal record from disk because `runGoalRound` updates
      // status + summaryPath via `endGoal` / `finalizeWithSummary` and
      // the in-flight `result.goal` snapshot may be stale by one I/O
      // step (the summary write happens after status flip).
      const fresh = (await readGoal(ctx.workspace, subGoal.id)) ?? subGoal;
      const status = fresh.status;
      const turns = fresh.stats.roundsRun;

      // The summary file is the canonical post-completion narrative
      // (Task 11). When present, prefer it over the in-memory result
      // text so the parent sees the polished version.
      let summaryText = "";
      if (fresh.summaryPath) {
        try {
          // Read inline to avoid a runtime dependency on fs in this
          // module's top-level imports (keeps the module unit-testable
          // with a stubbed `runRound` and no fs touches).
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const abs = path.join(ctx.workspace, fresh.summaryPath);
          const raw = await fs.readFile(abs, "utf-8");
          // Strip the markdown header — we already report status / turns
          // explicitly. Keep just the prose summary.
          const idx = raw.indexOf("\n\n");
          summaryText = idx >= 0 ? raw.slice(idx + 2).trim() : raw.trim();
        } catch {
          // Best-effort: fall back to whatever the runner returned.
          summaryText = result?.text?.trim() ?? "";
        }
      } else {
        // No summary written (e.g. abort, exhausted before mark_done,
        // or summary round failed). Use the end reason if any, otherwise
        // the last round's text.
        summaryText = fresh.endReason?.trim() ?? result?.text?.trim() ?? "";
      }

      // Map internal status → tool-result label. We surface "incomplete"
      // for the turn-cap case so the parent can distinguish "ran out of
      // rounds without finishing" from "failed". Order matters: abort
      // takes priority over status because the goal record's status may
      // still be "active" after a parent-driven abort (we do NOT flip it).
      let label: string;
      if (abortedDuringLoop || ctx.signal?.aborted) {
        label = "aborted";
      } else if (status === "complete") {
        label = "complete";
      } else if (status === "failed") {
        label = "failed";
      } else if (status === "exhausted") {
        label = "incomplete";
      } else if (rounds >= maxRounds) {
        // Active but we hit the local cap: report as incomplete.
        label = "incomplete";
      } else {
        label = status;
      }

      const summaryBody = summaryText.length > 0 ? summaryText : "(no summary produced)";
      const formatted =
        `Sub-goal ${fresh.id} completed (status=${label}, turns=${turns}).\n` +
        `Summary: ${summaryBody}`;

      // Always return ok=true unless we never even started. The label
      // tells the parent what happened; an `ok: false` flag would imply
      // a tool failure, which is misleading for "give_up" or
      // "incomplete" outcomes.
      return {
        ok: label !== "aborted",
        content: truncate(formatted, SUB_GOAL_RESULT_CAP),
      };
    },
  };
}
