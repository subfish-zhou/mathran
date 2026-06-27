/**
 * Reader — Read pass, Regime C (OCR / pdf-text source).
 *
 * Used by the orchestrator when there is no `.tex` source, only PDF/OCR-extracted
 * text (`source.kind === "pdf-text"`) or just the abstract
 * (`source.kind === "abstract-only"`).
 *
 * Same output shape as Regime A, but the prompt warns the model that LaTeX
 * formulas may be garbled by extraction — it should judge the paper from
 * structure and prose and paraphrase faithfully when a verbatim statement is
 * unrecoverable. For `abstract-only`, it produces a minimal `PaperReadBody`.
 *
 * Never throws: on any LLM/parse failure it returns a degenerate-but-valid body.
 */

import type { PaperNode, PaperReadBody } from "../../../paper-graph/types.js";
import { extractSpineJSON, errMsg } from "../spine/llm.js";
import { buildReadRegimeCPrompt } from "./prompts.js";
import type { LoadedSource } from "./source-loader.js";
import {
  coercePaperReadBody,
  degeneratePaperReadBody,
  ensureMainResults,
  type ReadRegimeDeps,
} from "./read-regime-a.js";

/**
 * OCR / pdf-text read. Never throws.
 *
 * For `abstract-only` sources the LLM only sees the abstract and is asked for a
 * minimal body; if that fails (or the source text is empty) we fall back to the
 * degenerate abstract-derived body.
 */
export async function readPaperRegimeC(
  paper: PaperNode,
  source: LoadedSource,
  deps: ReadRegimeDeps,
): Promise<PaperReadBody> {
  const log = deps.emitLog ?? (() => {});
  const isAbstractOnly = source.kind === "abstract-only";
  const sourceText = source.text?.trim() ? source.text : (paper.abstract ?? "");

  const prompt = buildReadRegimeCPrompt(paper, sourceText, isAbstractOnly, deps.priorReads ?? []);

  let reply: string;
  try {
    reply = await deps.llm(prompt, { temperature: 0.2 });
  } catch (err) {
    log(`[read:C] LLM call failed for "${paper.title}": ${errMsg(err)} — using degenerate body`);
    return degeneratePaperReadBody(paper);
  }

  const body = coercePaperReadBody(extractSpineJSON(reply));
  if (!body) {
    log(`[read:C] could not parse PaperReadBody for "${paper.title}" — using degenerate body`);
    return degeneratePaperReadBody(paper);
  }

  const ensured = ensureMainResults(body, paper);
  if (isAbstractOnly) {
    // Abstract-only reads are intentionally minimal: drop any proof strategy the
    // model may have hallucinated from a source it never actually saw.
    return { ...ensured, proofStrategy: "" };
  }
  return ensured;
}
