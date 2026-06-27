/**
 * Reader — LLM prompts for the paper reading loop (Phase 2).
 *
 * Ownership note (parallel-worker batch W2):
 *   • W2-α: SKIM section  (SKIM_PROMPT_VERSION, buildSkimPrompt)
 *   • W2-β: READ section  (READ_PROMPT_VERSION, buildReadRegimeAPrompt,
 *                          buildSectionReadPrompt, buildSectionSynthesisPrompt,
 *                          buildReadRegimeCPrompt)
 *   • W2-γ: AUDIT section (AUDIT_PROMPT_VERSION, buildAuditPrompt)
 *   APPEND-ONLY across the boundary: neither worker edits the others' exports.
 */

import type { PaperNode, PaperReadBody } from "../../../paper-graph/types.js";

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

// ============================================================
//  READ PASS  (owned by W2-β — Tasks 8/9/10)
// ============================================================

export const READ_PROMPT_VERSION = "v2";

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

/**
 * Format previously-read papers as a prompt context block so the reader can
 * frame the current paper as "what does this add on top of those". Sorted
 * chronologically. Capped at 12 entries to keep token budget bounded — once
 * a literature gets dense the chronological tiebreaker has already put the
 * most relevant precedents first, so the 12-cap acts as a "recent + closest"
 * window. Empty when no priors → returns an empty string so the caller can
 * cheaply omit the section. Each entry kept to ~150 chars to stay tight.
 *
 * Cf. 层 0 from the 2026-06-27 narrative-ordering design: lineage-aware reading.
 */
export function buildPriorReadsBlock(
  priorReads: Array<{
    paperId: string;
    title: string;
    firstAuthor: string;
    year?: number;
    oneLineSummary: string;
    mainContribution?: string;
  }>,
): string {
  if (!priorReads || priorReads.length === 0) return "";
  const sorted = [...priorReads]
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
    .slice(-12); // tail = most recent + closest-to-current
  const lines = sorted.map((r) => {
    const yr = r.year ?? "?";
    const author = r.firstAuthor || "(unknown)";
    const summary = (r.mainContribution || r.oneLineSummary || "").slice(0, 160).replace(/\s+/g, " ").trim();
    return `  - [${yr}] ${author}, "${r.title.slice(0, 80)}": ${summary}`;
  });
  return [
    `PRIOR READS IN THIS RESEARCH RUN (chronological — methodological lineage you have already absorbed):`,
    ...lines,
    ``,
    `USE THIS LINEAGE WHEN READING THE PAPER BELOW. Frame the current paper as a step in this story:`,
    `- What does it build on from the priors above? Name the predecessor and the specific dependency.`,
    `- What does it improve over the closest prior? Be explicit about the delta (constants, hypotheses, technique).`,
    `- If the paper post-dates these priors but ignores them, NOTE that gap.`,
    `- Do NOT restate facts that are clearly established by the priors — link to them by author/year instead.`,
    ``,
  ].join("\n");
}

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
  priorReads: Parameters<typeof buildPriorReadsBlock>[0] = [],
): string {
  const projectName = (paper as { projectName?: string }).projectName ?? paper.title;
  const priorBlock = buildPriorReadsBlock(priorReads);
  return [
    readContract(projectName),
    ``,
    priorBlock,
    paperHeader(paper),
    `SOURCE KIND: ${sourceKind}`,
    ``,
    `FULL SOURCE (read the entire paper — nothing is truncated):`,
    `------------------------------------------------------------`,
    fullSourceText,
    `------------------------------------------------------------`,
    ``,
    `Output ONLY valid JSON.`,
  ].filter((s) => s !== "" || true).join("\n").replace(/\n\n\n+/g, "\n\n");
}

