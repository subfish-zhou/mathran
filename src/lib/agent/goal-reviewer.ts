/**
 * P2-5 Periodic Reviewer — independent quality cross-check on autonomous runs.
 *
 * The Goal Supervisor (goal-provider.ts) only judges DONE / NEEDS-USER / CONTINUE
 * using the agent's own self-eval. That can't catch the failure mode where an
 * agent keeps producing turns + tool calls that LOOK productive but are actually
 * drifting off-target or spinning on the same dead-end (a real risk we saw on
 * the 25-min capless run).
 *
 * This reviewer is a DIFFERENT call, with a DIFFERENT prompt, run every K rounds
 * (`reviewerEveryRounds`, default 5) inside the goal-run loop. It judges
 * PROGRESS REALITY only:
 *   real  → agent is making genuine progress on the objective. KEEP GOING.
 *   drift → agent is working on the wrong thing / a subgoal it invented. STOP, ask user.
 *   stuck → agent is spinning, no real movement for several rounds. STOP, ask user.
 *
 * Both drift/stuck stop the run with stopKind='needs_review' (resumable=true so
 * the user can read the reason + decide whether to continue).
 *
 * ✨ fail-OPEN: any LLM failure (timeout, parser error, malformed JSON, network)
 *    returns a `real` verdict. The reviewer is a SAFETY-NET, not a hard gate —
 *    if it breaks, the run must not break with it. Cost / token / round caps
 *    (P0-1) and no_progress backstop are the hard guards.
 *
 * Borrows the fail-OPEN judge model design from Hermes (`hermes_cli/goals.py`),
 * the same source the PLAN points to.
 */

import type OpenAI from "openai";
import { LLMRouter } from "./llm-router";

// ─── Types (exported so callers + tests get the same shape) ─────────────────

/** Three-branch progress verdict (mirrors the parser's output). */
export type ReviewerProgress = "real" | "drift" | "stuck";

export interface ReviewerVerdict {
  /** Reality of the progress over the recent window. */
  progress: ReviewerProgress;
  /** ≤ 80-char human-readable reason (also rendered into needsUserReason). */
  reason: string;
  /** Optional pointer to which message/summary supported the call (prompt asks for it). */
  evidence?: string;
}

/** Compact tool-row shape the loop feeds the reviewer for evidence. */
export interface ReviewerToolRow {
  /** Which round produced the row (so the reviewer can cite "round N"). */
  round?: number;
  toolName?: string | null;
  toolStatus?: string | null;
  /** Short content/displayText snippet — caller is responsible for trimming. */
  content?: string | null;
}

/** Input bundle the reviewer reads. The loop assembles this once per call. */
export interface ReviewerInput {
  /** The user's objective text (raw, untruncated by the caller). */
  objective: string;
  /** Recent milestone summaries, newest-last. Usually 1–3 strings is plenty. */
  recentSummaries: string[];
  /** Recent tool rows from the most recent rounds. Caller bounds the count. */
  recentToolRows: ReviewerToolRow[];
  /** Current round number — surfaces in the prompt for grounding. */
  round: number;
}

/**
 * Conservative fallback used whenever the reviewer call or its parser fails.
 * Deliberately `progress: 'real'` so a broken reviewer can't break the loop —
 * the cost / round / no-progress backstops are the real anti-spin guards.
 */
export const REVIEWER_FAIL_OPEN: ReviewerVerdict = {
  progress: "real",
  reason: "reviewer unavailable",
};

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run one reviewer turn. Returns a `ReviewerVerdict` (NEVER throws — every error
 * path falls back to `REVIEWER_FAIL_OPEN`).
 *
 * The reviewer reuses the same Azure-backed LLMRouter the Goal Supervisor uses
 * (goal-provider.ts), keeping deps + provider health management uniform. The
 * `router` parameter is exposed so unit tests can inject a stub without
 * touching the network.
 */
export async function runReviewer(
  input: ReviewerInput,
  opts?: {
    router?: LLMRouter;
    /** Override max output tokens (default 800 — enough for reasoning + JSON). */
    maxTokens?: number;
    /** Hard timeout per call (default 30s). */
    timeoutMs?: number;
  },
): Promise<ReviewerVerdict> {
  const router = opts?.router ?? new LLMRouter();
  const maxTokens = opts?.maxTokens ?? 800;
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  const prompt = buildReviewerPrompt(input);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "你是一个独立的进度质量评审员。只输出一个 JSON 对象，不要任何额外文字、解释或代码块标记。",
    },
    { role: "user", content: prompt },
  ];

  // We hold the verdict in a try block; ANY failure (router throw, signal abort,
  // stream error, parse failure on empty) ends up at the catch → fail-OPEN.
  let raw = "";
  try {
    // AbortSignal.timeout would be nice but it's not threaded into LLMRouter's
    // chatCompletion right now. We bound via a manual Promise.race instead so
    // a slow provider can't hang the whole goal-run loop on the reviewer.
    const stream = router.chatCompletion({
      messages,
      maxTokens,
      // No tools — verdict-only; reviewer must not call back into the agent.
    });

    const consume = (async () => {
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) raw += delta;
      }
    })();

    await Promise.race([
      consume,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("reviewer timeout")), timeoutMs),
      ),
    ]);
  } catch (err) {
    // We deliberately do NOT differentiate timeout vs. content-filter vs. parse:
    // the loop only needs to know "I can't trust this verdict" → fall through.
    console.warn("[goal-reviewer] LLM call failed, returning fail-OPEN:", err);
    return { ...REVIEWER_FAIL_OPEN };
  }

  return parseReviewerVerdict(raw);
}

