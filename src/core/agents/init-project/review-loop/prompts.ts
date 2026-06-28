/**
 * Review-loop prompts (DESIGN-REFERENCE Part 6).
 *
 * Two prompts power the writer-reviewer loop:
 *   - buildReviewerPrompt : casts the reviewer model as an attentive graduate
 *                           student READING the artifact (NOT a rubric checker).
 *                           The framing is copied VERBATIM from §6.3 — its
 *                           effectiveness depends on the exact wording.
 *   - buildRewriterPrompt : hands the writer model the original draft, the
 *                           reviewer's full feedback, and the FULL source
 *                           PaperReads, and REQUIRES a source re-read for any
 *                           "unsupported"/"wrong" flag (§6.4).
 */

import type { PaperRead } from "../../../paper-graph/types.js";
import type { ReviewerVerdict, ReviewArtifactInput } from "./reviewer.js";
import type { RewriteInput } from "./rewriter.js";

export const REVIEWER_PROMPT_VERSION = "v1";
export const REWRITER_PROMPT_VERSION = "v1";

/** Human-readable "document type" phrase injected into the reviewer prompt. */
export function artifactKindLabel(
  kind: "wiki-page" | "effort-document" | "effort-readme" | "thread-survey",
): string {
  switch (kind) {
    case "wiki-page":
      return "wiki page";
    case "effort-document":
      return "research-effort document";
    case "effort-readme":
      return "reading-guide README";
    case "thread-survey":
      return "thread survey (a coherent narrative weaving several related results into a single methodological story)";
  }
}

// ── Reviewer prompt ────────────────────────────────────────────────────────────

/**
 * The reviewer prompt. The core "be a reader, not a checker" block is copied
 * verbatim from DESIGN-REFERENCE §6.3; only the document-type, topic and the
 * (optional) audience hint and artifact content are interpolated.
 */
