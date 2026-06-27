/**
 * Effort Synthesis — Task 25: notes/agent-reading-notes.md generator.
 *
 * NO LLM call. Pure, deterministic rendering of a `PaperRead.json` into the
 * human-readable markdown mirror described in DESIGN-REFERENCE.md §5.3. This is
 * dual-purpose: a human verifies the agent read correctly, and other efforts
 * cite into it via `@paper-read:<paper-id>#mainResult-N`.
 *
 * If a PaperRead stopped at the skim pass (decision: discard), only the skim
 * section is rendered plus a "discarded at skim" note.
 */

import type { PaperRead } from "../../../paper-graph/types.js";

/** Human-readable regime label derived from the PaperRead's source kind. */
function regimeLabel(read: PaperRead): string {
  switch (read.sourceKind) {
    case "tex": return "A (LaTeX source)";
    case "pdf-text": return "B (extracted PDF text)";
    case "html": return "C (HTML)";
    case "abstract-only": return "D (abstract only)";
    default: return read.sourceKind;
  }
}

function header(read: PaperRead): string {
  const id = read.arxivId ?? read.doi ?? read.paperId;
  const title = read.skim.oneLineSummary || read.paperId;
  const lines = [
    `# Reading Notes — ${title} (${id})`,
    "",
    `**Read on:** ${read.updatedAt}`,
    `**Model:** ${read.modelUsed}`,
    `**Regime:** ${regimeLabel(read)} (source ${read.sourceBytes} bytes${read.truncated ? ", truncated" : ""})`,
  ];
  if (read.audit) {
    lines.push(`**Audit verdict:** ${read.audit.verdict} (score ${read.audit.score ?? "?"}/10)`);
  }
  return lines.join("\n");
}

function skimSection(read: PaperRead): string {
  const s = read.skim;
  return [
    "## Pass 1: Skim impression",
    s.oneLineSummary,
    "",
    `**Main contribution:** ${s.mainContribution}`,
    "",
    `**Decision:** ${s.decision} — ${s.decisionReason}`,
  ].join("\n");
}

function readSection(read: PaperRead): string {
  const b = read.read!;
  const id = read.arxivId ?? read.paperId;
  const out: string[] = ["## Pass 2: Read findings", "", "### Main results"];
  if (b.mainResults.length === 0) {
    out.push("_(none recorded)_");
  } else {
    b.mainResults.forEach((r, i) => {
      out.push(`**${r.label}** _(\`@paper-read:${id}#mainResult-${i + 1}\`)_`);
      out.push("");
      out.push(r.statement);
      out.push("");
      out.push(`*Where:* ${r.whereInPaper}`);
      if (r.noveltyVsPrior) out.push(`*Novelty vs prior:* ${r.noveltyVsPrior}`);
      out.push("");
    });
  }

  out.push("### Proof strategy", b.proofStrategy || "_(none recorded)_", "");

  out.push("### Key techniques used");
  if (b.keyTechniques.length === 0) out.push("_(none recorded)_");
  else b.keyTechniques.forEach((t) => out.push(`- **${t.name}** — ${t.role}`));
  out.push("");

  out.push("### Technical dependencies");
  if (b.technicalDependencies.length === 0) out.push("_(none recorded)_");
  else b.technicalDependencies.forEach((d) => out.push(`- ${d.claim} — *${d.source}* (${d.whereUsed})`));
  out.push("");

  out.push("### Novel contributions", b.novelContributions || "_(none recorded)_", "");
  out.push("### Standard material", b.standardMaterial || "_(none recorded)_", "");

  out.push("### Hard steps");
  if (b.hardSteps.length === 0) out.push("_(none recorded)_");
  else b.hardSteps.forEach((h) => out.push(`- ${h}`));

  return out.join("\n");
}

function auditSection(read: PaperRead): string {
  const a = read.audit!;
  return [
    "## Pass 3: Rigor audit",
    `**Verdict:** ${a.verdict} (${a.score ?? "?"}/10)`,
    `**Flags:** ${a.flags.length > 0 ? a.flags.join(", ") : "(none)"}`,
    `**Notes:** ${a.reason ?? "(none)"}`,
    `**Sections audited:** ${a.sourceRead ?? "(unspecified)"}`,
  ].join("\n");
}

function citationsSection(read: PaperRead): string {
  const out: string[] = ["## Outgoing citations harvested"];
  if (read.outgoingCitations.length === 0) {
    out.push("_(none harvested)_");
    return out.join("\n");
  }
  for (const c of read.outgoingCitations) {
    const title = c.citedTitle ?? c.citedArxivId ?? c.citedDoi ?? "(untitled)";
    const year = c.citedYear != null ? ` (${c.citedYear})` : "";
    out.push(`- [${c.importanceToThisPaper}] — ${title}${year} — ${c.contextInThisPaper}`);
  }
  return out.join("\n");
}

/**
 * Render a PaperRead into the markdown reading-notes document. Deterministic;
 * no LLM call.
 */
export function renderReadingNotes(read: PaperRead): string {
  const parts: string[] = [header(read), "", skimSection(read)];

  const discarded = read.skim.decision === "discard" || !read.read;
  if (discarded) {
    parts.push("", "## (no further passes — discarded at skim)");
    return parts.join("\n").trimEnd() + "\n";
  }

  parts.push("", readSection(read));
  if (read.audit) parts.push("", auditSection(read));
  parts.push("", citationsSection(read));
  return parts.join("\n").trimEnd() + "\n";
}
