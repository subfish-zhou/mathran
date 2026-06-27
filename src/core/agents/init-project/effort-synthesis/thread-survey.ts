/**
 * synthesizeThreadSurvey — produce a narrative survey markdown for a spine
 * thread, via writer + writer-reviewer loop.
 *
 * Background (档 3.11 from dogfood-run-10): each spine thread bundles 2-5 nodes
 * around a methodological story (e.g. "Sieve methods and weakened Goldbach
 * representations"). The old path wrote `Survey of <name>. <description>` and
 * stopped — a 2-sentence scaffold that gave the user nothing beyond what was
 * already on each node. Now we feed thread.description + every node's title /
 * statement / significance through the writer LLM to draft a coherent
 * narrative, then run the same writer-reviewer loop used for node efforts.
 *
 * The output is a plain markdown body (no frontmatter — the caller's
 * `WorkspaceEffortOutput` shape supplies metadata). We deliberately keep this
 * a SINGLE writer LLM call (no outline phase like node-effort synth) because
 * a thread is a much smaller scope — 2-5 nodes — and we want to keep the
 * cost-per-thread low (~$0.05-0.10) rather than $0.30+ per node-effort.
 */

import type { SpineLLM } from "../spine/llm.js";
import type { SpineNode, SpineThread, SpineEra } from "../spine/types.js";
import { reviewLoop, DEFAULT_REVIEW_LOOP_BUDGET, estimateCost as defaultEstimateCost } from "../review-loop/index.js";

export interface ThreadSurveyInput {
  thread: SpineThread;
  threadNodes: SpineNode[];
  era?: SpineEra;
  problemTitle: string;
  /** `<workspace>/projects/<slug>` — used for review-loop logging context. */
  projectDir: string;
}

export interface ThreadSurveyDeps {
  llm: SpineLLM;
  reviewerLlm: SpineLLM;
  writerModel: string;
  reviewerModel: string;
  emitLog?: (m: string) => void;
  estimateCost?: (model: string, tokens: { in: number; out: number }) => number;
}

function buildSurveyPrompt(input: ThreadSurveyInput): string {
  const { thread, threadNodes, era, problemTitle } = input;
  const nodeBlock = threadNodes
    .map((n, i) => {
      const yr = n.year != null ? ` (${n.year})` : "";
      return [
        `${i + 1}. **${n.title}**${yr}`,
        `   - statement: ${n.statement}`,
        `   - significance: ${n.significance}`,
        n.depth ? `   - depth: ${n.depth}` : "",
        n.type ? `   - type: ${n.type}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return [
    `You are writing a SURVEY MARKDOWN for a spine "thread" — a coherent`,
    `methodological story weaving several closely-related results around a`,
    `single technique, barrier, or framing. The target audience is a senior`,
    `researcher entering this area.`,
    ``,
    `PROBLEM: ${problemTitle}`,
    `THREAD: ${thread.name}`,
    `THREAD STATUS: ${thread.status}`,
    `THREAD DESCRIPTION: ${thread.description}`,
    thread.currentFrontier ? `CURRENT FRONTIER: ${thread.currentFrontier}` : "",
    thread.barrier ? `BARRIER: ${thread.barrier}` : "",
    era ? `ERA: ${era.name} (${era.startYear ?? "?"}-${era.endYear ?? "?"}) — ${era.summary}` : "",
    ``,
    `NODES IN THIS THREAD:`,
    nodeBlock || "(no nodes — surface this as 'no resolved results yet')",
    ``,
    `WRITE the survey in markdown. Structure:`,
    `  1. ONE intro paragraph: what unifies these results, what's the central technique / question.`,
    `  2. A short story arc walking through the nodes in order: how each one`,
    `     advances the thread, what it builds on, what it leaves open. Use the`,
    `     statements / significance verbatim where they're already clean.`,
    `  3. ONE closing paragraph: where the thread stands now (frontier),`,
    `     what's blocking the next step (barrier), what kind of result would`,
    `     mark genuine progress.`,
    ``,
    `RULES:`,
    `  - Be HONEST about what you don't know. If the supplied nodes don't show`,
    `    a proof strategy, say so — do NOT invent one.`,
    `  - Do NOT fabricate citations. The only ground truth you have is the`,
    `    nodes above. Refer to results by node title, not by paper id.`,
    `  - Keep total length 400-1200 words. This is a survey, not a textbook chapter.`,
    `  - Output the markdown body ONLY — no frontmatter, no code fence, no preamble.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function synthesizeThreadSurvey(
  input: ThreadSurveyInput,
  deps: ThreadSurveyDeps,
): Promise<string> {
  const emit = deps.emitLog ?? (() => {});
  const prompt = buildSurveyPrompt(input);
  const initial = await deps.llm(prompt, { temperature: 0.3 });
  emit(`[thread-survey] initial draft for "${input.thread.id}": ${initial.length} chars`);

  // Run the same writer-reviewer loop used for node efforts so the survey
  // gets the same quality-gate treatment.
  const result = await reviewLoop(
    {
      artifactKind: "thread-survey",
      artifactTitle: input.thread.name,
      artifactSlug: input.thread.id,
      initialContent: initial.trim(),
      sourcePaperReads: [], // thread surveys cite spine nodes, not raw paper reads
      topic: input.problemTitle,
      audienceHint: `senior researcher in ${input.problemTitle}`,
      writerModel: deps.writerModel,
      reviewerModel: deps.reviewerModel,
    },
    DEFAULT_REVIEW_LOOP_BUDGET,
    {
      writerLlm: deps.llm,
      reviewerLlm: deps.reviewerLlm,
      emitLog: emit,
      estimateCost: deps.estimateCost ?? defaultEstimateCost,
    },
  );

  emit(`[thread-survey] "${input.thread.id}": ${result.finalVerdict} (${result.revisionHistory.length} rev(s), $${result.totalCostUsd.toFixed(3)})`);
  return result.finalContent;
}
