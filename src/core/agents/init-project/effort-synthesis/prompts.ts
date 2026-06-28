/**
 * Effort Synthesis — prompt builders (Phase 5 / Tasks 22-24).
 *
 * Three LLM-driven steps build the per-effort `document.md`:
 *   1. outline call  (buildEffortOutlinePrompt)   — LLM decides the section
 *      structure (NOT a fixed 7-point template).
 *   2. per-section write (buildSectionWriterPrompt) — one call per section,
 *      with the previous section's text for coherence.
 *   3. README reading-guide (buildReadmePrompt).
 *
 * The PaperRead body (structured notes, not raw .tex) is rendered into the
 * prompt so the writer cites `@paper-read:<id>#mainResult-N` and reproduces
 * verbatim LaTeX statements.
 */

import type { NarrativeSpine, SpineNode } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";
import type { EffortOutlineSection } from "./outline.js";

/** Compact one-PaperRead summary used in the outline prompt. */
export function renderPaperReadSummary(read: PaperRead): string {
  const id = read.arxivId ?? read.paperId;
  const lines: string[] = [];
  lines.push(`### paper-read \`${id}\` (paperId: ${read.paperId})`);
  lines.push(`- one-line: ${read.skim.oneLineSummary}`);
  lines.push(`- main contribution: ${read.skim.mainContribution}`);
  lines.push(`- skim decision: ${read.skim.decision}`);
  if (read.read) {
    if (read.read.mainResults.length > 0) {
      lines.push(`- main results (cite as @paper-read:${id}#mainResult-N):`);
      read.read.mainResults.forEach((r, i) => {
        lines.push(`    - mainResult-${i + 1}: **${r.label}** — ${r.statement} (${r.whereInPaper})`);
      });
    }
    lines.push(`- proof strategy: ${read.read.proofStrategy}`);
    if (read.read.keyTechniques.length > 0) {
      lines.push(`- techniques: ${read.read.keyTechniques.map((t) => t.name).join(", ")}`);
    }
  }
  return lines.join("\n");
}

/** Fuller PaperRead rendering for the section writer (includes hard steps, deps). */
export function renderPaperReadBodyForWriter(read: PaperRead): string {
  const id = read.arxivId ?? read.paperId;
  const lines: string[] = [];
  lines.push(`### paper-read \`${id}\``);
  lines.push(`Cite this paper's results as \`@paper-read:${id}#mainResult-N\`.`);
  lines.push(`One-line: ${read.skim.oneLineSummary}`);
  lines.push(`Main contribution: ${read.skim.mainContribution}`);
  if (read.read) {
    lines.push("");
    lines.push("Main results (VERBATIM LaTeX — reproduce statements exactly, no \\cdots truncation):");
    read.read.mainResults.forEach((r, i) => {
      lines.push(`- mainResult-${i + 1} (${r.label}, ${r.whereInPaper}): ${r.statement}`);
      if (r.noveltyVsPrior) lines.push(`    novelty: ${r.noveltyVsPrior}`);
    });
    lines.push(`Proof strategy: ${read.read.proofStrategy}`);
    if (read.read.keyTechniques.length > 0) {
      lines.push("Key techniques:");
      read.read.keyTechniques.forEach((t) => lines.push(`- ${t.name}: ${t.role}`));
    }
    if (read.read.technicalDependencies.length > 0) {
      lines.push("Technical dependencies:");
      read.read.technicalDependencies.forEach((d) => lines.push(`- ${d.claim} (${d.source}, ${d.whereUsed})`));
    }
    if (read.read.novelContributions) lines.push(`Novel contributions: ${read.read.novelContributions}`);
    if (read.read.standardMaterial) lines.push(`Standard material: ${read.read.standardMaterial}`);
    if (read.read.hardSteps.length > 0) {
      lines.push("Hard steps:");
      read.read.hardSteps.forEach((h) => lines.push(`- ${h}`));
    }
  }
  return lines.join("\n");
}

