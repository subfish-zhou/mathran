/**
 * Enrichment, verification, and correction logic for the Initialization Agent.
 * Handles source corpus building, claim verification, and content correction.
 */

import { callAzureLLM, extractJSON, TokenCounter } from "./azure-llm";
import { extractWorkspaceRefs } from "./ref-utils";
import type {
  InitAgentInput,
  InitAgentEvent,
  CrawledResource,
  WikiPageOutput,
  VerificationIssue,
  VerificationResult,
  WorkspaceResult,
  SourceCorpusEntry,
} from "./init-types";
import { buildVerificationPrompt, buildCorrectionPrompt } from "./init-prompts";
import { mapVerificationStatus, mapVerificationSeverity, chunkString } from "./init-parsers";

// --- Verify Output ---

export interface VerifyOutput {
  result: VerificationResult;
  correctedPages: WikiPageOutput[];
}

// --- Source Corpus Builder ---

export function buildSourceCorpus(
  resources: CrawledResource[],
  workspace: WorkspaceResult
): SourceCorpusEntry[] {
  const corpus: SourceCorpusEntry[] = [];

  for (const r of resources) {
    corpus.push({
      id: r.id,
      title: r.title,
      authors: r.authors,
      year: r.year,
      abstract: r.abstract,
      type: r.sourceType,
    });
  }

  // Also add non-REFERENCE workspace efforts as "known facts"
  for (const effort of workspace.efforts) {
    if (effort.type !== "REFERENCE") {
      corpus.push({
        id: effort.id,
        title: effort.title,
        authors: [],
        type: effort.type,
        abstract: effort.description,
      });
    }
  }

  return corpus;
}

// --- Claim Verification (single page) ---

export async function verifyPageClaims(
  page: WikiPageOutput,
  problem: { title: string; formalStatement: string; tags: string[] },
  sourceCorpus: SourceCorpusEntry[],
  emit: (e: InitAgentEvent) => void,
  tokenCounter?: TokenCounter,
): Promise<VerificationIssue[]> {
  const prompt = buildVerificationPrompt(page, problem, sourceCorpus);
  const raw = await callAzureLLM(prompt, { tokenCounter, tracker: { module: "init-agent", operation: "enrich-effort" } });

  try {
    const parsed = JSON.parse(extractJSON(raw));
    const claims = Array.isArray(parsed.claims) ? parsed.claims : [];

    const issues: VerificationIssue[] = [];

    for (const claim of claims) {
      const status = mapVerificationStatus(String(claim.status ?? "unverified"));
      const severity = mapVerificationSeverity(String(claim.severity ?? "minor"));

      const issue: VerificationIssue = {
        pageSlug: page.slug,
        claim: String(claim.claim ?? ""),
        status,
        severity,
        explanation: String(claim.explanation ?? ""),
        sourceEvidence: claim.source_evidence ? String(claim.source_evidence) : undefined,
        suggestedFix: claim.suggested_fix ? String(claim.suggested_fix) : undefined,
      };
      issues.push(issue);

      emit({
        type: "verify_claim_checked",
        slug: page.slug,
        claim: issue.claim.slice(0, 100),
        status: issue.status,
        severity: issue.severity,
        explanation: issue.explanation.slice(0, 150),
      });
    }

    return issues;
  } catch {
    emit({ type: "log", message: `Verification result parsing failed (${page.slug}), skipping` });
    return [];
  }
}

// --- Page Content Correction ---

export async function correctPageContent(
  page: WikiPageOutput,
  issues: VerificationIssue[],
  problem: { title: string; formalStatement: string; tags: string[] },
  sourceCorpus: SourceCorpusEntry[],
  _emit: (e: InitAgentEvent) => void,
  tokenCounter?: TokenCounter,
): Promise<string | null> {
  const prompt = buildCorrectionPrompt(page, issues, problem, sourceCorpus);
  const raw = await callAzureLLM(prompt, { tokenCounter, tracker: { module: "init-agent", operation: "enrich-deep" } });

  // Extract corrected content
  let content: string;
  try {
    const parsed = JSON.parse(extractJSON(raw));
    content = String(parsed.content ?? parsed.corrected_content ?? raw);
  } catch {
    content = raw.trim();
  }

  // M5: the minimum length here exists to filter out LLM hallucinations that
  // echo back only a whitespace blob or "OK" after a correction prompt. It is
  // NOT meant to assert semantic correctness; short-but-correct math content
  // (e.g. a one-line definition) should still pass. We name the threshold so
  // future tuning has a single knob.
  const MIN_CORRECTED_CONTENT_LENGTH = 30;
  if (content.length < MIN_CORRECTED_CONTENT_LENGTH || content === page.content) {
    return null;
  }

  // Ensure AI-GENERATED + VERIFIED tags
  if (!content.includes("[AI-GENERATED]")) {
    content = `> [AI-GENERATED] This content was automatically generated and requires human review.\n\n${content}`;
  }
  if (!content.includes("[AI-VERIFIED]")) {
    content = content.replace(
      "[AI-GENERATED]",
      "[AI-GENERATED] [AI-VERIFIED]"
    );
  }

  return content;
}

// --- Full Verify Step ---

