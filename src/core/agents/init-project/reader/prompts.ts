/**
 * prompts.ts — Reader pass prompt builders.
 *
 * This file is APPENDED to by later Batch 2 workers (read regimes A/B/C,
 * audit, citation harvest). Keep each pass's exports grouped and clearly
 * delimited. This worker (W2-α) owns ONLY the skim-pass exports below.
 */

import type { PaperNode } from "../../../paper-graph/types.js";

// ── Skim pass (Pass 1 of 3) ──────────────────────────────────────────────────

export const SKIM_PROMPT_VERSION = "v1";

/**
 * Build the skim prompt. The LLM sees the abstract, the section outline, a
 * ~3KB intro excerpt and a ~2KB conclusion excerpt, and is asked to return a
 * PaperReadSkim JSON verdict on whether to study / skim / discard the paper.
 */
export function buildSkimPrompt(
  paper: PaperNode,
  sourceKind: "tex" | "pdf-text" | "html" | "abstract-only",
  outline: Array<{ title: string; level: 1 | 2 | 3 }>,
  introExcerpt: string,
  conclusionExcerpt: string,
): string {
  const authors = paper.authors.length > 0 ? paper.authors.join(", ") : "(unknown authors)";
  const year = paper.year != null ? String(paper.year) : "(unknown year)";
  const abstract = paper.abstract && paper.abstract.trim().length > 0 ? paper.abstract.trim() : "(no abstract available)";

  const outlineBlock =
    outline.length > 0
      ? outline.map((s) => `${"  ".repeat(s.level - 1)}- ${s.title}`).join("\n")
      : "(no section outline available)";

  const qualityWarning =
    sourceKind === "pdf-text" || sourceKind === "abstract-only"
      ? "\n\nWARNING: this source was extracted from PDF/abstract-only text. Mathematical notation, " +
        "symbols, and formulae may be garbled or unreliable. Do not over-index on exact notation; " +
        "rely on prose meaning and be conservative in your decision.\n"
      : "";

  return [
    "You are a mathematics research assistant performing PASS 1 of 3 (a SKIM) over a paper.",
    "Your job is to form a fast, high-level impression and decide how much further effort the paper warrants.",
    qualityWarning,
    "## PAPER METADATA",
    `Title: ${paper.title}`,
    `Authors: ${authors}`,
    `Year: ${year}`,
    `Source kind: ${sourceKind}`,
    "",
    "## ABSTRACT",
    abstract,
    "",
    "## OUTLINE",
    outlineBlock,
    "",
    "## INTRO EXCERPT",
    introExcerpt.trim().length > 0 ? introExcerpt : "(no intro excerpt available)",
    "",
    "## CONCLUSION EXCERPT",
    conclusionExcerpt.trim().length > 0 ? conclusionExcerpt : "(no conclusion excerpt available)",
    "",
    "## YOUR TASK",
    "Decide one of three verdicts:",
    '  - "study"           = a core milestone / technique-origin paper that warrants a full read.',
    '  - "skim_sufficient" = relevant but supporting; this skim is enough for downstream synthesis.',
    '  - "discard"         = not relevant to the problem, or already subsumed by other work.',
    "",
    "Respond with a SINGLE JSON object (no prose, no markdown fences) matching exactly this shape:",
    "{",
    '  "oneLineSummary": string,          // <= 200 chars',
    '  "mainContribution": string,        // 2-4 sentences',
    '  "sectionOutline": [{ "level": 1 | 2 | 3, "title": string }],',
    '  "decision": "study" | "skim_sufficient" | "discard",',
    '  "decisionReason": string',
    "}",
  ].join("\n");
}
