/**
 * Reader — LLM prompts for the paper reading loop (Phase 2).
 *
 * Ownership note (parallel-worker batch W2):
 *   • W2-α owns the SKIM section at the TOP of this file
 *     (`SKIM_PROMPT_VERSION`, `buildSkimPrompt`).
 *   • W2-β owns the READ section at the BOTTOM of this file
 *     (`READ_PROMPT_VERSION`, `buildReadRegimeAPrompt`, `buildSectionReadPrompt`,
 *      `buildSectionSynthesisPrompt`, `buildReadRegimeCPrompt`).
 *   APPEND-ONLY across the boundary: neither side edits the other's exports.
 */

import type { PaperNode } from "../../../paper-graph/types.js";

// ============================================================
//  SKIM PASS  (owned by W2-α — placeholder until merge)
// ============================================================

export const SKIM_PROMPT_VERSION = "v1";

/**
 * Placeholder skim prompt builder. W2-α's Task-7 implementation supersedes this
 * at merge; kept minimal here only so the reader package compiles standalone.
 */
export function buildSkimPrompt(paper: PaperNode, sourceExcerpt: string): string {
  return [
    `Skim the following paper for project triage.`,
    `TITLE: ${paper.title}`,
    `SOURCE (excerpt):`,
    sourceExcerpt,
    `Output ONLY valid JSON.`,
  ].join("\n");
}

// ============================================================
//  READ PASS  (owned by W2-β — Tasks 8/9/10)
// ============================================================

export const READ_PROMPT_VERSION = "v1";

/** The JSON shape every read prompt asks the model to emit (a `PaperReadBody`). */
const READ_BODY_JSON_SHAPE = `{
  "mainResults": [
    { "label": "Theorem 1.1", "statement": "<VERBATIM LaTeX>", "whereInPaper": "§3, p. 12", "noveltyVsPrior": "Improves on Tao 2012 by ..." }
  ],
  "proofStrategy": "1-3 paragraphs of high-level proof idea",
  "keyTechniques": [{ "name": "large sieve", "role": "Used to bound Type II sums" }],
  "technicalDependencies": [{ "claim": "Bombieri-Vinogradov", "source": "Bombieri 1965", "whereUsed": "Lemma 2.4" }],
  "novelContributions": "what is genuinely new in this paper",
  "standardMaterial": "what is textbook / well-known background",
  "hardSteps": ["the single hardest step, where the magic happens"],
  "role": "milestone|refinement|technique_origin|barrier|bridge|survey|computation|dead_end|foundational"
}`;

/** Shared instructions block enforcing verbatim statements + JSON-only output. */
function readContract(projectName: string): string {
  return [
    `You are an expert mathematician reading a paper on behalf of the research`,
    `project "${projectName}". Produce deep, faithful reading notes.`,
    ``,
    `Return ONLY a JSON object matching this exact shape:`,
    READ_BODY_JSON_SHAPE,
    ``,
    `CRITICAL RULES:`,
    `1. Every "statement" MUST be the VERBATIM LaTeX of the result, including all`,
    `   quantifiers, hypotheses, bounds, and conditions. NEVER abbreviate with`,
    `   \\cdots, "...", or "(omitted)". Copy the formula exactly as written.`,
    `2. If a statement is genuinely too long to quote whole, paraphrase it`,
    `   faithfully and prefix it with "<faithful paraphrase>".`,
    `3. Capture EVERY main result (theorems, propositions, main lemmas), not just`,
    `   the headline one.`,
    `4. "role" MUST be exactly one of the enum values listed in the shape.`,
    `5. If you cannot determine a field, use an empty string / empty array — do`,
    `   not invent content.`,
  ].join("\n");
}