/**
 * Verify Wiki content by cross-referencing claims against crawled source
 * material (paper abstracts, known facts). Uses a two-pass approach:
 *
 * Pass 1 — Claim Extraction & Verification:
 *   For each wiki page, extract key factual claims (attributions, dates,
 *   theorem statements, relationships) and check them against source abstracts.
 *
 * Pass 2 — Correction:
 *   For pages with critical/major issues, re-generate corrected sections
 *   with explicit source constraints.
 */
export async function executeVerify(
  input: InitAgentInput,
  wikiPages: WikiPageOutput[],
  workspace: WorkspaceResult,
  resources: CrawledResource[],
  emit: (e: InitAgentEvent) => void
): Promise<VerifyOutput> {
  emit({ type: "verify_start", totalPages: wikiPages.length });
  emit({ type: "log", message: `Starting verification of ${wikiPages.length} Wiki pages for content accuracy...` });

  const tokenCounter = new TokenCounter();
  const allIssues: VerificationIssue[] = [];
  const pageIssueMap = new Map<string, VerificationIssue[]>();

  // Build source evidence corpus for the verifier
  const sourceCorpus = buildSourceCorpus(resources, workspace);

  // ── Pass 1: Verify each page ──
  for (const page of wikiPages) {
    emit({ type: "verify_page_start", slug: page.slug, title: page.title });
    emit({ type: "log", message: `Verifying page: ${page.title}...` });

    try {
      const pageIssues = await verifyPageClaims(
        page,
        input.problem,
        sourceCorpus,
        emit,
        tokenCounter,
      );

      pageIssueMap.set(page.slug, pageIssues);
      allIssues.push(...pageIssues);

      // Attach per-page verification metadata
      const checkedClaims = pageIssues.length;
      const issueCount = pageIssues.filter((i) => i.status !== "verified").length;
      page.verification = {
        checkedClaims,
        issues: pageIssues,
        confidenceScore: checkedClaims > 0
          ? pageIssues.filter((i) => i.status === "verified").length / checkedClaims
          : 1,
      };

      emit({
        type: "verify_page_complete",
        slug: page.slug,
        claims: checkedClaims,
        issues: issueCount,
      });
    } catch (err) {
      emit({ type: "log", message: `Page "${page.title}" verification failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  }

  // ── Pass 2: Correct pages with major/critical issues ──
  const correctedPages = [...wikiPages];
  for (const page of correctedPages) {
    const issues = pageIssueMap.get(page.slug) ?? [];
    const seriousIssues = issues.filter(
      (i) => i.status === "incorrect" && (i.severity === "critical" || i.severity === "major")
    );

    if (seriousIssues.length === 0) continue;

    emit({ type: "verify_correction_start", slug: page.slug, issueCount: seriousIssues.length });
    emit({ type: "log", message: `Correcting page "${page.title}": ${seriousIssues.length} serious issues...` });

    try {
      const correctedContent = await correctPageContent(
        page,
        seriousIssues,
        input.problem,
        sourceCorpus,
        emit,
        tokenCounter,
      );
      let correctedCount = 0;

      if (correctedContent) {
        page.content = correctedContent;
        page.workspaceRefs = extractWorkspaceRefs(correctedContent);
        correctedCount = seriousIssues.length;

        // Mark corrected issues
        for (const issue of seriousIssues) {
          issue.status = "corrected";
        }

        // Stream the corrected content
        const chunks = chunkString(page.content, 300);
        emit({ type: "wiki_page_start", slug: page.slug, title: `${page.title} (corrected)` });
        for (const chunk of chunks) {
          emit({ type: "wiki_page_chunk", slug: page.slug, chunk });
        }
        emit({ type: "wiki_page_complete", slug: page.slug });
      }

      emit({ type: "verify_correction_complete", slug: page.slug, corrected: correctedCount });
    } catch (err) {
      emit({ type: "log", message: `Page "${page.title}" correction failed: ${err instanceof Error ? err.message : "unknown"}` });
      emit({ type: "verify_correction_complete", slug: page.slug, corrected: 0 });
    }
  }

  // ── Build result ──
  const verified = allIssues.filter((i) => i.status === "verified").length;
  const unverified = allIssues.filter((i) => i.status === "unverified").length;
  const incorrect = allIssues.filter((i) => i.status === "incorrect").length;
  const corrected = allIssues.filter((i) => i.status === "corrected").length;

  const confidenceScore = allIssues.length > 0
    ? (verified + corrected * 0.8) / allIssues.length
    : 1;

  const result: VerificationResult = {
    totalClaims: allIssues.length,
    verified,
    unverified,
    incorrect,
    corrected,
    issues: allIssues,
    correctedPages: correctedPages
      .filter((p) => (pageIssueMap.get(p.slug) ?? []).some((i) => i.status === "corrected"))
      .map((p) => p.slug),
    confidenceScore,
  };

  emit({ type: "verify_complete", result });
  emit({
    type: "log",
    message: `Verification complete: ${allIssues.length} claims checked, ${verified} verified, ${unverified} unverifiable, ${incorrect} incorrect, ${corrected} corrected (confidence: ${Math.round(confidenceScore * 100)}%)`,
  });

  return { result, correctedPages };
}
