/**
 * Goal-mode plan file: parse, edit, format (v0.16 §9 audit #4).
 *
 * Goal mode is the long-form autonomous loop where the assistant works
 * across many rounds toward a fixed objective. Without an upfront plan,
 * the assistant tends to oscillate ("let me try X… that didn't work,
 * let me try Y…") and burn budget on directional pivots. This module
 * gives each goal a persisted, structured plan markdown file that:
 *
 *   1. Is bootstrapped exactly once at the first round of the goal by
 *      running the existing plan-mode runner against the objective.
 *      The result is saved at `.mathran/goals/<id>.plan.md`.
 *
 *   2. Gets injected into every subsequent round's system prompt as a
 *      `# Active plan` fragment, so the model always sees its current
 *      checklist and can decide what step to attack next.
 *
 *   3. Can be edited mid-flight by the `update_plan_item` tool (see
 *      `plan-tool.ts`) — the model flips checklist items between
 *      `- [ ]` and `- [x]` to track its own progress. The next round's
 *      system prompt reflects the new state.
 *
 * Why a file (not just an in-memory string)? So `mathran goal resume`
 * after a process restart still has the plan + completed-item state;
 * so a human can read / hand-edit it in the workspace; and so the
 * audit trail (`.mathran/goals/<id>.json` steps) has a stable artifact
 * to reference.
 *
 * The on-disk format is just the plan body (no JSON wrapper) — same
 * markdown the plan-mode runner produces, so a user can copy-paste it
 * between goals and plans without conversion.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicWriteFile } from "../chat/atomic-write.js";

/** One checklist step parsed out of the plan body. */
export interface PlanStep {
  /** 1-based index across ALL checklist items in document order. */
  index: number;
  /** Status: "todo" = `- [ ]`, "done" = `- [x]`. */
  status: "todo" | "done";
  /** Step text with the leading checkbox marker stripped. */
  text: string;
  /** Zero-based line number in the original body (for atomic re-write). */
  line: number;
}

/** Path on disk for one goal's plan file. */
export function goalPlanFileFor(workspace: string, goalId: string): string {
  return path.join(workspace, ".mathran", "goals", `${goalId}.plan.md`);
}

/** Relative (to workspace) path — what gets stored on `goal.planPath`. */
export function goalPlanRelPath(goalId: string): string {
  return path.join(".mathran", "goals", `${goalId}.plan.md`);
}

/**
 * Read the goal's plan body, or null if no plan file exists yet.
 *
 * Other I/O errors (permission, etc.) propagate so callers don't silently
 * see "no plan" for the wrong reason.
 */
export async function readGoalPlan(
  workspace: string,
  goalId: string,
): Promise<string | null> {
  try {
    return await fs.readFile(goalPlanFileFor(workspace, goalId), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write (or overwrite) the goal's plan body using the atomic-write helper
 * so a crashed process never leaves a half-written plan file on disk.
 * Creates the parent directory as needed.
 */
export async function writeGoalPlan(
  workspace: string,
  goalId: string,
  body: string,
): Promise<void> {
  const file = goalPlanFileFor(workspace, goalId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Normalize: ensure trailing newline so subsequent appends / hand-edits
  // don't end up on the same line as the last bullet.
  const normalized = body.endsWith("\n") ? body : body + "\n";
  await atomicWriteFile(file, normalized);
}

/**
 * Regex for one checklist bullet. Permissive on the leading whitespace so
 * nested bullets (`  - [ ] sub-item`) are recognised, but anchored to the
 * line start so prose like "edit the [ ] in foo" isn't a false positive.
 *
 * Capture groups:
 *   1: leading whitespace + bullet prefix (e.g. `"  - "`)
 *   2: checkbox char (` ` or `x`/`X`)
 *   3: step text
 */
const PLAN_STEP_RE = /^(\s*-\s+)\[([ xX])\]\s?(.*)$/;

/**
 * Parse all checklist items out of a plan body, in document order.
 *
 * Indexing is 1-based and global across the document — the model sees
 * the same numbering whether the plan has a single `## Steps` block or
 * is broken into `## Phase 1` / `## Phase 2` sub-sections per the
 * v0.16 plan schema. We deliberately do NOT scope by section because
 * (a) a stable global index is what the `update_plan_item` tool needs
 * for an unambiguous reference, and (b) we don't want a phase-rename
 * to silently renumber existing items.
 */
export function parsePlanSteps(body: string): PlanStep[] {
  if (!body) return [];
  const lines = body.split("\n");
  const steps: PlanStep[] = [];
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = PLAN_STEP_RE.exec(lines[i] ?? "");
    if (!m) continue;
    idx++;
    const checked = (m[2] ?? " ").toLowerCase() === "x";
    steps.push({
      index: idx,
      status: checked ? "done" : "todo",
      text: (m[3] ?? "").trim(),
      line: i,
    });
  }
  return steps;
}

/**
 * Flip the N-th checklist item to `status`. Returns the rewritten body.
 *
 * Throws when `index` is out of range so the caller (the tool executor)
 * can surface a structured "index out of range" tool-result the model
 * can recover from on its next round.
 *
 * Idempotent: setting an already-done item to "done" returns the body
 * unchanged byte-for-byte (modulo the trailing newline). This matters
 * because a model that re-runs `update_plan_item(3, "done")` after a
 * resume must not get a spurious "I just modified the plan" signal.
 */
export function togglePlanStep(
  body: string,
  index: number,
  status: "todo" | "done",
): string {
  const steps = parsePlanSteps(body);
  if (!Number.isInteger(index) || index < 1 || index > steps.length) {
    throw new RangeError(
      `update_plan_item: index ${index} out of range (1..${steps.length})`,
    );
  }
  const step = steps[index - 1];
  if (!step) {
    // unreachable given the range check above, but TS narrowing wants it
    throw new RangeError(`update_plan_item: index ${index} not found`);
  }
  if (step.status === status) return body;

  const lines = body.split("\n");
  const original = lines[step.line] ?? "";
  const m = PLAN_STEP_RE.exec(original);
  if (!m) {
    // shouldn't happen: parsePlanSteps just matched this line
    throw new Error(
      `update_plan_item: line ${step.line + 1} no longer matches checkbox pattern`,
    );
  }
  const mark = status === "done" ? "x" : " ";
  const prefix = m[1] ?? "";
  const text = m[3] ?? "";
  lines[step.line] = `${prefix}[${mark}] ${text}`.replace(/\s+$/u, "");
  return lines.join("\n");
}

/**
 * Format the plan body as a system-prompt fragment the goal runner
 * splices in before the loop-policy section. Kept here (not in
 * `prompts/index.ts`) because the wording is intentionally
 * goal-runner-specific — it tells the model that the plan is editable
 * via `update_plan_item`, which only the goal runner registers.
 *
 * Empty / whitespace-only plans produce an empty fragment so the
 * runner can skip the splice cleanly.
 */
export function formatPlanFragment(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "";
  return [
    "# Active plan",
    "",
    "You have a working plan for this goal (saved to disk; visible to you every round).",
    "Use it to decide what to work on next. The index is the 1-based global position of",
    "the `- [ ]` bullet in the plan, in document order.",
    "",
    "Update the plan only when the plan itself changes — a new item, a changed",
    "objective, or a known step you cannot complete. Do NOT mark items done one at a",
    "time as you work: it bloats the conversation and wastes tokens. Do the work first,",
    "update the plan in a single pass if its structure changed, and call `mark_done`",
    "once the goal is complete.",
    "",
    trimmed,
  ].join("\n");
}
