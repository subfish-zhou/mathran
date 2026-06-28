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
  verdict: "approve" | "rewrite_requested" | "reviewer_broken";
  overallReaderExperience: string;
  issues: ReviewIssue[];
  verdictReasoning: string;
}

export interface ReviewArtifactInput {
  artifactKind: "wiki-page" | "effort-document" | "effort-readme" | "thread-survey";
  artifactTitle: string;
  artifactSlug: string;
  /** FULL content, no slicing — the reviewer reads everything. */
  artifactContent: string;
  /** The project's problem title. */
  topic: string;
  /** e.g. "graduate-student-entering-field" from the WikiPlan. */
  audienceHint?: string;
  /**
   * When `true`, the writer and reviewer are the SAME underlying model
   * (self-review), which is a known weaker setup per DESIGN-REFERENCE §6.7.
   * The reviewer prompt switches to an extra-skeptical framing that explicitly
   * acknowledges the conflict and asks the reviewer to assume nothing the
   * writer left implicit. Defaults to false (true dual-model review).
   *
   * Caught in dogfood-run-d79c820c42b7: with writerModel=reviewerModel='' both
   * pointing to copilot's same default, the reviewer rubber-stamped wide
   * swaths of effort docs that had real prose-quality issues. Adding a
   * self-review preamble is a cheap mitigation when dual-model isn't
   * available.
   */
  selfReviewMode?: boolean;
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
  // Also drop maxTokens from the reviewer call: dogfood-run-10 showed long
  // (>2500 token) reviewer outputs being cut off mid-JSON, which then failed
  // to parse and triggered the silent "accept by default" fallback for 5+ of
  // every 10 reviewer calls. With no maxTokens the provider uses its model's
  // actual cap (128K for gpt-5.5) — the same fix as canonical-landmarks.
  try {
    let raw = await reviewerLlm(prompt, { temperature: 0.2 });
    let parsed = extractSpineJSON<RawVerdict>(raw);

    // Retry once with a strict "ONLY JSON, no prose" reminder when the first
    // attempt failed to parse. Catches the case where the model produced
    // valid content but wrapped it in prose / markdown headers / etc.
    if (!parsed) {
      emit(`[review-loop] reviewer "${input.artifactSlug}" returned unparseable JSON; retrying once with strict-format reminder`);
      const strictPrompt =
        prompt +
        "\n\n=== STRICT FORMAT REMINDER ===\n" +
        "Your previous response could not be parsed. Output ONLY a single JSON object " +
        "matching the schema. NO markdown code fence, NO prose before or after, NO " +
        "commentary on your own output. Start with `{` and end with `}`.";
      raw = await reviewerLlm(strictPrompt, { temperature: 0.1 });
      parsed = extractSpineJSON<RawVerdict>(raw);
    }

    if (!parsed) {
      // dogfood-run-d79c820c42b7: reviewer returned unparseable JSON 13×; retry
      // recovered 8; 5 still unparseable after strict-format reminder slipped
      // through as silent `approve`s — quality gate effectively bypassed for
      // those artifacts. Returning `approve` is dangerous (it claims the
      // reviewer was satisfied when in fact it broke). Returning
      // `rewrite_requested` would spin the loop with a reviewer that can't
      // judge anything. New `reviewer_broken` verdict tells review-loop to
      // surface this honestly via `flagged_persistent` without further
      // rewrites — preserving the writer's draft AND a truthful audit trail.
      emit(`[review-loop] reviewer "${input.artifactSlug}" still unparseable after retry; flagging as reviewer_broken (no silent-approve)`);
      return {
        verdict: "reviewer_broken",
        overallReaderExperience: "(reviewer output could not be parsed after one retry with strict-format reminder; verdict unknown, draft kept as-is)",
        issues: [],
        verdictReasoning: "Reviewer response was not valid JSON after one retry with strict-format reminder. This is a reviewer-model failure mode, not a verdict on the artifact; see review-loop logs for raw replies.",
      };
    }
    const verdict = normalizeVerdict(parsed);
    emit(
      `[review-loop] reviewer "${input.artifactSlug}": ${verdict.verdict} (${verdict.issues.length} issues)`,
    );
    return verdict;
  } catch (err) {
    // Same reasoning as the unparseable-after-retry branch above: a thrown
    // exception (timeout / network / provider 500) means the reviewer never
    // judged this artifact, so we cannot truthfully report `approve`. Surface
    // as reviewer_broken so review-loop can short-circuit to flagged_persistent.
    emit(`[review-loop] reviewer "${input.artifactSlug}" failed: ${errMsg(err)}; flagging as reviewer_broken`);
    return {
      verdict: "reviewer_broken",
      overallReaderExperience: "(reviewer call threw an exception; verdict unknown, draft kept as-is)",
      issues: [],
      verdictReasoning: `Reviewer call failed: ${errMsg(err)}`,
    };
  }
}
