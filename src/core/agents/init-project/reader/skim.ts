/**
 * skim.ts — Pass 1 of 3: skim the paper.
 *
 * The LLM sees: title, authors, year, abstract, section outline, intro
 * (first ~3KB) and conclusion (last ~2KB). It returns a PaperReadSkim
 * verdict: "study" / "skim_sufficient" / "discard".
 *
 * Never throws — on LLM failure (or malformed output) returns a conservative
 * "study" skim with a decisionReason explaining the fallback.
 */

import type { PaperNode, PaperReadSkim } from "../../../paper-graph/types.js";
import type { SpineLLM } from "../spine/llm.js";
import { extractSpineJSON } from "../spine/llm.js";
import type { LoadedSource } from "./source-loader.js";
import { buildSkimPrompt } from "./prompts.js";

const INTRO_BYTES = 3000;
const CONCLUSION_BYTES = 2000;

export interface SkimDeps {
  llm: SpineLLM;
  /** When the source has section markers, use them as outline; else, parse outline from text. */
  emitLog?: (message: string) => void;
}

type RawSkim = Partial<PaperReadSkim> & Record<string, unknown>;

const VALID_DECISIONS: ReadonlyArray<PaperReadSkim["decision"]> = [
  "study",
  "skim_sufficient",
  "discard",
];

/** First ~3KB of text (or the whole thing if shorter). */
function introExcerptOf(text: string): string {
  if (text.length <= INTRO_BYTES) return text;
  return text.slice(0, INTRO_BYTES);
}

/** Last ~2KB of text, only when the text is long enough to have a distinct tail. */
function conclusionExcerptOf(text: string): string {
  if (text.length <= INTRO_BYTES) return "";
  return text.slice(Math.max(0, text.length - CONCLUSION_BYTES));
}

function studyFallback(reason: string, paper: PaperNode, source: LoadedSource): PaperReadSkim {
  return {
    oneLineSummary: (paper.title ?? "").slice(0, 200),
    mainContribution: paper.abstract?.trim() ?? "",
    sectionOutline: (source.sectionMarkers ?? []).map((m) => ({ level: m.level, title: m.title })),
    decision: "study",
    decisionReason: reason,
  };
}

/**
 * Pass 1 of 3: skim the paper.
 * Returns a PaperReadSkim verdict on whether to "study", consider
 * "skim_sufficient", or "discard". Never throws.
 */
export async function skimPaper(
  paper: PaperNode,
  source: LoadedSource,
  deps: SkimDeps,
): Promise<PaperReadSkim> {
  const introExcerpt = introExcerptOf(source.text);
  const conclusionExcerpt = conclusionExcerptOf(source.text);
  const outline = (source.sectionMarkers ?? []).map((m) => ({ level: m.level, title: m.title }));

  const prompt = buildSkimPrompt(paper, source.kind, outline, introExcerpt, conclusionExcerpt);

  let reply: string;
  try {
    reply = await deps.llm(prompt, { temperature: 0.1, maxTokens: 1500 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.emitLog?.(`skimPaper: LLM call failed, falling back to "study" (${msg})`);
    return studyFallback(`fallback: LLM call failed (${msg})`, paper, source);
  }

  const parsed = extractSpineJSON<RawSkim>(reply);
  if (!parsed || typeof parsed !== "object") {
    deps.emitLog?.('skimPaper: malformed LLM output, falling back to "study"');
    return studyFallback("fallback: LLM returned malformed (non-JSON) output", paper, source);
  }

  const decision: PaperReadSkim["decision"] =
    typeof parsed.decision === "string" &&
    VALID_DECISIONS.includes(parsed.decision as PaperReadSkim["decision"])
      ? (parsed.decision as PaperReadSkim["decision"])
      : "study";

  const decisionReason =
    typeof parsed.decisionReason === "string" && parsed.decisionReason.trim().length > 0
      ? parsed.decisionReason
      : decision === "study" && parsed.decision !== "study"
        ? "fallback: LLM omitted/invalid decision; defaulted to study"
        : "";

  const sectionOutline: PaperReadSkim["sectionOutline"] = Array.isArray(parsed.sectionOutline)
    ? parsed.sectionOutline
        .filter(
          (s): s is { level: 1 | 2 | 3; title: string } =>
            !!s &&
            typeof (s as { title?: unknown }).title === "string" &&
            [1, 2, 3].includes((s as { level?: unknown }).level as number),
        )
        .map((s) => ({ level: s.level, title: s.title }))
    : outline;

  return {
    oneLineSummary:
      typeof parsed.oneLineSummary === "string" ? parsed.oneLineSummary.slice(0, 200) : "",
    mainContribution: typeof parsed.mainContribution === "string" ? parsed.mainContribution : "",
    sectionOutline,
    decision,
    decisionReason,
  };
}
