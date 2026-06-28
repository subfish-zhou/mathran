/**
 * Reading-plan planner (Layer 2 §3 of narrative-ordering-design.md).
 *
 * Two public entry points:
 *   - generateInitialPlan(deps, input): called once, after prior-art discovery,
 *     before the reading loop runs. Empty priorReads.
 *   - reviseReadingPlan(deps, input): called every REPLAN_CADENCE_DEFAULT
 *     reads (or when the loop signals harvest produced new candidates worth
 *     re-evaluating). Carries previousPlan + accumulated priorReads.
 *
 * Both are failure-isolated: a thrown / unparseable / empty plan returns
 * EMPTY_PLAN with planVersion=previousPlan?.planVersion (caller falls back to
 * the priority queue for that tick).
 */

import type { SpineLLM } from "../spine/llm.js";
import { extractSpineJSON, errMsg } from "../spine/llm.js";
import {
  buildPlannerPrompt,
  parseAndValidatePlan,
  type PlannerCandidate,
  type PlannerPriorRead,
} from "./prompts.js";
import {
  EMPTY_PLAN,
  PLAN_EXPECTED_READS_CAP,
  type ReadingPlan,
} from "./types.js";

export interface PlannerDeps {
  llm: SpineLLM;
  emitLog?: (m: string) => void;
}

export interface PlannerInput {
  problemTitle: string;
  problemStatement: string;
  problemTags: string[];
  remainingCandidates: PlannerCandidate[];
  priorReads: PlannerPriorRead[];
  previousPlan?: ReadingPlan;
  replanReason?: string;
}

/** Produce a fresh plan (initial or re-plan). Internal — use the wrappers. */
async function callPlanner(
  deps: PlannerDeps,
  input: PlannerInput,
): Promise<ReadingPlan> {
  const emit = deps.emitLog ?? (() => {});
  const candidateIds = new Set(input.remainingCandidates.map((c) => c.paperId));
  const prevVersion = input.previousPlan?.planVersion ?? 0;
  if (candidateIds.size === 0) {
    emit(`[reading-plan] no candidates available — emitting empty plan (carry v${prevVersion})`);
    return { ...EMPTY_PLAN, planVersion: prevVersion, producedAt: new Date().toISOString() };
  }

  const prompt = buildPlannerPrompt({
    problemTitle: input.problemTitle,
    problemStatement: input.problemStatement,
    problemTags: input.problemTags,
    remainingCandidates: input.remainingCandidates,
    priorReads: input.priorReads,
    previousPlan: input.previousPlan,
    expectedReadsCap: PLAN_EXPECTED_READS_CAP,
    replanReason: input.replanReason,
  });

  let raw: string;
  try {
    // No maxTokens cap — long arc lists can produce 2000+ token JSON and we
    // don't want a silent mid-array truncation (same fix class as the
    // spine/wiki maxTokens drops in dde507e + b338d94).
    raw = await deps.llm(prompt, { temperature: 0.2 });
  } catch (err) {
    emit(`[reading-plan] LLM call failed (${errMsg(err)}) — empty plan, carry v${prevVersion}`);
    return { ...EMPTY_PLAN, planVersion: prevVersion, producedAt: new Date().toISOString() };
  }

  const parsedJson = extractSpineJSON<unknown>(raw);
  const validated = parsedJson ? parseAndValidatePlan(parsedJson, candidateIds, PLAN_EXPECTED_READS_CAP) : null;
  if (!validated) {
    emit(`[reading-plan] plan was unparseable / empty after validation — carry v${prevVersion}`);
    return { ...EMPTY_PLAN, planVersion: prevVersion, producedAt: new Date().toISOString() };
  }

  const next: ReadingPlan = {
    narrativeArcs: validated.arcs,
    expectedTotalReads: validated.expectedTotalReads,
    openQuestions: validated.openQuestions,
    planVersion: prevVersion + 1,
    producedAt: new Date().toISOString(),
  };
  emit(`[reading-plan] v${next.planVersion}: ${next.narrativeArcs.length} arc(s), ${next.expectedTotalReads} expected reads`);
  return next;
}

export function generateInitialPlan(
  deps: PlannerDeps,
  input: Omit<PlannerInput, "priorReads" | "previousPlan" | "replanReason">,
): Promise<ReadingPlan> {
  return callPlanner(deps, { ...input, priorReads: [], previousPlan: undefined });
}

export function reviseReadingPlan(
  deps: PlannerDeps,
  input: PlannerInput,
): Promise<ReadingPlan> {
  return callPlanner(deps, input);
}

/**
 * Get the next paperId the plan wants read, given the set of already-read
 * paperIds. Returns null when the plan is exhausted (every step's paperId
 * is in alreadyRead) or empty. Arcs are walked in order; within an arc,
 * steps are walked in order.
 */
export function nextPlannedPaperId(
  plan: ReadingPlan,
  alreadyRead: Set<string>,
): string | null {
  for (const arc of plan.narrativeArcs) {
    for (const step of arc.steps) {
      if (!alreadyRead.has(step.paperId)) {
        return step.paperId;
      }
    }
  }
  return null;
}

/** True when every plan step's paperId is in alreadyRead (or the plan is empty). */
export function isPlanExhausted(plan: ReadingPlan, alreadyRead: Set<string>): boolean {
  return nextPlannedPaperId(plan, alreadyRead) === null;
}
