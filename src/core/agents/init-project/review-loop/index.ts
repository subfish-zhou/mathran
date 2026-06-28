/**
 * Writer-Reviewer review loop orchestrator (DESIGN-REFERENCE Part 6).
 *
 * Reusable component (NOT bolted into init-only flow, per §6.8): a writer model
 * drafts, a SEPARATE reviewer model reads it as an attentive grad student, and
 * if the reading experience is poor the writer re-reads the source PaperReads
 * and rewrites. Loops until `approve`, `maxRevisions`, or the cost alarm.
 *
 *   revisionNumber 0 = the initial draft.
 *   finalVerdict "approve"            → reviewer was satisfied.
 *   finalVerdict "flagged_persistent" → budget/revisions exhausted with the
 *                                       reviewer still requesting a rewrite
 *                                       (§6.6 — surfaced for a human).
 */

import type { SpineLLM } from "../spine/llm.js";
import type { PaperRead } from "../../../paper-graph/types.js";
import {
  reviewArtifact,
  type ReviewerVerdict,
  type ReviewArtifactInput,
} from "./reviewer.js";
import { rewriteArtifact, type RewriteInput } from "./rewriter.js";
import {
  DEFAULT_REVIEW_LOOP_BUDGET,
  estimateCost as defaultEstimateCost,
  estimateTokens,
  type ReviewLoopBudget,
} from "./budget.js";

export { DEFAULT_REVIEW_LOOP_BUDGET, estimateCost, estimateTokens } from "./budget.js";
export type { ReviewLoopBudget } from "./budget.js";
export {
  reviewArtifact,
  normalizeVerdict,
  type ReviewerVerdict,
  type ReviewIssue,
  type ReviewArtifactInput,
  type ReviewSeverity,
  type ReviewKind,
} from "./reviewer.js";
export { rewriteArtifact, type RewriteInput } from "./rewriter.js";
export {
  buildReviewerPrompt,
  buildRewriterPrompt,
  REVIEWER_PROMPT_VERSION,
  REWRITER_PROMPT_VERSION,
} from "./prompts.js";

export interface ReviewLoopConfig {
  artifactKind: "wiki-page" | "effort-document" | "effort-readme" | "thread-survey";
  artifactTitle: string;
  artifactSlug: string;
  initialContent: string;
  sourcePaperReads: PaperRead[];
  topic: string;
  audienceHint?: string;
  /** Routing label for the writer model. */
  writerModel: string;
  /** Routing label for the reviewer model (SEPARATE from writerModel). */
  reviewerModel: string;
  /**
   * When true, the reviewer prompt switches to a self-review preamble that
   * compensates for the well-known weakness of single-model self-review.
   * Forward this from the orchestrator when `modelPair.identical` is true.
   * See reviewer.ts.ReviewArtifactInput.selfReviewMode for the rationale.
   */
  selfReviewMode?: boolean;
}

export interface ReviewRevision {
  revisionNumber: number;
  contentSnapshot: string;
  reviewerVerdict: ReviewerVerdict;
  costUsdSoFar: number;
  timestamp: string;
}

export interface ReviewLoopResult {
  finalContent: string;
  /**
   * `approve` — reviewer was satisfied.
   * `flagged_persistent` — reviewer kept requesting rewrites until budget/maxRevisions ran out (the writer's last draft is kept).
   * `reviewer_broken` — reviewer returned unparseable JSON or threw after one strict-format retry. Distinct from
   *                     `flagged_persistent` because no opinion on the artifact was ever rendered. The artifact is
   *                     surfaced for human review with that fact made explicit, instead of silently approved.
   */
  finalVerdict: "approve" | "flagged_persistent" | "reviewer_broken";
  revisionHistory: ReviewRevision[];
  totalCostUsd: number;
  totalReviewerLlmCalls: number;
  totalWriterLlmCalls: number;
}

export interface ReviewLoopDeps {
  writerLlm: SpineLLM;
  reviewerLlm: SpineLLM;
  emitLog?: (m: string) => void;
  estimateCost?: (model: string, tokens: { in: number; out: number }) => number;
}

function reviewInput(config: ReviewLoopConfig, content: string): ReviewArtifactInput {
  return {
    artifactKind: config.artifactKind,
    artifactTitle: config.artifactTitle,
    artifactSlug: config.artifactSlug,
    artifactContent: content,
    topic: config.topic,
    audienceHint: config.audienceHint,
    selfReviewMode: config.selfReviewMode,
  };
}