function renderNeighbours(label: string, nodes: SpineNode[]): string {
  if (nodes.length === 0) return `${label}: (none)`;
  return `${label}:\n${nodes.map((n) => `- effort \`${n.id}\`: ${n.title} — ${n.significance}`).join("\n")}`;
}

export function buildEffortOutlinePrompt(
  node: SpineNode,
  paperReads: PaperRead[],
  spineContext: { spine: NarrativeSpine; predecessors: SpineNode[]; successors: SpineNode[] },
): string {
  const reads = paperReads.map(renderPaperReadSummary).join("\n\n") || "(no paper-reads available)";
  const readIds = paperReads.map((r) => r.arxivId ?? r.paperId);
  const predIds = spineContext.predecessors.map((n) => n.id);

  return `You are planning the structure of ONE survey-effort document about a single milestone in the research problem "${spineContext.spine.globalThesis}".

SPINE NODE (this effort):
- id: ${node.id}
- title: ${node.title}
- type: ${node.type}
- statement (LaTeX): ${node.statement}
- significance: ${node.significance}
${node.proofIdea ? `- proof idea: ${node.proofIdea}` : ""}

${renderNeighbours("PREDECESSOR EFFORTS (what this builds on)", spineContext.predecessors)}

${renderNeighbours("SUCCESSOR EFFORTS (what builds on this)", spineContext.successors)}

