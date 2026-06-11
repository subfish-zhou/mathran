/**
 * Goal Supervisor — GoalProvider interface + SimpleGoalProvider.
 *
 * Powers the executor "completion gate" (executor.ts): instead of breaking the
 * loop the moment the LLM emits a text-only turn (no tool calls), the executor
 * asks the active GoalProvider whether the user's objective is actually DONE,
 * needs a user decision, or should keep going.
 *
 * Extensibility (per SPEC):
 *  - NOW: `SimpleGoalProvider` — a free-text objective + todos, self-evaluated
 *    by the SAME model the executor already uses (no extra small model).
 *  - FUTURE: `RcgGoalProvider` — getActiveObjective = query the RCG frontier
 *    node; evaluate = call `rcg audit` (0/1/2); recordProgress = add_node /
 *    promote. The executor swaps providers with ZERO code change.
 */

import type OpenAI from "openai";
import { LLMRouter } from "./llm-router";
import type { AssistantGoalConfig } from "./goal-config";

// ─── Core types (SPEC §架构 > GoalProvider 接口) ──────────────────────────────

export interface Objective {
  id: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface GoalEvalResult {
  /** The objective is genuinely complete. */
  done: boolean;
  /** Progress is blocked on something only the user can decide. */
  needsUser: boolean;
  /** Short hint about what is still missing / what to do next (when !done). */
  nextHint?: string;
  /** Human-readable rationale (shown to the user when needsUser). */
  reason?: string;
}

/**
 * Context handed to `getActiveObjective`. Kept intentionally loose so future
 * providers (e.g. RcgGoalProvider) can read whatever they need without forcing
 * the executor to know about it.
 */
export interface GoalContext {
  /** The original user request text, if the executor can supply it. */
  userText?: string;
  /** Conversation / project identifiers for providers that need them. */
  conversationId?: string;
  projectId?: string;
  /** Resolved goal config (autonomyLevel etc.). */
  config?: AssistantGoalConfig;
  /** Arbitrary extra context for future providers. */
  meta?: Record<string, unknown>;
}

export interface GoalProvider {
  /** Resolve the currently-active objective, or null if there isn't one. */
  getActiveObjective(ctx: GoalContext): Promise<Objective | null>;
  /**
   * Decide whether `objective` is done / needs the user / should continue,
   * given the current todos and the LLM's most recent output.
   */
  evaluate(
    objective: Objective,
    todos: unknown,
    lastOutput: string,
  ): Promise<GoalEvalResult>;
  /** Persist progress (no-op for SimpleGoalProvider; RCG add_node/promote later). */
  recordProgress(objective: Objective, result: GoalEvalResult): Promise<void>;
}

// ─── SimpleGoalProvider ───────────────────────────────────────────────────────

/**
 * Conservative fallback used whenever the model self-eval can't be parsed.
 * Deliberately `{done:false, needsUser:false}` so the loop keeps going — the
 * executor's existing no-progress detector (byte-level repeat) is the real
 * anti-spin guard, and maxRounds/maxTokens are the hard fallbacks.
 */
export const SAFE_FALLBACK_EVAL: GoalEvalResult = {
  done: false,
  needsUser: false,
  nextHint: "继续推进",
  reason: "自评结果解析失败，保守续跑（依赖 no_progress / maxRounds 兜底）。",
};

export class SimpleGoalProvider implements GoalProvider {
  private readonly router: LLMRouter;
  private readonly autonomyLevel: AssistantGoalConfig["autonomyLevel"];

  constructor(opts?: {
    router?: LLMRouter;
    autonomyLevel?: AssistantGoalConfig["autonomyLevel"];
  }) {
    this.router = opts?.router ?? new LLMRouter();
    this.autonomyLevel = opts?.autonomyLevel ?? "aggressive";
  }

  async getActiveObjective(ctx: GoalContext): Promise<Objective | null> {
    // The simple provider's objective is the user's original request text. If
    // there's no usable text, there's no objective to supervise → null (the
    // gate then falls back to the original break).
    const text = ctx.userText?.trim();
    if (!text) return null;
    return {
      id: ctx.conversationId ?? "objective",
      text,
      meta: { projectId: ctx.projectId },
    };
  }

  /**
   * Same-model self-evaluation. Builds a small prompt (objective + todos +
   * last LLM output), asks for a strict JSON verdict, and parses it with a
   * conservative fallback.
   */
  async evaluate(
    objective: Objective,
    todos: unknown,
    lastOutput: string,
  ): Promise<GoalEvalResult> {
    const prompt = buildEvalPrompt(objective, todos, lastOutput, this.autonomyLevel);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content:
          "你是一个目标完成性评审器。只输出一个 JSON 对象，不要任何额外文字、解释或代码块标记。",
      },
      { role: "user", content: prompt },
    ];

    let raw = "";
    try {
      const stream = this.router.chatCompletion({
        messages,
        maxTokens: 512,
        // No tools — we only want a JSON verdict.
      });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) raw += delta;
      }
    } catch (err) {
      console.warn("[goal-provider] evaluate LLM call failed:", err);
      return { ...SAFE_FALLBACK_EVAL };
    }

    return parseEvalResult(raw);
  }

  /**
   * SimpleGoalProvider keeps no durable state — progress is reflected directly
   * in the conversation. FUTURE: RcgGoalProvider overrides this to add_node /
   * promote a node in the research-context graph.
   */
  async recordProgress(
    objective: Objective,
    result: GoalEvalResult,
  ): Promise<void> {
    // no-op (intentional). See class docstring + SPEC for the RCG extension.
    void objective;
    void result;
  }
}