export function buildReviewerPrompt(input: ReviewArtifactInput): string {
  const docType = artifactKindLabel(input.artifactKind);
  const audienceLine = input.audienceHint
    ? `\nThe intended audience for this document is: ${input.audienceHint}. Read it as a member of that audience would.\n`
    : "\n";

  // When the writer and reviewer are the same underlying model (set by the
  // orchestrator when modelPair.identical), inject an explicit self-review
  // preamble. This is a cheap mitigation for the well-known failure mode
  // where a single model rubber-stamps its own draft (the writer's word
  // choices feel "natural" to the reviewer because it WOULD HAVE written
  // them itself). The preamble names the conflict and asks the reviewer to
  // compensate. Not a substitute for true dual-model review — just a guard
  // for copilot-only / single-provider environments.
  const selfReviewPreamble = input.selfReviewMode
    ? `
⚠️  SELF-REVIEW MODE ⚠️
You are reviewing a draft that was written by THE SAME underlying model
you are now running on. This is structurally weaker than dual-model review,
because language you would HAVE WRITTEN tends to feel "right" to you even
when a different reader would have struggled.

Compensation rules — apply these AS YOU READ:
- Assume NOTHING the writer left implicit. If a step is "obvious to the writer",
  ask whether it is obvious to the stated audience. If not, flag 'skips-steps'.
- Treat every appeal to authority ("standard sieve theory", "by Bombieri-
  Vinogradov", "as is well-known") as a candidate 'unsupported' issue unless
  the document gives the reader a way to verify it (a citation, a derivation,
  or a sentence of context).
- Suspect your own first impression of "this reads fine". When you would
  approve, scan once more SPECIFICALLY for: notation defined before use,
  proof steps that move from claim to claim without intermediate justification,
  and statements that assume the reader already knows the answer.
- It is OK — expected, even — to request rewrites on documents that on a
  surface read seem competent. The bar is "an attentive grad student finishes
  with the intended understanding without frustration", not "the writer's
  internal logic is consistent with itself".

`
    : "";

  // Render prior-round verdicts as a "issues already addressed" block so the
  // reviewer doesn't re-flag the same things every rewrite round. Fix #4 from
  // run-13-audit: Run 13 spent $11+ on review-loop churn where each round
  // produced 15-20 NEW objections instead of converging — the reviewer was
  // stateless, so even when a rewrite addressed the previous issues the next
  // round invented fresh ones.
  const priorVerdicts = input.priorVerdicts ?? [];
  const priorVerdictsBlock =
    priorVerdicts.length === 0
      ? ""
      : `\n── Issues already raised on earlier drafts of this artifact ──\n` +
        priorVerdicts
          .map((v, idx) => {
            const lines = v.issues
              .slice(0, 20) // keep prompt bounded; the worst churn round capped at 30
              .map((iss, j) => `    ${j + 1}. [${iss.severity}/${iss.kind}] ${iss.what_you_experienced} (loc=${iss.location})`)
              .join("\n");
            return `  Round ${idx + 1} (${v.verdict}): ${v.overallReaderExperience}\n${lines}`;
          })
          .join("\n\n") +
        `\n\n` +
        `RULES for using the above:\n` +
        `  - If the writer's current draft has clearly fixed an issue from a prior round, DO NOT re-flag it.\n` +
        `  - Do NOT invent fresh objections at the same priority while there are unresolved blockers from earlier rounds — finish what was raised before opening new fronts.\n` +
        `  - You ARE free to flag GENUINELY new defects: things you only notice because earlier issues were addressed, or actual regressions introduced by the rewriter.\n` +
        `  - If the artifact now reads well to an attentive grad student, APPROVE. The goal is convergence, not perfection.\n`;

  return `You are reading a ${docType} on ${input.topic}. You are an attentive 
graduate student in this field, intelligent and patient, but not 
pre-loaded with the specialized knowledge of this exact subfield.
${audienceLine}${selfReviewPreamble}Your goal: read this document carefully from top to bottom, as a 
reader trying to learn. Track your experience honestly:

- Where did you understand easily?
- Where did you get confused, and what specifically confused you?
- Where did the author assume background you don't have?
- Where did a claim feel unsupported — you'd want to see the source 
  but the document didn't give you a way?
- Where did the prose drag, repeat, or feel padded?
- Where did the prose feel too dense, skipping steps?
- Are formulas clear? Notation consistent?
- Does the argument actually go somewhere, or wander?

You may have specialized knowledge from elsewhere — use it. If you 
spot a claim that looks technically wrong, flag it.

Critically: you are NOT checking off a rubric. You are READING. 
A document is "good enough" if a real, attentive grad-student-level 
reader would finish it with the intended understanding, without 
significant frustration.

── DOCUMENT TITLE ──
${input.artifactTitle}

── DOCUMENT CONTENT (read all of it) ──
${input.artifactContent}

── END OF DOCUMENT ──
${priorVerdictsBlock}
Output:
{
  "verdict": "approve" | "rewrite_requested",
  "overallReaderExperience": "<1-2 sentence high-level reaction>",
  "issues": [
    {
      "location": "<section heading + paragraph index>",
      "severity": "trivial" | "annoying" | "blocks-understanding",
      "kind": "vague" | "unsupported" | "skips-steps" | "wrong" | "redundant" | "off-topic" | "notation" | "other",
      "what_you_experienced": "<as a reader, what happened to you here>",
      "what_would_help": "<concrete suggestion>"
    }
  ],
  "verdict_reasoning": "<why approve or rewrite>"
}

Output ONLY valid JSON. No prose outside the JSON object.`;
}

// ── Rewriter prompt ────────────────────────────────────────────────────────────