/** Regime B per-section prompt — read one section in isolation. */
export function buildSectionReadPrompt(
  paper: PaperNode,
  sectionTitle: string,
  sectionText: string,
  alreadyReadSectionTitles: string[],
  priorReads: Parameters<typeof buildPriorReadsBlock>[0] = [],
): string {
  const projectName = (paper as { projectName?: string }).projectName ?? paper.title;
  const priorContext =
    alreadyReadSectionTitles.length > 0
      ? `Sections already read (for context, do NOT re-report their results): ${alreadyReadSectionTitles.join(
          "; ",
        )}`
      : `This is the first section.`;
  const priorBlock = buildPriorReadsBlock(priorReads);
  return [
    `You are an expert mathematician reading ONE section of a paper for the`,
    `research project "${projectName}". Extract what THIS section contributes.`,
    ``,
    priorBlock,
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
  priorReads: Parameters<typeof buildPriorReadsBlock>[0] = [],
): string {
  const projectName = (paper as { projectName?: string }).projectName ?? paper.title;
  const priorBlock = buildPriorReadsBlock(priorReads);
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
    priorBlock,
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

export const AUDIT_PROMPT_VERSION = "v2";

/**
 * Input to {@link buildAuditPrompt}. Structurally compatible with `AuditInput`
 * from `./audit.ts` — kept inline so this prompt module has no cross-pass
 * dependency on the audit module (prevents an import cycle).
 */
export interface BuildAuditPromptInput {
  paper: PaperNode;
  /** The agent's distilled read body (NOT the raw source). */
  read: PaperReadBody;
  sourceKind: "tex" | "pdf-text" | "html" | "abstract-only";
  problemTitle: string;
}

function fmtAuthors(authors: string[]): string {
  if (authors.length === 0) return "(unknown)";
  if (authors.length <= 4) return authors.join(", ");
  return `${authors.slice(0, 4).join(", ")} et al.`;
}

function fmtReadBody(input: BuildAuditPromptInput): string {
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
export function buildAuditPrompt(input: BuildAuditPromptInput): string {
  const { paper, sourceKind, problemTitle } = input;
  const ocrCaveat =
    sourceKind === "pdf-text"
      ? `\nIMPORTANT — SOURCE IS PDF/OCR TEXT: formula chaos, broken LaTeX, and garbled symbols are EXPECTED artifacts of text extraction. Do NOT penalize the paper for them. Judge PROSE and STRUCTURE only.`
      : "";

  return `You are a SENIOR REFEREE for a top mathematics journal. You are auditing an AI agent's DISTILLATION of a paper. You decide whether the distilled paper is (a) genuine rigorous mathematics, (b) likely pseudo-mathematics ("crank" work), or (c) internally fine but on the WRONG TOPIC for the project. You are NOT re-deriving the proofs; you are assessing plausibility signals in the distillation AND topical fit to the target problem.

## Target problem context
The agent is studying this paper while working on: "${problemTitle}".

## Paper metadata
Title:   ${paper.title}
Authors: ${fmtAuthors(paper.authors)}
Year:    ${paper.year ?? "(unknown)"}
${paper.arxivId ? `arXiv:   ${paper.arxivId}\n` : ""}Source kind: ${sourceKind}${ocrCaveat}

## The agent's distillation (this is what you audit)
${fmtReadBody(input)}

## Step 1 — TOPICAL FIT check (do this FIRST)
Before judging rigor, ask: is this paper plausibly RELEVANT to "${problemTitle}"?
Use the agent's distilled mainResults, novelContributions, techniques, and dependencies.

A paper is OFF_TOPIC when it is internally fine but in the WRONG FIELD or about a DIFFERENT problem:
- A particle-physics measurement (B-meson decays, fragmentation fractions, detector calibration)
  pulled in by chance while studying a number-theory problem like Goldbach.
- A bibliometrics / citation-analysis methodology paper showing up in a math reading queue.
- A biology / chemistry / engineering paper.
- A pure-math paper from a DIFFERENT subfield (algebraic geometry distillation while target problem is in analytic number theory) where its results have NO plausible bearing on the target.

If OFF_TOPIC: set verdict = "off_topic" and STOP. Do NOT score for rigor (score is irrelevant
for off-topic papers). Set flags to short snake_case tags naming the actual topic (e.g.
\`["high_energy_physics", "not_number_theory"]\` or \`["bibliometrics", "not_mathematics"]\`).
The reason field must NAME the actual field the paper belongs to AND why it's not related to
"${problemTitle}".

A paper is NOT off-topic just because:
- It is technical / specialized (most relevant papers are).
- It addresses a closely-related sub-question (refinements, generalizations, weaker variants).
- It is a survey or expository piece in the right field.
- It uses techniques from a neighboring area (analytic number theory often borrows from harmonic analysis / probability / combinatorics — that's NOT off-topic).
When in doubt, prefer "trusted" / "warn" over "off_topic". Off-topic is for clear field mismatch.

## Step 2 — RIGOR check (only if topical fit passed)
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

## Scoring (rigor verdicts only — off_topic does NOT use score)
- "rejected" (score 0-3): use ONLY when MULTIPLE severe defects co-occur (e.g. no extractable statements AND elementary-proof-of-famous-problem AND empty dependencies).
- "warn"     (score 4-6): concerning but salvageable — some rigor signals present, some missing.
- "trusted"  (score 7-10): default; precise statements, named techniques, plausible dependencies.
- "off_topic" (score omitted or 0): paper is internally fine but NOT about "${problemTitle}". The reading loop will keep the read but stop harvesting citations from this paper.

## Output — STRICT JSON only, no prose around it
{
  "verdict": "trusted" | "warn" | "rejected" | "off_topic",
  "score": <integer 0-10, or 0 when verdict=off_topic>,
  "flags": ["short_snake_case_tag", ...],
  "reason": "<= 500 chars; cite the SPECIFIC distillation issues that drove the verdict; for off_topic, name the actual field and why it's unrelated to the target problem"
}`;
}
