/**
 * Reading-plan prompts (Layer 2 §3 of narrative-ordering-design.md).
 *
 * The planner is called twice per init run:
 *   (a) initial plan — after prior-art discovery, before any reads.
 *       Candidate set: seeds + canon (DOI-resolved + arxiv-resolved subset).
 *       The plan dictates the INITIAL reading order.
 *   (b) re-plan — every REPLAN_CADENCE_DEFAULT reads OR when harvest produces
 *       3+ new candidates the planner judges relevant. Candidate set: any
 *       NOT-YET-READ paper currently in the queue OR recently harvested. The
 *       plan dictates the REMAINING reading order.
 *
 * Both use the same prompt shape but with different `priorReads` and
 * `remainingCandidates` fields. The output JSON shape is the same as
 * `ReadingPlan` minus `planVersion` / `producedAt` (set by the caller).
 */

import type { NarrativeArc, ReadingPlan } from "./types.js";

/** One candidate visible to the planner. */
export interface PlannerCandidate {
  paperId: string;
  title: string;
  authors: string[];
  year?: number;
  isSurvey: boolean;
  /** One-line "why this is canon" or "why this was harvested". */
  whyOnQueue: string;
  /** Priority band the queue would use without the plan. */
  priorityBand: "seed" | "canon" | "survey" | "harvest";
}

/** Summary of an already-completed read, for the re-plan call. */
export interface PlannerPriorRead {
  paperId: string;
  title: string;
  year?: number;
  firstAuthor: string;
  oneLineSummary: string;
  mainContribution: string;
}

export interface BuildPlannerPromptInput {
  problemTitle: string;
  problemStatement: string;
  problemTags: string[];
  /** All not-yet-read candidates the planner can sequence. */
  remainingCandidates: PlannerCandidate[];
  /** Empty for the initial plan; populated for re-plans. */
  priorReads: PlannerPriorRead[];
  /** The plan that was in force before this call (empty on initial). */
  previousPlan?: ReadingPlan;
  /** Hard cap on expectedTotalReads (passed through from caller). */
  expectedReadsCap: number;
  /**
   * Re-plan cue from caller: what changed since the last plan that prompted
   * this re-plan. Examples: "3 surveys harvested", "circuit_breaker tripped",
   * "completed arc 1". Informational only.
   */
  replanReason?: string;
}

