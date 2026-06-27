/**
 * Reading-loop — LLM prompts owned by the reading loop (Phase D).
 *
 * Ownership note: the reader (Phase B) owns `reader/prompts.ts`. This file is
 * for prompts that belong to the *loop* around the reader — currently only the
 * survey-distillation pass (DESIGN-REFERENCE §7.1), which runs once after a
 * high-confidence survey has been read, to extract its curated reading list.
 */

import type { PaperNode, PaperReadBody } from "../../paper-graph/types.js";

export const SURVEY_DISTILLATION_PROMPT_VERSION = "v1";

/**
 * Build the survey-distillation prompt. The model is given the already-computed
 * PaperReadBody (the regular read of the survey) plus the survey's metadata, and
 * is asked to extract the survey author's curated "what you should read" list and
 * structural outline — the gold that we then auto-promote into the reading queue.
 *
 * Returns a prompt that asks for a JSON object matching
 * `PaperReadSurveyDistillation`:
 *   { coveredSubAreas, keyReferences[], surveyAuthorOpinion?, surveyOutline? }
 */
export function buildSurveyDistillationPrompt(
  paper: PaperNode,
  body: PaperReadBody,
  problemTitle: string,
): string {
  const authors = paper.authors.length > 0 ? paper.authors.join(", ") : "(unknown authors)";
  const year = paper.year != null ? String(paper.year) : "(unknown year)";

  const outline =
    body.mainResults.length > 0
      ? body.mainResults.map((r) => `- ${r.label}: ${r.statement}`.slice(0, 300)).join("\n")
      : "(no enumerated main results)";

  const deps =
    body.technicalDependencies.length > 0
      ? body.technicalDependencies
          .map((d) => `- ${d.claim} (source: ${d.source}; used in ${d.whereUsed})`)
          .join("\n")
      : "(none recorded)";

  return [
    "You are a mathematics research assistant DISTILLING A SURVEY.",
    "A survey is a senior expert's pre-compressed map of a field. Your job is to extract",
    "the survey author's curated knowledge so a downstream agent can decide what to read next.",
    "",
    `## OUR PROBLEM\n${problemTitle}`,
    "",
    "## SURVEY METADATA",
    `Title: ${paper.title}`,
    `Authors: ${authors}`,
    `Year: ${year}`,
    "",
    "## WHAT WE ALREADY READ (the survey's main content, as notes)",
    `Proof/exposition strategy: ${body.proofStrategy || "(none)"}`,
    "",
    "Main results / sections:",
    outline,
    "",
    "Technical dependencies the survey leans on:",
    deps,
    "",
    `Novel contributions noted: ${body.novelContributions || "(none)"}`,
    "",
    "## YOUR TASK",
    "Return ONLY a JSON object with this exact shape:",
    "{",
    '  "coveredSubAreas": string[],            // the sub-areas this survey covers, e.g. "minor arc estimates"',
    '  "keyReferences": [                       // the survey author\'s curated "what to read" list',
    "    {",
    '      "author": string,',
    '      "year": number,',
    '      "title": string,',
    '      "arxivId": string | null,            // if the survey gives one or it is well-known',
    '      "whyTheSurveyHighlighted": string    // 1 sentence: why the survey author flags this work',
    "    }",
    "  ],",
    '  "surveyAuthorOpinion": string | null,    // the author\'s thesis, e.g. "X is the bottleneck"',
    '  "surveyOutline": [                        // the survey\'s own table of contents, captured',
    '    { "heading": string, "summary": string }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- Prefer references the survey itself emphasizes (calls 'fundamental', 'the key result', etc.).",
    "- Use null for unknown arxivId; never invent an arxiv id.",
    "- Keep each whyTheSurveyHighlighted to one sentence.",
    "- Output JSON only, no prose, no markdown fences.",
  ].join("\n");
}
