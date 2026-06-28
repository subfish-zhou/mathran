/**
 * Rewriter handoff (DESIGN-REFERENCE §6.4).
 *
 * When the reviewer returns `rewrite_requested`, the writer model is handed the
 * original draft, the reviewer's full feedback, and the FULL source PaperReads,
 * and is required to re-read the source for any "unsupported"/"wrong" flag
 * rather than fix from memory.
 */

import { errMsg, type SpineLLM } from "../spine/llm.js";
import type { PaperRead } from "../../../paper-graph/types.js";
import type { ReviewerVerdict } from "./reviewer.js";
import { buildRewriterPrompt } from "./prompts.js";

export interface RewriteInput {
  artifactKind: "wiki-page" | "effort-document" | "effort-readme" | "thread-survey";
  artifactTitle: string;
  originalContent: string;
  reviewerVerdict: ReviewerVerdict;
  /** FULL PaperReads for re-reading — never truncated. */
  sourcePaperReads: PaperRead[];
  topic: string;
}

export interface RewriteArtifactDeps {
  emitLog?: (m: string) => void;
}

/**
 * Produce a rewritten artifact addressing the reviewer's feedback. Never throws
 * — on failure it returns the original content unchanged so the loop can stop
 * cleanly with the best draft so far.
 */
export async function rewriteArtifact(
  input: RewriteInput,
  writerLlm: SpineLLM,
  deps: RewriteArtifactDeps = {},
): Promise<string> {
  const emit = deps.emitLog ?? (() => {});
  const prompt = buildRewriterPrompt(input);
  try {
    // No maxTokens override — rewriter emits a FULL revised artifact (effort
    // document / README / wiki page). 8K cap looks generous but a long effort
    // doc plus the issue list can exceed it; truncated rewrites return
    // mid-section markdown that then fails the next review pass for
    // structural reasons (missing trailing sections), spinning the loop.
    const raw = await writerLlm(prompt, { temperature: 0.4 });
    const rewritten = stripFullDocumentFence(raw.trim());
    if (rewritten.length === 0) {
      emit("[review-loop] rewriter returned empty content; keeping original draft");
      return input.originalContent;
    }
    emit(
      `[review-loop] rewriter addressed ${input.reviewerVerdict.issues.length} issue(s) (${rewritten.length} chars)`,
    );
    return rewritten;
  } catch (err) {
    emit(`[review-loop] rewriter failed: ${errMsg(err)}; keeping original draft`);
    return input.originalContent;
  }
}

/**
 * If the model wrapped the WHOLE document in a single ```...``` fence, unwrap
 * it. Fenced code blocks WITHIN the document are left untouched.
 */
function stripFullDocumentFence(text: string): string {
  const m = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return m?.[1] != null ? m[1].trim() : text;
}
