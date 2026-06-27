/**
 * Reviewer model (DESIGN-REFERENCE §6.1-6.3).
 *
 * The reviewer reads an artifact AS AN ATTENTIVE GRADUATE STUDENT WOULD and
 * reports its honest reading experience as a `ReviewerVerdict`. This is the
 * "behaviour beats checklists" replacement for the old rubric scorer in
 * review-verify.ts.
 *
 * The reviewer LLM is intentionally a SEPARATE model from the writer (default
 * writer = gpt-5.5, default reviewer = opus-4.8 per §6.7).
 */

import { extractSpineJSON, errMsg, type SpineLLM } from "../spine/llm.js";
import { buildReviewerPrompt } from "./prompts.js";

export type ReviewSeverity = "trivial" | "annoying" | "blocks-understanding";

export type ReviewKind =
  | "vague"
  | "unsupported"
  | "skips-steps"
  | "wrong"
  | "redundant"
  | "off-topic"
  | "notation"
  | "other";

export interface ReviewIssue {
  location: string;
  severity: ReviewSeverity;
  kind: ReviewKind;
  what_you_experienced: string;
  what_would_help: string;
}

export interface ReviewerVerdict {
  verdict: "approve" | "rewrite_requested";
  overallReaderExperience: string;
  issues: ReviewIssue[];
  verdictReasoning: string;
}

export interface ReviewArtifactInput {
  artifactKind: "wiki-page" | "effort-document" | "effort-readme";
  artifactTitle: string;
  artifactSlug: string;
  /** FULL content, no slicing — the reviewer reads everything. */
  artifactContent: string;
  /** The project's problem title. */
  topic: string;
  /** e.g. "graduate-student-entering-field" from the WikiPlan. */
  audienceHint?: string;
}

export interface ReviewArtifactDeps {
  emitLog?: (m: string) => void;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set<ReviewSeverity>([
  "trivial",
  "annoying",
  "blocks-understanding",
]);
const VALID_KINDS: ReadonlySet<string> = new Set<ReviewKind>([
  "vague",
  "unsupported",
  "skips-steps",
  "wrong",
  "redundant",
  "off-topic",
  "notation",
  "other",
]);

function coerceSeverity(v: unknown): ReviewSeverity {
  return typeof v === "string" && VALID_SEVERITIES.has(v) ? (v as ReviewSeverity) : "annoying";
}

function coerceKind(v: unknown): ReviewKind {
  return typeof v === "string" && VALID_KINDS.has(v) ? (v as ReviewKind) : "other";
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

interface RawIssue {
  location?: unknown;
  severity?: unknown;
  kind?: unknown;
  what_you_experienced?: unknown;
  whatYouExperienced?: unknown;
  what_would_help?: unknown;
  whatWouldHelp?: unknown;
}

interface RawVerdict {
  verdict?: unknown;
  overallReaderExperience?: unknown;
  overall_reader_experience?: unknown;
  issues?: unknown;
  verdictReasoning?: unknown;
  verdict_reasoning?: unknown;
}

/** Defensively normalize the LLM JSON into a well-formed `ReviewerVerdict`. */
export function normalizeVerdict(raw: RawVerdict | null): ReviewerVerdict {
  const issuesArr = Array.isArray(raw?.issues) ? (raw!.issues as RawIssue[]) : [];
  const issues: ReviewIssue[] = issuesArr.map((it) => ({
    location: str(it?.location, "(unspecified)"),
    severity: coerceSeverity(it?.severity),
    kind: coerceKind(it?.kind),
    what_you_experienced: str(it?.what_you_experienced ?? it?.whatYouExperienced),
    what_would_help: str(it?.what_would_help ?? it?.whatWouldHelp),
  }));

  // A verdict is "approve" only if the LLM said so AND there is no
  // blocks-understanding issue. Otherwise we treat it as a rewrite request.
  const rawVerdict = raw?.verdict;
  const blocks = issues.some((i) => i.severity === "blocks-understanding");
  let verdict: "approve" | "rewrite_requested";
  if (rawVerdict === "approve" && !blocks) {
    verdict = "approve";
  } else if (rawVerdict === "rewrite_requested" || blocks) {
    verdict = "rewrite_requested";
  } else {
    // Unknown verdict string: approve only if there are no issues at all.
    verdict = issues.length === 0 ? "approve" : "rewrite_requested";
  }

  return {
    verdict,
    overallReaderExperience: str(
      raw?.overallReaderExperience ?? raw?.overall_reader_experience,
      "(no overall reaction reported)",
    ),
    issues,
    verdictReasoning: str(raw?.verdictReasoning ?? raw?.verdict_reasoning, ""),
  };
}

/**
 * Read `input.artifactContent` with `reviewerLlm` (a SEPARATE model from the
 * writer) and return a structured reading-experience verdict. Never throws —
 * an LLM/parse failure degrades to an `approve` with an explanatory note so the
 * loop can make forward progress rather than spin.
 */
export async function reviewArtifact(
  input: ReviewArtifactInput,
  reviewerLlm: SpineLLM,
  deps: ReviewArtifactDeps = {},
): Promise<ReviewerVerdict> {
  const emit = deps.emitLog ?? (() => {});
  const prompt = buildReviewerPrompt(input);
  try {
    const raw = await reviewerLlm(prompt, { temperature: 0.2, maxTokens: 2500 });
    const parsed = extractSpineJSON<RawVerdict>(raw);
    if (!parsed) {
      emit(`[review-loop] reviewer returned unparseable JSON for "${input.artifactSlug}"; accepting`);
      return {
        verdict: "approve",
        overallReaderExperience: "(reviewer output could not be parsed; accepted by default)",
        issues: [],
        verdictReasoning: "Reviewer response was not valid JSON.",
      };
    }
    const verdict = normalizeVerdict(parsed);
    emit(
      `[review-loop] reviewer "${input.artifactSlug}": ${verdict.verdict} (${verdict.issues.length} issues)`,
    );
    return verdict;
  } catch (err) {
    emit(`[review-loop] reviewer "${input.artifactSlug}" failed: ${errMsg(err)}; accepting`);
    return {
      verdict: "approve",
      overallReaderExperience: "(reviewer call failed; accepted by default)",
      issues: [],
      verdictReasoning: `Reviewer call failed: ${errMsg(err)}`,
    };
  }
}