// ─── Prompt + parsing helpers (exported for unit testing) ─────────────────────

/** autonomyLevel → wording that tunes how eagerly the model sets needsUser. */
export function autonomyClause(
  level: AssistantGoalConfig["autonomyLevel"],
): string {
  switch (level) {
    case "aggressive":
      return (
        "自主程度=激进：尽量自己扛，能自行决定/推断/查证的就别打断用户。" +
        "只有在【真正无法自决】（缺少只有用户能提供的关键信息、需要用户授权高风险操作、" +
        "或目标本身有歧义且无法合理假设）时才把 needsUser 设为 true。"
      );
    case "conservative":
      return (
        "自主程度=保守：遇到任何不确定、可能有多种合理走向、或涉及外部副作用时，" +
        "倾向于把 needsUser 设为 true，先征求用户意见再继续。"
      );
    case "balanced":
    default:
      return (
        "自主程度=平衡：常规推进自己扛；遇到明显需要用户取舍的关键岔路口时，" +
        "把 needsUser 设为 true。"
      );
  }
}

export function buildEvalPrompt(
  objective: Objective,
  todos: unknown,
  lastOutput: string,
  autonomyLevel: AssistantGoalConfig["autonomyLevel"],
): string {
  let todosStr: string;
  try {
    todosStr =
      todos == null
        ? "(无 todos)"
        : typeof todos === "string"
          ? todos
          : JSON.stringify(todos, null, 2);
  } catch {
    todosStr = "(todos 无法序列化)";
  }
  // Keep the last output bounded so the eval prompt itself stays cheap.
  const boundedOutput =
    lastOutput.length > 4000
      ? lastOutput.slice(0, 2000) + "\n…(截断)…\n" + lastOutput.slice(-1500)
      : lastOutput;

  return [
    "判断下面这个目标是否【真正达成】。",
    "",
    "## 目标",
    objective.text,
    "",
    "## 当前 todos 列表",
    todosStr,
    "",
    "## 助手最近一轮输出",
    boundedOutput || "(空)",
    "",
    "## 评审规则",
    autonomyClause(autonomyLevel),
    "- done=true 仅当目标的所有要求都已实际完成（不是『打算做』或『部分做了』）。",
    "- 若未达成且能自己继续，done=false 且 needsUser=false，并在 nextHint 写下一步该做什么（缺什么）。",
    "- needsUser=true 时，在 reason 里用一句话说明为什么必须问用户。",
    "",
    "## 输出格式（严格 JSON，不要代码块、不要多余文字）",
    '{"done": boolean, "needsUser": boolean, "nextHint": string, "reason": string}',
  ].join("\n");
}

/**
 * Tolerant JSON parser for the model's verdict. Strips code fences, extracts
 * the first {...} block, coerces field types, and falls back conservatively on
 * any failure (so a bad verdict can never break the loop — no_progress /
 * maxRounds are the hard backstops).
 */
export function parseEvalResult(raw: string): GoalEvalResult {
  if (!raw || !raw.trim()) return { ...SAFE_FALLBACK_EVAL };

  let text = raw.trim();
  // Strip ```json … ``` / ``` … ``` fences if present.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Extract the first balanced-ish JSON object.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { ...SAFE_FALLBACK_EVAL };
  }
  const slice = text.slice(start, end + 1);

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return { ...SAFE_FALLBACK_EVAL };
  }
  if (!obj || typeof obj !== "object") return { ...SAFE_FALLBACK_EVAL };

  const done = obj.done === true;
  const needsUser = obj.needsUser === true;
  const nextHint =
    typeof obj.nextHint === "string" && obj.nextHint.trim()
      ? obj.nextHint.trim()
      : undefined;
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : undefined;

  return { done, needsUser, nextHint, reason };
}

// ─── Gate decision (pure, unit-testable) ──────────────────────────────────────

export type GateAction =
  | "done"
  | "needsUser"
  | "continue"
  | "budgetLimited"
  | "blocked";

/**
 * Pure decision function for the executor gate. Given a self-eval result and
 * the goal config, returns one of three actions. Extracted from the executor
 * so the three-branch logic is trivially testable.
 *
 * NOTE: when `config.enabled === false` the executor must NOT call this — it
 * preserves the original `break` behavior. This function therefore assumes the
 * gate is already enabled (it still returns "done" if asked, as a safe default).
 *
 * [commit-5c] Optionally consults a token-budget snapshot to short-circuit to
 * "budgetLimited" before the LLM eval runs: once tokensUsed exceeds
 * tokenBudget the loop stops and next turn loads budget_limit.md. The
 * budgetCheck arg is optional so existing callers see unchanged behavior.
 */
export function decideGateAction(
  evalResult: GoalEvalResult,
  config: Pick<AssistantGoalConfig, "enabled">,
  budgetCheck?: { tokensUsed: number; tokenBudget: number | null | undefined },
): GateAction {
  // Defensive: disabled gate always terminates (executor short-circuits before
  // ever reaching here, but keep the invariant explicit).
  if (!config.enabled) return "done";
  if (
    budgetCheck &&
    typeof budgetCheck.tokenBudget === "number" &&
    budgetCheck.tokenBudget > 0 &&
    budgetCheck.tokensUsed >= budgetCheck.tokenBudget
  ) {
    return "budgetLimited";
  }
  if (evalResult.done) return "done";
  if (evalResult.needsUser) return "needsUser";
  return "continue";
}
