/**
 * Layer 2 — mark_done content review hook. Ported in spirit from
 * claude-code's TaskCompleted hook (block a `task_update(completed)` when
 * the plan / criteria aren't actually satisfied), adapted to mathran's
 * `mark_done` builtin tool + per-goal `.plan.md` checklist.
 *
 * Source reference:
 *   DESIGN-REFERENCE.md Part 1 §3.3 (CC TaskCompleted hook) + Part 3 §8.
 *
 * Two independent, opt-in modes (both OFF by default for backward compat):
 *
 *   - Mode A "deterministic" (free): scan the goal's `.plan.md` for
 *     unchecked `- [ ]` items. If any remain, reject the mark_done with a
 *     listing — no LLM call, no cost.
 *
 *   - Mode B "llm" (costs $): a cheap reviewer model reads the goal
 *     objective + plan + a summary of the work done and returns a
 *     structured `{accept, reason?, missing?}` verdict.
 *
 * When `mode === "both"` they run in order: A first (free), then B only
 * if A passed (so we never pay for an LLM call the cheap check already
 * rejected). Either rejection blocks the mark_done.
 *
 * This module is a near-pure library: its ONLY I/O is reading the plan
 * file and (in Mode B) calling the injected LLM. All persistence + the
 * conversation-history side effects live in runner.ts. The runner owns
 * the rejection counter (`goal.stats.markDoneReviewRejectionCount`) and
 * the force-accept cap.
 */

import { readGoalPlan } from "./plan.js";
import type { Goal } from "./store.js";
import type { LLMProvider, LLMMessage } from "../providers/llm.js";

/** Review modes, mirrored by the `goal.markDoneReview.mode` layered setting. */
export type MarkDoneReviewMode = "off" | "deterministic" | "llm" | "both";

/** The default reviewer model for Mode B (cheap + fast). */
export const DEFAULT_REVIEWER_MODEL = "gpt-4o-mini";

/**
 * After this many rejections, the runner force-accepts the next mark_done
 * (and emits a warning) to break a potential nudge loop. The runner
 * applies the cap; it is exported here so callers + tests agree on the
 * threshold.
 */
export const MARK_DONE_REJECT_CAP = 3;

/** Outcome of a single review pass. */
export interface MarkDoneReviewResult {
  accept: boolean;
  /** Model-facing error explaining why the mark_done was blocked. */
  blockingError?: string;
  /** Concrete next steps surfaced to the model as a `hint`. */
  suggestedNextSteps?: string[];
}

export interface MarkDoneReviewOptions {
  workspace: string;
  goal: Goal;
  /** Which check(s) to run. `"off"` short-circuits to accept. */
  mode: MarkDoneReviewMode;
  /**
   * Conversation history of the run so far. Used to build the work
   * summary for the Mode B reviewer prompt. Optional — Mode A ignores it,
   * and Mode B degrades to "(no conversation captured)" when absent.
   */
  conversation?: LLMMessage[];
  /**
   * Reviewer model id for Mode B. Defaults to {@link DEFAULT_REVIEWER_MODEL}.
   */
  reviewerModel?: string;
  /**
   * LLM provider for Mode B. REQUIRED for `"llm"` / `"both"`; when absent,
   * the LLM pass is skipped (treated as accept) so a misconfigured caller
   * can never wedge a goal. Mode A never needs it.
   */
  llm?: LLMProvider;
}

/** Verdict shape the Mode B reviewer model is asked to emit. */
interface LlmReviewVerdict {
  accept: boolean;
  reason?: string;
  missing?: string[];
}

/**
 * Run the configured review pass(es). Returns `{accept:true}` when the
 * mark_done should be honoured, or `{accept:false, blockingError, ...}`
 * when it should be blocked and the model nudged to keep working.
 *
 * Never throws: any unexpected error (plan read, LLM, JSON parse) is
 * swallowed and treated as accept, so the review hook can only ever ADD a
 * gate, never break an otherwise-valid completion.
 */
export async function reviewMarkDone(
  opts: MarkDoneReviewOptions,
): Promise<MarkDoneReviewResult> {
  const { mode } = opts;
  if (mode === "off") return { accept: true };

  // Force-accept cap (DESIGN-REFERENCE.md §8.4): once the goal has already
  // been rejected MARK_DONE_REJECT_CAP times, honour the next mark_done to
  // break a potential nudge loop. The runner owns the counter (it increments
  // on each rejection); we only READ it here.
  if ((opts.goal.stats.markDoneReviewRejectionCount ?? 0) >= MARK_DONE_REJECT_CAP) {
    return { accept: true };
  }

  // Mode A — deterministic, free. Runs for "deterministic" and "both".
  if (mode === "deterministic" || mode === "both") {
    const a = await reviewDeterministic(opts.workspace, opts.goal);
    if (!a.accept) return a;
  }

  // Mode B — LLM reviewer, costs $. Runs for "llm" and "both" (only after
  // A passed, so we never pay for a check the free pass already rejected).
  if (mode === "llm" || mode === "both") {
    const b = await reviewWithLlm(opts);
    if (!b.accept) return b;
  }

  return { accept: true };
}

/**
 * Mode A — scan the goal's `.plan.md` for unchecked `- [ ]` items.
 *
 * No plan file (or an empty one) → accept: a goal can legitimately have no
 * checklist, and we must not block those. Any unchecked items → reject
 * with a short listing so the model knows exactly what's left.
 */
