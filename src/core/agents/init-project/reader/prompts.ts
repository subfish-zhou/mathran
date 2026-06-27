/**
 * Reader pipeline prompt templates.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * W2-γ APPENDED SECTION (Tasks 11): audit-pass prompts.
 *
 * NOTE FOR MERGE: W2-α and W2-β also create this file with the skim / read
 * regime prompts (and the `SKIM_PROMPT_VERSION` / `READ_PROMPT_VERSION`
 * constants the orchestrator imports). At merge time the worker sections are
 * concatenated; this block APPENDS the audit prompt only and must not reorder
 * or modify the skim/read exports.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { AuditInput } from "./audit.js";

export const AUDIT_PROMPT_VERSION = "v1";

function fmtAuthors(authors: string[]): string {
  if (authors.length === 0) return "(unknown)";
  if (authors.length <= 4) return authors.join(", ");
  return `${authors.slice(0, 4).join(", ")} et al.`;
}

function fmtReadBody(input: AuditInput): string {
  const { read } = input;
  const results = read.mainResults.length
    ? read.mainResults
        .map(
          (r) =>
            `  - ${r.label} [${r.whereInPaper}]: ${r.statement}\n    novelty vs prior: ${r.noveltyVsPrior || "(none stated)"}`,
        )
        .join("\n")
    : "  (none extracted)";

  const techniques = read.keyTechniques.length
    ? read.keyTechniques.map((t) => `  - ${t.name}: ${t.role}`).join("\n")
    : "  (none extracted)";

  const deps = read.technicalDependencies.length
    ? read.technicalDependencies
        .map((d) => `  - ${d.claim} (from ${d.source}; used in ${d.whereUsed})`)
        .join("\n")
    : "  (EMPTY)";

  const hardSteps = read.hardSteps.length
    ? read.hardSteps.map((s) => `  - ${s}`).join("\n")
    : "  (EMPTY)";

  return [
    `ROLE OF THIS PAPER (agent's classification): ${read.role}`,
    "",
    "MAIN RESULTS:",
    results,
    "",
    "PROOF STRATEGY:",
    `  ${read.proofStrategy || "(EMPTY)"}`,
    "",
    "KEY TECHNIQUES:",
    techniques,
    "",
    "TECHNICAL DEPENDENCIES:",
    deps,
    "",
    "NOVEL CONTRIBUTIONS:",
    `  ${read.novelContributions || "(EMPTY)"}`,
    "",
    "STANDARD MATERIAL:",
    `  ${read.standardMaterial || "(none)"}`,
    "",
    "HARD STEPS:",
    hardSteps,
  ].join("\n");
}

/**
 * Pass 3 of 3 — rigor audit prompt.
 *
 * The auditor is a senior referee judging the AGENT'S DISTILLATION (not the
 * paper's prose). This surfaces cranks (no extractable statements + sweeping
 * claims + empty dependencies) while sparing unconventional-but-legit work.
 */
export function buildAuditPrompt(input: AuditInput): string {
  const { paper, sourceKind, problemTitle } = input;
  const ocrCaveat =
    sourceKind === "pdf-text"
      ? `\nIMPORTANT — SOURCE IS PDF/OCR TEXT: formula chaos, broken LaTeX, and garbled symbols are EXPECTED artifacts of text extraction. Do NOT penalize the paper for them. Judge PROSE and STRUCTURE only.`
      : "";

  return `You are a SENIOR REFEREE for a top mathematics journal. You are auditing an AI agent's DISTILLATION of a paper — i.e. you judge whether the agent's recorded understanding reflects genuine, rigorous mathematics, or whether the paper is likely pseudo-mathematics ("crank" work). You are NOT re-deriving the proofs; you are assessing plausibility and rigor signals in the distillation.

## Target problem context
The agent is studying this paper while working on: "${problemTitle}".

## Paper metadata
Title:   ${paper.title}
Authors: ${fmtAuthors(paper.authors)}
Year:    ${paper.year ?? "(unknown)"}
${paper.arxivId ? `arXiv:   ${paper.arxivId}\n` : ""}Source kind: ${sourceKind}${ocrCaveat}

## The agent's distillation (this is what you audit)
${fmtReadBody(input)}

## Watch-list — RED FLAGS (raise the alarm when you see these)
- Sweeping claims but NO precise theorem statement is extractable.
- \`technicalDependencies\` is EMPTY for a paper claiming a major / hard result.
- \`novelContributions\` claims a COMPLETE proof of a famous open problem using ELEMENTARY methods.
- \`proofStrategy\` is hand-wavy with no NAMED techniques.
- \`hardSteps\` is EMPTY while the paper claims a breakthrough.
Multiple co-occurring red flags ⇒ likely crank.

## NOT defects — do NOT penalize these
- Unconventional structure or idiosyncratic notation (e.g. Mochizuki-style) — fine if statements are precise.
- Genuinely hard arguments that assume substantial background.
- A SHORT paper, if its result is genuinely tight / narrow.
- OCR / PDF formula artifacts — judge prose and structure only for pdf-text sources.

## Scoring
- "rejected" (score 0-3): use ONLY when MULTIPLE severe defects co-occur (e.g. no extractable statements AND elementary-proof-of-famous-problem AND empty dependencies).
- "warn"     (score 4-6): concerning but salvageable — some rigor signals present, some missing.
- "trusted"  (score 7-10): default; precise statements, named techniques, plausible dependencies.

## Output — STRICT JSON only, no prose around it
{
  "verdict": "trusted" | "warn" | "rejected",
  "score": <integer 0-10>,
  "flags": ["short_snake_case_tag", ...],
  "reason": "<= 500 chars; cite the SPECIFIC distillation issues that drove the verdict"
}`;
}