function rewriteInput(
  config: ReviewLoopConfig,
  content: string,
  verdict: ReviewerVerdict,
): RewriteInput {
  return {
    artifactKind: config.artifactKind,
    artifactTitle: config.artifactTitle,
    originalContent: content,
    reviewerVerdict: verdict,
    sourcePaperReads: config.sourcePaperReads,
    topic: config.topic,
  };
}

export async function reviewLoop(
  config: ReviewLoopConfig,
  budget: ReviewLoopBudget = DEFAULT_REVIEW_LOOP_BUDGET,
  deps: ReviewLoopDeps,
): Promise<ReviewLoopResult> {
  const emit = deps.emitLog ?? (() => {});
  const costOf = deps.estimateCost ?? defaultEstimateCost;
  // Rough source size (re-read by every rewrite) for rewrite-call cost.
  const sourceChars = config.sourcePaperReads.reduce(
    (n, r) => n + JSON.stringify(r).length,
    0,
  );

  let currentContent = config.initialContent;
  let revisionNumber = 0;
  let totalCostUsd = 0;
  let totalReviewerLlmCalls = 0;
  let totalWriterLlmCalls = 0;
  const revisionHistory: ReviewRevision[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // (a) review the current draft.
    const verdict = await reviewArtifact(reviewInput(config, currentContent), deps.reviewerLlm, {
      emitLog: emit,
    });
    totalReviewerLlmCalls++;
    totalCostUsd += costOf(config.reviewerModel, {
      in: estimateTokens(currentContent.length) + 400,
      out: estimateTokens(JSON.stringify(verdict).length),
    });

    revisionHistory.push({
      revisionNumber,
      contentSnapshot: currentContent,
      reviewerVerdict: verdict,
      costUsdSoFar: totalCostUsd,
      timestamp: new Date().toISOString(),
    });

    // (b) approved → done.
    if (verdict.verdict === "approve") {
      emit(`[review-loop] "${config.artifactSlug}" approved at revision ${revisionNumber}`);
      return {
        finalContent: currentContent,
        finalVerdict: "approve",
        revisionHistory,
        totalCostUsd,
        totalReviewerLlmCalls,
        totalWriterLlmCalls,
      };
    }

    // (b') reviewer broken → short-circuit. Do NOT rewrite (the writer has
    // nothing to act on without a verdict) and do NOT silent-approve. Surface
    // honestly so the artifact appears in the human-review queue with the
    // failure mode named explicitly. See reviewer.ts for the rationale.
    if (verdict.verdict === "reviewer_broken") {
      emit(`[review-loop] "${config.artifactSlug}" reviewer_broken at revision ${revisionNumber} — short-circuiting (no rewrite, no silent approve)`);
      return {
        finalContent: currentContent,
        finalVerdict: "reviewer_broken",
        revisionHistory,
        totalCostUsd,
        totalReviewerLlmCalls,
        totalWriterLlmCalls,
      };
    }

    // (c) budget exhausted → accept current draft, flag it.
    if (revisionNumber >= budget.maxRevisions || totalCostUsd >= budget.costAlarmUsd) {
      const why =
        totalCostUsd >= budget.costAlarmUsd
          ? `cost alarm $${totalCostUsd.toFixed(2)} ≥ $${budget.costAlarmUsd}`
          : `max revisions ${budget.maxRevisions} reached`;
      emit(`[review-loop] "${config.artifactSlug}" flagged_persistent (${why})`);
      return {
        finalContent: currentContent,
        finalVerdict: "flagged_persistent",
        revisionHistory,
        totalCostUsd,
        totalReviewerLlmCalls,
        totalWriterLlmCalls,
      };
    }

    // (d) rewrite, then loop.
    const rewritten = await rewriteArtifact(
      rewriteInput(config, currentContent, verdict),
      deps.writerLlm,
      { emitLog: emit },
    );
    totalWriterLlmCalls++;
    totalCostUsd += costOf(config.writerModel, {
      in: estimateTokens(currentContent.length + sourceChars + JSON.stringify(verdict).length),
      out: estimateTokens(rewritten.length),
    });
    currentContent = rewritten;
    revisionNumber++;
  }
}