export async function reviewDeterministic(
  workspace: string,
  goal: Goal,
): Promise<MarkDoneReviewResult> {
  let planText: string;
  try {
    planText = (await readGoalPlan(workspace, goal.id)) ?? "";
  } catch {
    // Treat an unreadable plan as "no plan" — never block on an I/O error.
    return { accept: true };
  }

  const uncheckedLines = planText
    .split(/\r?\n/)
    .filter((line) => /^\s*- \[ \]/.test(line))
    .map((line) => line.replace(/^\s*- \[ \]\s*/, "").trim())
    .filter((t) => t.length > 0);

  if (uncheckedLines.length === 0) return { accept: true };

  const listing = uncheckedLines.map((t) => `  - ${t}`).join("\n");
  return {
    accept: false,
    blockingError:
      `Plan has ${uncheckedLines.length} unchecked item(s) remaining. ` +
      `Address them, or update the plan (flip them to \`- [x]\`) if they ` +
      `are no longer relevant, before calling mark_done again:\n${listing}`,
    suggestedNextSteps: uncheckedLines.slice(0, 5),
  };
}

/**
 * Mode B — ask a cheap reviewer model whether the work genuinely satisfies
 * the objective + plan. Skips (accepts) when no LLM was injected.
 */
export async function reviewWithLlm(
  opts: MarkDoneReviewOptions,
): Promise<MarkDoneReviewResult> {
  const { goal, llm } = opts;
  if (!llm) return { accept: true };

  let planText = "";
  try {
    planText = (await readGoalPlan(opts.workspace, goal.id)) ?? "";
  } catch {
    planText = "";
  }

  const summary = summarizeConversation(opts.conversation ?? []);
  const reviewerModel = opts.reviewerModel ?? DEFAULT_REVIEWER_MODEL;

  const messages: LLMMessage[] = [
    {
      role: "system",
      content:
        "You are a strict project reviewer. Decide whether a goal's work " +
        "genuinely satisfies its objective and plan. Respond with ONLY a " +
        'JSON object of shape {"accept": boolean, "reason"?: string, ' +
        '"missing"?: string[]}. No prose outside the JSON.',
    },
    {
      role: "user",
      content: buildReviewPrompt(goal.objective, planText, summary),
    },
  ];

  let raw: string;
  try {
    raw = await collectText(llm, messages, reviewerModel);
  } catch {
    // A failed reviewer call must never block a completion.
    return { accept: true };
  }

  const verdict = parseVerdict(raw);
  if (!verdict || verdict.accept) return { accept: true };

  const missing = (verdict.missing ?? []).filter(
    (m) => typeof m === "string" && m.trim().length > 0,
  );
  const reason = (verdict.reason ?? "").trim();
  const parts: string[] = [
    "Reviewer rejected mark_done: the work does not yet satisfy the objective/plan.",
  ];
  if (reason) parts.push(reason);
  if (missing.length > 0) {
    parts.push(
      "Outstanding items:\n" + missing.map((m) => `  - ${m}`).join("\n"),
    );
  }
  return {
    accept: false,
    blockingError: parts.join("\n"),
    suggestedNextSteps: missing.slice(0, 5),
  };
}

function buildReviewPrompt(
  objective: string,
  planText: string,
  summary: string,
): string {
  return [
    "Below is a goal's objective, plan, and a summary of the work done.",
    "",
    `Objective: ${objective}`,
    "",
    "Plan:",
    planText.trim() || "(no plan file)",
    "",
    "Summary of work:",
    summary || "(no conversation captured)",
    "",
    "If the work genuinely satisfies the objective and plan, accept=true.",
    "If any plan item is unaddressed or the objective is only partially met,",
    "accept=false with specific 'missing' items.",
    "Be strict — false negatives (rejecting complete work) cost a few extra",
    "rounds; false positives (accepting incomplete work) waste user time later.",
  ].join("\n");
}

/**
 * Cheap, deterministic conversation summary for the reviewer prompt — the
 * tail of the most recent user/assistant text, capped to ~1500 chars. We
 * keep the TAIL because the end of a run is the most diagnostic part.
 */
export function summarizeConversation(
  conversation: LLMMessage[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 1500;
  const lines: string[] = [];
  for (const m of conversation) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = contentToText(m.content).trim();
    if (!text) continue;
    lines.push(`${m.role.toUpperCase()}: ${truncate(text, 600)}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;
  return "…(summary truncated)…\n" + joined.slice(joined.length - maxChars);
}

function contentToText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
    .join(" ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/** Drain a streaming completion to a single string. */
async function collectText(
  llm: LLMProvider,
  messages: LLMMessage[],
  model: string,
): Promise<string> {
  const response = await llm.chat({ messages, model });
  let buf = "";
  for await (const chunk of response.stream()) {
    if (chunk.type === "text") buf += chunk.delta;
  }
  return buf;
}

/**
 * Best-effort JSON extraction. The reviewer model may wrap the object in
 * markdown fences or stray prose; we pull the first balanced `{...}` block
 * and parse it. Returns null when nothing parseable is found.
 */
export function parseVerdict(raw: string): LlmReviewVerdict | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.accept !== "boolean") return null;
  const verdict: LlmReviewVerdict = { accept: o.accept };
  if (typeof o.reason === "string") verdict.reason = o.reason;
  if (Array.isArray(o.missing)) {
    verdict.missing = o.missing.filter((x): x is string => typeof x === "string");
  }
  return verdict;
}