export function buildPlannerPrompt(input: BuildPlannerPromptInput): string {
  const {
    problemTitle, problemStatement, problemTags,
    remainingCandidates, priorReads,
    previousPlan, expectedReadsCap, replanReason,
  } = input;
  const isInitial = priorReads.length === 0 && (!previousPlan || previousPlan.planVersion === 0);

  const candidateLines = remainingCandidates.map((c, i) => {
    const yr = c.year != null ? c.year : "?";
    const surveyTag = c.isSurvey ? " [SURVEY]" : "";
    const auth = c.authors[0] ?? "(unknown)";
    return `  ${i + 1}. [${yr}] ${auth}${surveyTag}, "${c.title.slice(0, 100)}"\n     paperId: ${c.paperId}\n     band: ${c.priorityBand}, why-on-queue: ${c.whyOnQueue.slice(0, 200)}`;
  }).join("\n");

  const priorReadsBlock = priorReads.length > 0
    ? [
        `READS COMPLETED SO FAR (chronological — already in your understanding):`,
        ...priorReads
          .slice()
          .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
          .slice(-12)
          .map((r) => {
            const yr = r.year ?? "?";
            const summary = (r.mainContribution || r.oneLineSummary).slice(0, 180).replace(/\s+/g, " ");
            return `  - [${yr}] ${r.firstAuthor}, "${r.title.slice(0, 80)}": ${summary}`;
          }),
        ``,
      ].join("\n")
    : "";

  const previousPlanBlock = previousPlan && previousPlan.planVersion > 0
    ? [
        `PREVIOUS PLAN (v${previousPlan.planVersion}, ${previousPlan.narrativeArcs.length} arc(s)):`,
        ...previousPlan.narrativeArcs.flatMap((arc) => [
          `  Arc: ${arc.name} — ${arc.rationale.slice(0, 120)}`,
          ...arc.steps.map((s) => `    • ${s.paperId} — ${s.purpose.slice(0, 100)}`),
        ]),
        ``,
        `You may KEEP, REVISE, or REPLACE this plan. Reflect on what the new`,
        `reads have changed about your understanding of the field.`,
        ``,
      ].join("\n")
    : "";

  return [
    `You are planning the READING ORDER for an init-agent doing literature`,
    `review on the following research problem. The agent has limited time and`,
    `must read papers in a sequence that builds methodological lineage —`,
    `earlier results inform how later results are framed, not the other way`,
    `round.`,
    ``,
    `PROBLEM: ${problemTitle}`,
    `STATEMENT: ${problemStatement.slice(0, 800)}`,
    problemTags.length > 0 ? `TAGS: ${problemTags.join(", ")}` : "",
    ``,
    replanReason ? `RE-PLAN REASON: ${replanReason}` : "",
    ``,
    priorReadsBlock,
    previousPlanBlock,
    `CANDIDATES AVAILABLE (sequence a subset, not all):`,
    candidateLines || "  (none — emit an empty plan)",
    ``,
    `OUTPUT a JSON object matching EXACTLY this shape:`,
    `{`,
    `  "narrativeArcs": [`,
    `    {`,
    `      "name": "Verb-shaped arc name (e.g. 'Trace the combinatorial sieve lineage from Brun to Chen')",`,
    `      "rationale": "1-2 sentences: what reading this arc earns the agent.",`,
    `      "steps": [`,
    `        { "paperId": "EXACTLY one of the paperIds above", "purpose": "Why THIS paper at THIS point — what it adds to the agent's prior understanding (1-2 sentences)." }`,
    `      ]`,
    `    }`,
    `  ],`,
    `  "expectedTotalReads": <integer; total step count across arcs; cap at ${expectedReadsCap}>,`,
    `  "openQuestions": ["1-3 questions this plan is trying to answer"]`,
    `}`,
    ``,
    `RULES:`,
    `  - EVERY paperId in steps MUST be one of the candidate paperIds above.`,
    `    Do NOT invent paperIds.`,
    `  - No paperId may appear more than once across all steps (no duplicates).`,
    `  - Arcs are READ IN ORDER (arc 1 before arc 2). Steps within an arc are also`,
    `    read in order. Order matters — order the steps so each one feels like a`,
    `    natural next move given everything before it.`,
    `  - When two papers are roughly equivalent, prefer chronologically EARLIER`,
    `    (a working mathematician reads Brun 1920 BEFORE Chen 1973 to see how the`,
    `    sieve lineage actually evolved).`,
    `  - SURVEYS ([SURVEY] tag) generally come first within their arc: they let`,
    `    later technical reads inherit the survey's framing.`,
    `  - It is OK to leave some candidates UNPLANNED. The reading-loop will fall`,
    `    back to its priority queue for anything you don't sequence.`,
    `  - It is OK to plan FEWER reads than candidates available. 2-3 strong arcs`,
    `    of 4-7 reads each beats 1 huge arc.`,
    isInitial
      ? `  - This is the INITIAL plan. You have NO prior reads — plan from cold start.`
      : `  - This is a RE-PLAN. Reflect on what the prior reads have changed and`,
    isInitial
      ? ""
      : `    revise the arcs accordingly. If the prior plan was wrong about something,`,
    isInitial
      ? ""
      : `    explicitly REPLACE that arc rather than carry it forward.`,
    ``,
    `Output ONLY valid JSON, no preamble.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Parse + validate the LLM's plan output. Returns null on any parse failure
 * (caller decides whether to fall back or retry). Validation rules:
 *   - All paperIds must be in the candidate set (drop unknowns).
 *   - No paperId may appear twice (dedupe globally; keep first occurrence).
 *   - At least one arc with at least one step (else null).
 *   - Cap expectedTotalReads.
 */
export function parseAndValidatePlan(
  raw: unknown,
  candidateIds: Set<string>,
  expectedReadsCap: number,
): { arcs: NarrativeArc[]; expectedTotalReads: number; openQuestions: string[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const arcsRaw = Array.isArray(r.narrativeArcs) ? r.narrativeArcs : null;
  if (!arcsRaw) return null;

  const seenPaperIds = new Set<string>();
  const arcs: NarrativeArc[] = [];
  for (const a of arcsRaw) {
    if (!a || typeof a !== "object") continue;
    const ar = a as Record<string, unknown>;
    const name = typeof ar.name === "string" ? ar.name.trim() : "";
    const rationale = typeof ar.rationale === "string" ? ar.rationale.trim() : "";
    const stepsRaw = Array.isArray(ar.steps) ? ar.steps : [];
    const steps: Array<{ paperId: string; purpose: string }> = [];
    for (const s of stepsRaw) {
      if (!s || typeof s !== "object") continue;
      const sr = s as Record<string, unknown>;
      const pid = typeof sr.paperId === "string" ? sr.paperId.trim() : "";
      const purpose = typeof sr.purpose === "string" ? sr.purpose.trim() : "";
      if (!pid || !candidateIds.has(pid)) continue;
      if (seenPaperIds.has(pid)) continue;
      seenPaperIds.add(pid);
      steps.push({ paperId: pid, purpose: purpose || "(no purpose given)" });
    }
    if (name && steps.length > 0) arcs.push({ name, rationale, steps });
  }
  if (arcs.length === 0) return null;

  const expectedTotalReads = Math.min(
    typeof r.expectedTotalReads === "number" && Number.isFinite(r.expectedTotalReads)
      ? Math.floor(r.expectedTotalReads)
      : seenPaperIds.size,
    expectedReadsCap,
  );

  const openQuestions = Array.isArray(r.openQuestions)
    ? r.openQuestions.filter((q): q is string => typeof q === "string").slice(0, 5)
    : [];

  return { arcs, expectedTotalReads, openQuestions };
}