// ─── Prompt + parser (exported for unit tests) ──────────────────────────────

/** Trim a string to N chars with a clear elision marker (no surprises). */
function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  const t = s.trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

/**
 * Build the reviewer user prompt. Intentionally compact — the reviewer is run
 * every K rounds, so keeping each call cheap matters.
 *
 * The prompt asks for an `evidence` field that cites a specific summary line
 * or tool row by index, so a drift verdict gets a concrete "because round N
 * called X but you're working on Y" pointer the user can read.
 */
export function buildReviewerPrompt(input: ReviewerInput): string {
  const objective = clip(input.objective, 600) || "(未记录)";

  const summaries =
    input.recentSummaries.length === 0
      ? "(无近期总结)"
      : input.recentSummaries
          .slice(-3) // keep the 3 newest so prompt size is bounded
          .map((s, i) => `[S${i + 1}] ${clip(s, 800)}`)
          .join("\n");

  const tools =
    input.recentToolRows.length === 0
      ? "(无近期工具调用)"
      : input.recentToolRows
          .slice(-20) // last 20 rows is enough to spot loops
          .map((row, i) => {
            const tag = row.toolName ? `🔧 ${row.toolName}` : "(文本轮)";
            const status = row.toolStatus ? ` · ${row.toolStatus}` : "";
            const r = typeof row.round === "number" ? `r${row.round} ` : "";
            return `[T${i + 1}] ${r}${tag}${status} — ${clip(row.content, 200)}`;
          })
          .join("\n");

  return [
    "独立审查一个自主 agent run 是否在【真正推进原定目标】。",
    "",
    "## 原定目标",
    objective,
    "",
    `## 当前轮次：${input.round}`,
    "",
    "## 最近阶段总结（旧→新）",
    summaries,
    "",
    "## 最近几轮的工具调用 / 文本输出（旧→新）",
    tools,
    "",
    "## 评审规则",
    '- progress="real"  → agent 在真正向原定目标推进（哪怕慢，只要方向对、有新产出）。',
    '- progress="drift" → agent 在做【与原定目标不同的子任务】或【自己发明的旁枝】。',
    '- progress="stuck" → agent 反复跳同一个点、反复调同一个工具拿同样结果、或连续几轮无实质产出。',
    "- 只要不能明确论证是 drift / stuck，就默认 real（宁误放不误拦）。",
    "- reason ≤ 80 字，中文，说为什么。",
    "- evidence 要求指出【哪一条 [S…] 总结或 [T…] 工具行】支撑你的判断（例：\"[T7] 重复调用 read_effort 拿同样结果\"）。",
    "",
    "## 输出格式（严格 JSON，不要代码块、不要多余文字）",
    '{"progress": "real" | "drift" | "stuck", "reason": "<≤80字>", "evidence": "<引用 [S…] 或 [T…]>"}',
  ].join("\n");
}

/**
 * Tolerant JSON parser for the reviewer's verdict. Strips code fences, extracts
 * the first {...} block, coerces field types, and falls back to `REVIEWER_FAIL_OPEN`
 * on ANY failure (so a malformed verdict can never escalate to drift/stuck and
 * break a healthy run — the fail-OPEN principle).
 *
 * Mirrors `parseEvalResult` in goal-provider.ts — same fences/extraction logic,
 * different field set.
 */
export function parseReviewerVerdict(raw: string): ReviewerVerdict {
  if (!raw || !raw.trim()) return { ...REVIEWER_FAIL_OPEN };

  let text = raw.trim();
  // Strip ```json … ``` / ``` … ``` fences if present.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { ...REVIEWER_FAIL_OPEN };
  }
  const slice = text.slice(start, end + 1);

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return { ...REVIEWER_FAIL_OPEN };
  }
  if (!obj || typeof obj !== "object") return { ...REVIEWER_FAIL_OPEN };

  // Strict whitelist on progress — anything else collapses to fail-OPEN.
  // Reason: if the model returned an unknown enum value, it didn't follow the
  // contract, so we can't trust the rest of the verdict either. real-by-default
  // keeps the loop running.
  const p = obj.progress;
  const progress: ReviewerProgress | null =
    p === "real" || p === "drift" || p === "stuck" ? p : null;
  if (progress === null) return { ...REVIEWER_FAIL_OPEN };

  const rawReason =
    typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "";
  // Bound reason length so a runaway verdict can't blow needsUserReason size.
  const reason = clip(rawReason, 200) || "(未提供原因)";

  const evidence =
    typeof obj.evidence === "string" && obj.evidence.trim()
      ? clip(obj.evidence.trim(), 200)
      : undefined;

  return { progress, reason, evidence };
}

// ─── Pure decision helper (exported for unit tests) ─────────────────────────

/**
 * Decide whether a verdict should STOP the run. Pure function so the goal-run
 * loop's branching is trivially testable without spinning a real LLM.
 *
 * Returns:
 *   { continue: true }                       → keep looping (real verdicts).
 *   { continue: false, reason: string }      → stop with stopKind='needs_review',
 *                                              caller writes reason into meta.needsUserReason.
 */
export function decideReviewerAction(
  verdict: ReviewerVerdict,
): { continue: true } | { continue: false; reason: string } {
  if (verdict.progress === "real") return { continue: true };
  // drift / stuck → stop, surface the reviewer's reason (+ evidence if present)
  // to the user via needsUserReason.
  const evidenceTail = verdict.evidence ? `；依据：${verdict.evidence}` : "";
  const tag = verdict.progress === "drift" ? "偏离目标" : "原地卷";
  return {
    continue: false,
    reason: `审查员判断：${tag} — ${verdict.reason}${evidenceTail}`,
  };
}