/** Compact paper-context header shared by the read prompts. */
function paperHeader(paper: PaperNode): string {
  const authors =
    paper.authors.slice(0, 6).join(", ") + (paper.authors.length > 6 ? " et al." : "");
  return [
    `PAPER TITLE: ${paper.title}`,
    `AUTHORS: ${authors || "(unknown)"}`,
    `YEAR: ${paper.year ?? "?"}`,
    paper.arxivId ? `ARXIV: ${paper.arxivId}` : "",
    paper.abstract ? `ABSTRACT: ${paper.abstract}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Regime A prompt — whole-paper read (full, never-truncated source). */
export function buildReadRegimeAPrompt(
  paper: PaperNode,
  fullSourceText: string,
  sourceKind: "tex" | "pdf-text" | "html",
): string {
  const projectName = (paper as { projectName?: string }).projectName ?? paper.title;
  return [
    readContract(projectName),
    ``,
    paperHeader(paper),
    `SOURCE KIND: ${sourceKind}`,
    ``,
    `FULL SOURCE (read the entire paper — nothing is truncated):`,
    `------------------------------------------------------------`,
    fullSourceText,
    `------------------------------------------------------------`,
    ``,
    `Output ONLY valid JSON.`,
  ].join("\n");
}

/** Regime B per-section prompt — read one section in isolation. */
export function buildSectionReadPrompt(
  paper: PaperNode,
  sectionTitle: string,
  sectionText: string,
  alreadyReadSectionTitles: string[],
): string {
  const projectName = (paper as { projectName?: string }).projectName ?? paper.title;
  const priorContext =
    alreadyReadSectionTitles.length > 0
      ? `Sections already read (for context, do NOT re-report their results): ${alreadyReadSectionTitles.join(
          "; ",
        )}`
      : `This is the first section.`;
  return [
    `You are an expert mathematician reading ONE section of a paper for the`,
    `research project "${projectName}". Extract what THIS section contributes.`,
    ``,
    paperHeader(paper),
    `CURRENT SECTION: ${sectionTitle}`,
    priorContext,
    ``,
    `SECTION TEXT (verbatim, not truncated):`,
    `------------------------------------------------------------`,
    sectionText,
    `------------------------------------------------------------`,
    ``,
    `Return ONLY a JSON object of this shape:`,
    `{`,
    `  "sectionTitle": "${sectionTitle}",`,
    `  "theoremsStated": [{ "label": "Theorem 2.1", "statement": "<VERBATIM LaTeX>" }],`,
    `  "dependenciesIntroduced": ["names of external results this section invokes"],`,
    `  "techniqueRole": "one sentence: what role this section plays in the paper"`,
    `}`,
    ``,
    `Every "statement" MUST be VERBATIM LaTeX — never \\cdots-truncate. If too long,`,
    `paraphrase faithfully and prefix with "<faithful paraphrase>".`,
    ``,
    `Output ONLY valid JSON.`,
  ].join("\n");
}

/** Regime B synthesis prompt — merge per-section reads into one PaperReadBody. */
export function buildSectionSynthesisPrompt(
  paper: PaperNode,
  sectionReads: Array<{ title: string; summary: string }>,
): string {
  const projectName = (paper as { projectName?: string }).projectName ?? paper.title;
  const sections = sectionReads
    .map((s, i) => `### Section ${i + 1}: ${s.title}\n${s.summary}`)
    .join("\n\n");
  return [
    readContract(projectName),
    ``,
    paperHeader(paper),
    ``,
    `You have already read the paper section-by-section. Below are the structured`,
    `notes from each section. MERGE them into a single coherent reading:`,
    ` • Deduplicate main results that appear in multiple sections.`,
    ` • Consolidate technical dependencies across sections.`,
    ` • Preserve every VERBATIM statement exactly — do not re-truncate.`,
    ``,
    `PER-SECTION NOTES:`,
    sections,
    ``,
    `Output ONLY valid JSON.`,
  ].join("\n");
}

/** Regime C prompt — OCR/PDF-text source (formula chaos expected). */
export function buildReadRegimeCPrompt(
  paper: PaperNode,
  sourceText: string,
  isAbstractOnly: boolean,
): string {
  const projectName = (paper as { projectName?: string }).projectName ?? paper.title;
  const warning = isAbstractOnly
    ? [
        `SOURCE QUALITY WARNING: Only the ABSTRACT is available for this paper; the`,
        `full text could not be obtained. Produce a MINIMAL reading: one mainResult`,
        `paraphrased faithfully from the abstract (mark its statement as a`,
        `"<faithful paraphrase; full text unavailable>"), an empty proofStrategy, and`,
        `infer "role" from the abstract. Do NOT fabricate theorems you cannot see.`,
      ].join("\n")
    : [
        `SOURCE QUALITY WARNING: This text came from PDF/OCR extraction; LaTeX`,
        `formulas may be garbled or missing. Judge the paper from STRUCTURE and`,
        `PROSE; do NOT penalize the paper for formula chaos from the extraction. If`,
        `you cannot extract a verbatim theorem statement, paraphrase faithfully and`,
        `indicate "statement": "<faithful paraphrase; original formula lost to OCR>".`,
      ].join("\n");
  return [
    readContract(projectName),
    ``,
    warning,
    ``,
    paperHeader(paper),
    `SOURCE KIND: ${isAbstractOnly ? "abstract-only" : "pdf-text (OCR)"}`,
    ``,
    isAbstractOnly ? `ABSTRACT / AVAILABLE TEXT:` : `EXTRACTED TEXT (full, not truncated):`,
    `------------------------------------------------------------`,
    sourceText,
    `------------------------------------------------------------`,
    ``,
    `Output ONLY valid JSON.`,
  ].join("\n");
}
