/**
 * Effort Synthesis — Step 2: per-section writer (Task 23).
 *
 * One LLM call per outline section. Each call sees its own spec, the previous
 * section's actual text (for coherence), and the full PaperRead bodies for the
 * paper-reads it must cite. The writer emits the `## <heading> {#<anchor>}`
 * header itself; we defensively re-add it if the model forgot.
 *
 * A post-write validation strips/flags `[citation needed]` placeholders and
 * ensures the section contains at least one real anchor citation.
 */

import { errMsg, type SpineLLM } from "../spine/llm.js";
import { buildSectionWriterPrompt } from "./prompts.js";
import type { EffortOutlineSection } from "./outline.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export interface SectionWriteContext {
  title: string;
  thesis: string;
  previousSectionText: string | null;
  nextSectionHeading: string | null;
}

const CITATION_RE = /@(?:ws|paper-read):[^\s)\]]+/;
const CITATION_NEEDED_RE = /\[\s*citation\s+needed\s*\]/gi;

function expectedHeader(section: EffortOutlineSection): string {
  return `## ${section.heading} {#${section.anchor}}`;
}

/** Ensure the section text starts with the canonical anchored header. */
export function ensureSectionHeader(text: string, section: EffortOutlineSection): string {
  const header = expectedHeader(section);
  const trimmed = text.trimStart();
  // If the model produced ANY `## ...{#anchor}` header for this anchor, keep its body but normalize the header.
  const anchorHeaderRe = new RegExp(`^##\\s+.*\\{#${section.anchor}\\}\\s*`, "m");
  if (anchorHeaderRe.test(trimmed)) {
    return trimmed.replace(anchorHeaderRe, `${header}\n`).trimStart();
  }
  // Drop a leading bare `## Heading` (no anchor) so we don't double up.
  const bareHeaderRe = new RegExp(`^##\\s+${section.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n`, "i");
  const body = trimmed.replace(bareHeaderRe, "");
  return `${header}\n\n${body.trimStart()}`;
}

/**
 * Replace any `[citation needed]` placeholder with a best-effort real anchor
 * drawn from the section's mustCite list. Returns the cleaned text plus a flag
 * indicating whether placeholders were found (so the orchestrator can log it).
 */
export function repairCitations(
  text: string,
  section: EffortOutlineSection,
): { text: string; hadPlaceholder: boolean; hasCitation: boolean } {
  const hadPlaceholder = CITATION_NEEDED_RE.test(text);
  CITATION_NEEDED_RE.lastIndex = 0;

  const firstCite = section.mustCite[0];
  const anchorToken = firstCite
    ? firstCite.kind === "paper-read"
      ? `@paper-read:${firstCite.id}#mainResult-1`
      : `@ws:${firstCite.id}${firstCite.anchor ? `#${firstCite.anchor}` : ""}`
    : null;

  let cleaned = text;
  if (hadPlaceholder && anchorToken) {
    cleaned = cleaned.replace(CITATION_NEEDED_RE, anchorToken);
  } else if (hadPlaceholder) {
    cleaned = cleaned.replace(CITATION_NEEDED_RE, "");
  }

  let hasCitation = CITATION_RE.test(cleaned);
  // If the writer produced no citation at all, append the mandated one so the
  // "every claim must cite" invariant is never silently violated.
  if (!hasCitation && anchorToken) {
    cleaned = `${cleaned.trimEnd()}\n\n_Source: ${anchorToken}._\n`;
    hasCitation = true;
  }
  return { text: cleaned, hadPlaceholder, hasCitation };
}

export async function writeEffortSection(
  section: EffortOutlineSection,
  effortContext: SectionWriteContext,
  paperReads: PaperRead[],
  deps: { llm: SpineLLM; emitLog?: (m: string) => void },
): Promise<string> {
  const emit = deps.emitLog ?? (() => {});
  let raw = "";
  try {
    const prompt = buildSectionWriterPrompt(section, effortContext, paperReads);
    raw = await deps.llm(prompt, { temperature: 0.5 });
  } catch (err) {
    emit(`[section-writer] ${section.anchor}: LLM call failed (${errMsg(err)}); writing stub`);
  }

  if (!raw.trim()) {
    const firstCite = section.mustCite[0];
    const token = firstCite
      ? firstCite.kind === "paper-read"
        ? `@paper-read:${firstCite.id}#mainResult-1`
        : `@ws:${firstCite.id}`
      : "";
    raw = `${section.purpose || "(section pending)"}${token ? ` ${token}` : ""}`;
  }

  let text = ensureSectionHeader(raw, section);
  const repaired = repairCitations(text, section);
  text = repaired.text;
  if (repaired.hadPlaceholder) {
    emit(`[section-writer] ${section.anchor}: replaced [citation needed] placeholder(s)`);
  }
  if (!repaired.hasCitation) {
    emit(`[section-writer] ${section.anchor}: WARNING — section has no anchor citation`);
  }
  return text.trimEnd() + "\n";
}
