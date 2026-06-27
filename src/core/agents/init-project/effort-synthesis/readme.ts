/**
 * Effort Synthesis — Task 24: README.md reading-guide generator.
 *
 * One LLM call per effort, after document.md is written. The README is the
 * agent introducing the effort to a human; the "What the agent noticed while
 * reading" section is the point — it must contain ≥1 concrete observation, not
 * pablum. We validate that section is present and non-trivial, and fall back to
 * a deterministic guide that synthesizes an observation from the PaperReads if
 * the LLM omits it.
 */

import { errMsg, type SpineLLM } from "../spine/llm.js";
import { buildReadmePrompt } from "./prompts.js";
import type { SpineNode } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export interface ReadmeSpineContext {
  problemTitle: string;
  predecessors: SpineNode[];
  successors: SpineNode[];
}

const NOTICED_HEADING_RE = /^##\s+what the agent noticed.*$/im;

/** Extract the body of the "What the agent noticed" section, if present. */
export function extractNoticedSection(readme: string): string | null {
  const m = NOTICED_HEADING_RE.exec(readme);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = readme.slice(start);
  const next = /^##\s+/m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  return body;
}

const PABLUM = [
  "this is an interesting result",
  "the proofs are technical",
  "the paper is well written",
  "nothing in particular",
  "no specific observations",
  "n/a",
  "none",
];

/** A "noticed" section is acceptable if it's non-empty and not generic filler. */
export function noticedSectionIsSpecific(body: string | null): boolean {
  if (!body) return false;
  const stripped = body.replace(/^[-*]\s*/gm, "").trim();
  if (stripped.length < 40) return false;
  const lower = stripped.toLowerCase();
  if (PABLUM.some((p) => lower === p || lower === p + ".")) return false;
  return true;
}

/** Deterministic fallback observation derived from the PaperReads. */
function fallbackNoticed(paperReads: PaperRead[]): string {
  const observations: string[] = [];
  for (const r of paperReads) {
    const id = r.arxivId ?? r.paperId;
    if (r.truncated) {
      observations.push(`- The source for \`${id}\` was truncated (${r.sourceBytes} bytes, sourceKind \`${r.sourceKind}\`), so coverage of later sections relies on the skim rather than a full read.`);
    }
    if (r.audit && r.audit.flags.length > 0) {
      observations.push(`- The rigor audit of \`${id}\` flagged: ${r.audit.flags.join(", ")} (verdict \`${r.audit.verdict}\`).`);
    }
    if (r.read && r.read.hardSteps.length > 0) {
      observations.push(`- In \`${id}\`, the load-bearing step is: ${r.read.hardSteps[0]}`);
    }
  }
  if (observations.length === 0 && paperReads.length > 0) {
    const r = paperReads[0];
    observations.push(`- Reading \`${r.arxivId ?? r.paperId}\`: ${r.skim.mainContribution}`);
  }
  if (observations.length === 0) {
    observations.push("- No source paper-reads were available for this effort, so this guide is structural only.");
  }
  return observations.slice(0, 3).join("\n");
}

function fallbackReadme(
  node: SpineNode,
  paperReads: PaperRead[],
  spineContext: ReadmeSpineContext,
): string {
  const prereqs = spineContext.predecessors.length > 0
    ? spineContext.predecessors.map((n) => `- @ws:${n.id} — ${n.title}`).join("\n")
    : "- None — this effort is self-contained.";
  const notIn = spineContext.successors.length > 0
    ? spineContext.successors.map((n) => `- @ws:${n.id} — ${n.title}`).join("\n")
    : "- See sibling efforts for adjacent results.";
  const provenance = paperReads.length > 0
    ? paperReads.map((r) => `- ${r.arxivId ?? r.paperId} — source kind \`${r.sourceKind}\` (${r.sourceBytes} bytes)`).join("\n")
    : "- (no paper sources recorded)";

  return [
    `# ${node.title} — Reading Guide`,
    "",
    "## What this is",
    node.significance || node.statement.slice(0, 200),
    "",
    `## Why it matters in ${spineContext.problemTitle}`,
    node.significance || `A milestone in ${spineContext.problemTitle}.`,
    "",
    "## Prerequisites for reading document.md",
    prereqs,
    "",
    "## What the agent noticed while reading",
    fallbackNoticed(paperReads),
    "",
    "## What's NOT in this effort",
    notIn,
    "",
    "## Source provenance",
    provenance,
    "",
  ].join("\n");
}

export async function generateEffortReadme(
  node: SpineNode,
  document: string,
  paperReads: PaperRead[],
  spineContext: ReadmeSpineContext,
  deps: { llm: SpineLLM; emitLog?: (m: string) => void },
): Promise<string> {
  const emit = deps.emitLog ?? (() => {});
  let readme = "";
  try {
    const prompt = buildReadmePrompt(node, document, paperReads, spineContext);
    readme = await deps.llm(prompt, { temperature: 0.6 });
  } catch (err) {
    emit(`[effort-readme] ${node.id}: LLM call failed (${errMsg(err)}); using fallback`);
  }

  const noticed = extractNoticedSection(readme);
  if (!readme.trim() || !noticedSectionIsSpecific(noticed)) {
    if (readme.trim()) {
      emit(`[effort-readme] ${node.id}: "What the agent noticed" was missing/pablum; injecting concrete observation`);
      // Try to splice a real observation into the existing README rather than discard it.
      const fallbackObs = fallbackNoticed(paperReads);
      if (NOTICED_HEADING_RE.test(readme)) {
        const m = NOTICED_HEADING_RE.exec(readme)!;
        const start = m.index + m[0].length;
        const rest = readme.slice(start);
        const next = /^##\s+/m.exec(rest);
        const after = next ? rest.slice(next.index) : "";
        return `${readme.slice(0, start)}\n${fallbackObs}\n\n${after}`.trimEnd() + "\n";
      }
      return `${readme.trimEnd()}\n\n## What the agent noticed while reading\n${fallbackObs}\n`;
    }
    return fallbackReadme(node, paperReads, spineContext);
  }
  return readme.trimEnd() + "\n";
}
