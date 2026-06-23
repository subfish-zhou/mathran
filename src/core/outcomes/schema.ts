/**
 * Outcome / self-grade data model (#5).
 *
 * When a goal reaches a terminal state (the assistant calls `mark_done` /
 * `give_up`) the runner fires a background, fire-and-forget LLM round that
 * grades the run against a small rubric and writes an `Outcome` record to
 * `.mathran/cache/outcomes/<goalId>.json`. The next `propose_goal` retrieves
 * similar past outcomes to seed few-shot context.
 *
 * This module owns the canonical shape, the zod parser used to validate the
 * grader's JSON reply, and the redaction pass applied before anything touches
 * disk. (PLAN assumed an existing chat-history redaction helper to reuse;
 * none exists in the kernel today, so a minimal secret scrubber lives here —
 * see {@link redactSecrets}.)
 */

import { z } from "zod";

/** A 1–5 rubric score. */
export type Score = 1 | 2 | 3 | 4 | 5;

/** How the goal ended, mapped from the runner's completion outcome. */
export type OutcomeResolution = "complete" | "abandoned" | "blocked";

export interface OutcomeRubric {
  /** Did the work actually solve the stated objective correctly? */
  correctness: Score;
  /** Did it cover the whole ask, or leave gaps? */
  completeness: Score;
  /** Was the path to done efficient (few wasted rounds / tool calls)? */
  efficiency: Score;
}

/** One graded goal run, persisted to `.mathran/cache/outcomes/<goalId>.json`. */
export interface Outcome {
  /** Originating goal id. */
  goalId: string;
  /** The goal's frozen objective text. */
  goalText: string;
  /** Unix-ms timestamps. */
  startedAt: number;
  endedAt: number;
  resolution: OutcomeResolution;
  rubric: OutcomeRubric;
  /** Mean of the three rubric axes, rounded to 1 decimal. */
  averageScore: number;
  /** Freeform 1–3 paragraph reflection the grader wrote. */
  lessons: string;
  /** LLM-extracted tags, e.g. ["typescript", "refactor", "approval"]. */
  contextTags: string[];
  /** Optional retrieval embedding (unused in the v1 keyword retriever). */
  embedding?: number[];
}

/** Compact index entry mirrored in `.mathran/cache/outcomes/index.json`. */
export interface OutcomeIndexEntry {
  goalId: string;
  goalText: string;
  endedAt: number;
  resolution: OutcomeResolution;
  averageScore: number;
  contextTags: string[];
}

const scoreSchema = z
  .number()
  .int()
  .min(1)
  .max(5)
  .transform((n) => n as Score);

/**
 * Shape the grader LLM is asked to return as JSON. Kept narrow on purpose so
 * a hallucinated extra field doesn't blow up the parse — `.strip()` semantics
 * via `.passthrough()` are NOT used; unknown keys are simply dropped by zod's
 * default object behaviour.
 */
export const rubricReplySchema = z.object({
  rubric: z.object({
    correctness: scoreSchema,
    completeness: scoreSchema,
    efficiency: scoreSchema,
  }),
  lessons: z.string().min(1),
  contextTags: z.array(z.string()).default([]),
});

export type RubricReply = z.infer<typeof rubricReplySchema>;

/** Mean of the three rubric axes, rounded to one decimal place. */
export function computeAverageScore(rubric: OutcomeRubric): number {
  const sum = rubric.correctness + rubric.completeness + rubric.efficiency;
  return Math.round((sum / 3) * 10) / 10;
}

/**
 * Best-effort secret scrubber applied to any free text (lessons, goal text,
 * trace) before it is persisted. Conservative by design — it would rather
 * over-redact a token-shaped string than leak a credential into a cache file
 * that is cheap to share.
 *
 * Patterns covered:
 *   - `sk-...`, `sk-proj-...` OpenAI-style keys
 *   - `ghp_/gho_/ghu_/ghs_/ghr_` GitHub tokens
 *   - `xox[baprs]-...` Slack tokens
 *   - AWS access key ids (`AKIA…`)
 *   - `Bearer <token>` authorization headers
 *   - `key`/`token`/`secret`/`password` = <value> assignments
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  const REDACTED = "[redacted]";

  // Provider / platform token shapes.
  out = out.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED);
  out = out.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED);
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED);
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED);

  // Authorization: Bearer <token>
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-]{12,}/gi, `Bearer ${REDACTED}`);

  // key = value / "token": "value" style assignments.
  out = out.replace(
    /\b(api[_-]?key|secret|password|passwd|token|access[_-]?token)\b(\s*[:=]\s*)("?)([^\s"',]{6,})\3/gi,
    (_m, label: string, sep: string, q: string) => `${label}${sep}${q}${REDACTED}${q}`,
  );

  return out;
}

/** Apply {@link redactSecrets} across every persisted free-text field. */
export function redactOutcome(outcome: Outcome): Outcome {
  return {
    ...outcome,
    goalText: redactSecrets(outcome.goalText),
    lessons: redactSecrets(outcome.lessons),
    contextTags: outcome.contextTags.map((t) => redactSecrets(t)),
  };
}