/** Render one PaperRead's full source detail for the writer to RE-READ. */
export function renderPaperReadForRewrite(read: PaperRead): string {
  const lines: string[] = [];
  lines.push(`### Source PaperRead: ${read.paperId}${read.arxivId ? ` (arXiv:${read.arxivId})` : ""}`);
  lines.push(`One-line: ${read.skim.oneLineSummary}`);
  lines.push(`Main contribution: ${read.skim.mainContribution}`);
  const body = read.read;
  if (body) {
    lines.push("");
    lines.push("mainResults[] (cite these verbatim — do not paraphrase from memory):");
    body.mainResults.forEach((r, i) => {
      lines.push(`  - [${i + 1}] ${r.label} (@paper-read:${read.paperId}#mainResult-${i + 1})`);
      lines.push(`        statement: ${r.statement}`);
      lines.push(`        where: ${r.whereInPaper}`);
      lines.push(`        novelty: ${r.noveltyVsPrior}`);
    });
    lines.push(`proofStrategy: ${body.proofStrategy}`);
    if (body.keyTechniques.length > 0) {
      lines.push(`keyTechniques: ${body.keyTechniques.map((t) => `${t.name} (${t.role})`).join("; ")}`);
    }
    if (body.technicalDependencies.length > 0) {
      lines.push(
        `technicalDependencies: ${body.technicalDependencies
          .map((d) => `${d.claim} [${d.source}, ${d.whereUsed}]`)
          .join("; ")}`,
      );
    }
    if (body.hardSteps.length > 0) lines.push(`hardSteps: ${body.hardSteps.join("; ")}`);
  } else {
    lines.push("(only a skim is available for this source — no full read body)");
  }
  return lines.join("\n");
}

function renderIssues(verdict: ReviewerVerdict): string {
  if (verdict.issues.length === 0) return "(no specific issues itemised)";
  return verdict.issues
    .map(
      (it, i) =>
        `${i + 1}. [${it.severity}/${it.kind}] @ ${it.location}\n` +
        `   reader experienced: ${it.what_you_experienced}\n` +
        `   what would help:    ${it.what_would_help}`,
    )
    .join("\n");
}

/**
 * The rewriter prompt. Per §6.4 the writer is REQUIRED to re-fetch the source
 * for any "unsupported"/"wrong" flag — we surface that requirement explicitly
 * and always include the full PaperReads, never summaries.
 */
export function buildRewriterPrompt(input: RewriteInput): string {
  const docType = artifactKindLabel(input.artifactKind);
  const hasSourceCritical = input.reviewerVerdict.issues.some(
    (it) => it.kind === "unsupported" || it.kind === "wrong",
  );

  const sourceRecheckClause = hasSourceCritical
    ? `\nCRITICAL: the reviewer flagged content as "unsupported" or "wrong". You MUST 
re-read the relevant source PaperRead's mainResults[] below and ground your 
correction in the verbatim statement and its citation anchor 
(@paper-read:<paperId>#mainResult-<n>). Do NOT rewrite these claims from memory.\n`
    : "";

  const sources =
    input.sourcePaperReads.length > 0
      ? input.sourcePaperReads.map(renderPaperReadForRewrite).join("\n\n")
      : "(no source PaperReads supplied)";

  return `You are the writer revising a ${docType} on ${input.topic} after a careful 
reader reviewed it. A second model read your draft as an attentive graduate 
student and reported where it tripped them up.

── REVIEWER'S OVERALL REACTION ──
${input.reviewerVerdict.overallReaderExperience}

── REVIEWER'S ISSUES ──
${renderIssues(input.reviewerVerdict)}

── REVIEWER'S REASONING ──
${input.reviewerVerdict.verdictReasoning}
${sourceRecheckClause}
── FULL SOURCE PAPER-READS (re-read these; cite them, do not invent) ──
${sources}

── YOUR ORIGINAL DRAFT ──
${input.originalContent}

── END OF ORIGINAL DRAFT ──

Your task:
- Address EVERY "blocks-understanding" issue.
- Address "annoying" issues wherever a reasonable fix exists.
- "trivial" issues are optional.
- PRESERVE the parts the reviewer did not complain about — do not rewrite the
  whole thing for the sake of it, and keep all correct citation anchors.
- For any "unsupported" or "wrong" flag, ground the fix in the source
  PaperRead's mainResults[] above (re-read, then rewrite).

Output the COMPLETE rewritten ${docType} as markdown. Output ONLY the markdown
document — no JSON, no commentary, no fences around the whole thing.`;
}