PRIMARY PAPER-READS (the agent's structured notes):
${reads}

TASK: Decide what sections THIS effort's document should have. Do NOT use a fixed template — choose the structure that best fits this particular result. A bridge effort reads differently from a dead-end or a core-technique effort.

Rules:
- Produce between 3 and 10 sections (inclusive).
- Each section MUST cite at least one source in "mustCite": either a paper-read (kind:"paper-read", id from ${JSON.stringify(readIds)}) OR a predecessor effort (kind:"effort", id from ${JSON.stringify(predIds)}).
- "anchor" must be url-safe (lowercase, hyphens, no spaces).
- "narrativeRole" must be ONE of the following, preferring the verb-first roles whenever they describe what move this effort makes:
    • opens_thread       — this paper STARTS a new line of attack / introduces a technique
    • refines_constant   — this paper TIGHTENS a bound, constant, or proof produced by a predecessor
    • unifies_approaches — this paper TIES together two previously-separate lines
    • closes_thread      — this paper KILLS a thread (proves it can't reach the target, or supersedes it)
    • reveals_barrier    — this paper SHOWS WHY further progress is blocked along this line
    • open_direction     — this paper SUGGESTS a direction whose verdict is still open
  (Back-compat noun-shapes also accepted: core_technique, application, generalization, background, dead_end.
  Pick a noun-shape ONLY when no verb above honestly fits.)

Choose the verb that a working number-theorist would use when telling a colleague "this paper does X" in one verb.

Output ONLY JSON of this exact shape:
{
  "title": "string",
  "thesis": "1-2 sentence statement of what this effort is",
  "narrativeRole": "opens_thread",
  "sections": [
    {
      "heading": "string",
      "anchor": "url-safe-id",
      "purpose": "1 sentence",
      "targetParagraphs": 2,
      "mustCite": [ { "kind": "paper-read", "id": "${readIds[0] ?? "some-id"}" } ]
    }
  ]
}`;
}

export function buildSectionWriterPrompt(
  section: EffortOutlineSection,
  effortContext: { title: string; thesis: string; previousSectionText: string | null; nextSectionHeading: string | null },
  paperReads: PaperRead[],
): string {
  const cited = new Set(section.mustCite.filter((c) => c.kind === "paper-read").map((c) => c.id));
  const relevant = paperReads.filter((r) => cited.has(r.arxivId ?? r.paperId));
  const reads = (relevant.length > 0 ? relevant : paperReads).map(renderPaperReadBodyForWriter).join("\n\n")
    || "(no paper-reads available)";

  const prevText = effortContext.previousSectionText
    ? `PREVIOUS SECTION (for coherence — do not repeat it, continue from it):\n"""\n${effortContext.previousSectionText.slice(0, 4000)}\n"""`
    : "(this is the first section)";

  const mustCiteList = section.mustCite
    .map((c) => (c.kind === "paper-read" ? `@paper-read:${c.id}` : `@ws:${c.id}${c.anchor ? `#${c.anchor}` : ""}`))
    .join(", ");

  return `You are writing ONE section of a survey-effort document titled "${effortContext.title}".

EFFORT THESIS: ${effortContext.thesis}

THIS SECTION:
- heading: ${section.heading}
- anchor: ${section.anchor}
- purpose: ${section.purpose}
- target length: ${section.targetParagraphs} paragraph(s)
- MUST cite: ${mustCiteList}
${effortContext.nextSectionHeading ? `- next section will be: "${effortContext.nextSectionHeading}" (do not write it; lead into it at most)` : "- this is the final section"}

${prevText}

SOURCE PAPER-READS:
${reads}

RULES:
- Write ${section.targetParagraphs} paragraph(s) of markdown prose (1-3 typically). Respect the budget.
- EVERY substantive claim MUST carry an inline citation: either \`@ws:<effort-id>#<anchor>\` OR \`@paper-read:<paper-id>#mainResult-N\`. Do NOT leave uncited claims and never emit a bare "[citation needed]".
- Reproduce theorem/lemma statements as VERBATIM LaTeX (use $...$ / $$...$$). Never abbreviate a statement with \\cdots.
- Do NOT invent results not present in the paper-reads.

Begin the section with EXACTLY this header line and nothing before it:
## ${section.heading} {#${section.anchor}}

Output ONLY the markdown for this one section.`;
}

export function buildReadmePrompt(
  node: SpineNode,
  document: string,
  paperReads: PaperRead[],
  spineContext: { problemTitle: string; predecessors: SpineNode[]; successors: SpineNode[] },
): string {
  const provenance = paperReads
    .map((r) => `- ${r.arxivId ?? r.paperId} (sourceKind: ${r.sourceKind}, ${r.sourceBytes} bytes): ${r.skim.oneLineSummary}`)
    .join("\n") || "- (no paper-reads)";
  const prereqs = spineContext.predecessors.map((n) => `- @ws:${n.id} — ${n.title}`).join("\n") || "- (none)";
  const related = spineContext.successors.map((n) => `- @ws:${n.id} — ${n.title}`).join("\n") || "- (none)";

  return `You are the agent who just read the source papers and wrote the effort document below. Now write a README.md that introduces this effort to a human reader. Good writing means making the reader understand quickly.

EFFORT: "${node.title}" (part of the project "${spineContext.problemTitle}")

PREDECESSOR EFFORTS (possible prerequisites):
${prereqs}

SUCCESSOR / RELATED EFFORTS (cover separate ground):
${related}

SOURCE PROVENANCE:
${provenance}

THE DOCUMENT YOU WROTE (document.md):
"""
${document.slice(0, 12000)}
"""

Write a markdown README with these sections (you may adapt wording, but hit every beat):

# ${node.title} — Reading Guide

## What this is
1-2 sentences.

## Why it matters in ${spineContext.problemTitle}
1 paragraph.

## Prerequisites for reading document.md
Link specific prior efforts (use @ws:<id>) and state the math background expected.

## What the agent noticed while reading
At least ONE specific, concrete observation grounded in the actual papers — e.g. a typo, a missing motivation, a notational clash, a comparison point, an unstated assumption. This is the informal margin note that shows judgment. Do NOT write generic filler like "this is an interesting result" or "the proofs are technical"; be specific to THIS material.

## What's NOT in this effort
Cross-reference related efforts that cover adjacent but separate ground.

## Source provenance
Which papers (with ids) this effort distills, and the source kind (tex / pdf / ocr / vendored).

Output ONLY the markdown README.`;
}
