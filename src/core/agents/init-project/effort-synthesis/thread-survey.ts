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
import type { PaperRead } from "../../../paper-graph/types.js";
import { reviewLoop, DEFAULT_REVIEW_LOOP_BUDGET, estimateCost as defaultEstimateCost } from "../review-loop/index.js";
import { buildPriorReadsBlock } from "../reader/prompts.js";

/**
 * Minimal paper-metadata shape consumed by buildSurveyPrompt's prior-reads
 * adapter. Both PaperNode (paper-graph) and PaperMeta (spine/effort-from-spine
 * internal type) satisfy this structurally, so the caller doesn't have to
 * convert between them.
 */
export interface ThreadSurveyPaperMeta {
  id: string;
  title: string;
  authors: string[];
  year?: number;
}

export interface ThreadSurveyInput {
  thread: SpineThread;
  threadNodes: SpineNode[];
  era?: SpineEra;
  problemTitle: string;
  /** `<workspace>/projects/<slug>` — used for review-loop logging context. */
  projectDir: string;
  /**
   * 5.4 (2026-06-28) — paper-reads + paper-metadata behind the thread's
   * spine nodes, in chronological order. Injected into the survey prompt as
   * the same "prior reads you have already absorbed" block that the reader
   * sees per-paper, so the survey writer can frame the story across the
   * thread's lineage (Brun 1920 → Selberg 1950 → Chen 1973) instead of
   * treating each spine-node as an isolated fact.
   *
   * paperReads / paperNodes are parallel arrays — entry i in paperReads has
   * its metadata (title/authors/year) at entry i in paperNodes. Missing
   * paperNode is tolerated (the entry then falls back to bare paperId).
   */
  paperReads?: PaperRead[];
  paperNodes?: ThreadSurveyPaperMeta[];
}

export interface ThreadSurveyDeps {
  llm: SpineLLM;
  reviewerLlm: SpineLLM;
  writerModel: string;
  reviewerModel: string;
  /** Forwarded to reviewLoop when writer === reviewer; see reviewer.ts. */
  selfReviewMode?: boolean;
  emitLog?: (m: string) => void;
  estimateCost?: (model: string, tokens: { in: number; out: number }) => number;
}

function buildSurveyPrompt(input: ThreadSurveyInput): string {
  const { thread, threadNodes, era, problemTitle, paperReads, paperNodes } = input;
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

  // 5.4: build chronological prior-reads block from the thread's paper-reads,
  // same shape as the reader's lineage block (12-cap, sorted by year). The
  // adapter pulls title/firstAuthor/year from the parallel paperNodes array
  // (PaperReadSkim doesn't carry these). When the paperNodes array is missing
  // we still emit an entry with the bare paperId so structure is preserved.
  const priorReadsBlock = paperReads && paperReads.length > 0
    ? buildPriorReadsBlock(
        paperReads.map((r, idx) => {
          const node = paperNodes?.[idx];
          return {
            paperId: r.paperId,
            title: node?.title ?? r.paperId,
            firstAuthor: node?.authors?.[0] ?? "",
            year: node?.year,
            oneLineSummary: r.skim?.oneLineSummary ?? "",
            mainContribution:
              r.read?.mainResults?.[0]?.statement ??
              r.skim?.mainContribution ??
              undefined,
          };
        }),
      )
    : "";

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
    priorReadsBlock,
    `NODES IN THIS THREAD:`,
    nodeBlock || "(no nodes — surface this as 'no resolved results yet')",
    ``,
    `WRITE the survey in markdown. Structure:`,
    `  1. ONE intro paragraph: what unifies these results, what's the central technique / question.`,
    `  2. A short story arc walking through the nodes in order: how each one`,
    `     advances the thread, what it builds on, what it leaves open. Use the`,
    `     statements / significance verbatim where they're already clean.`,
    paperReads && paperReads.length > 0
      ? `     LINEAGE: when a node's underlying paper appears in the PRIOR READS block above, frame it as building-on / refining its chronological predecessors there ("extends X 1965", "tightens the constant of Y 1973").`
      : "",
    `  3. ONE closing paragraph: where the thread stands now (frontier),`,
    `     what's blocking the next step (barrier), what kind of result would`,
    `     mark genuine progress.`,
    ``,
    `RULES:`,
    `  - Be HONEST about what you don't know. If the supplied nodes don't show`,
    `    a proof strategy, say so — do NOT invent one.`,
    `  - Do NOT fabricate citations. The only ground truth you have is the`,
    `    nodes above and the prior-reads block. Refer to results by node title`,
    `    or by [author year] from the prior-reads block.`,
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
      selfReviewMode: deps.selfReviewMode,
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
