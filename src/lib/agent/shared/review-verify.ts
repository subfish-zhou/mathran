/**
 * Shared review + verify pipeline — extracted from init-agent.ts Steps 4.25 & 4.5.
 *
 * Provides:
 *   - `reviewAndRefinePages()` — self-review wiki pages and refine low-scoring ones
 *   - `verifyContent()` — verify wiki page accuracy against source material
 */

import { callAzureLLM, extractJSON, type TokenCounter } from "../azure-llm";
import { buildWikiReviewPrompt } from "../init-prompts";
import { extractWorkspaceRefs } from "../ref-utils";
import { executeVerify } from "../init-enrichment";
import type {
  CrawledResource,
  WorkspaceEffortOutput,
  DependencyEdgeOutput,
  WikiPageOutput,
  NarrativeOutline,
  CitationEntry,
  VerificationResult,
  WorkspaceResult,
} from "../init-types";

// ========== Review Config ==========

export interface ReviewConfig {
  /** Wiki pages to review */
  pages: WikiPageOutput[];
  /** Crawled resources for citation building */
  resources: CrawledResource[];
  /** Optional narrative outline for coherence checking */
  outline?: NarrativeOutline;
  /** Module name for LLM call tracking (default: 'init-agent') */
  trackerModule?: string;
}

export interface ReviewResult {
  /** Pages after review+refinement */
  pages: WikiPageOutput[];
  /** Number of pages that were refined */
  refinedCount: number;
}

// ========== Verify Config ==========

export interface VerifyConfig {
  /** Problem metadata */
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    backgroundSummary: string;
    tags: string[];
  };
  /** Workspace data */
  workspace: {
    efforts: WorkspaceEffortOutput[];
    edges: DependencyEdgeOutput[];
  };
  /** Crawled resources for source corpus */
  resources: CrawledResource[];
}

export interface VerifyResult {
  result: VerificationResult;
  correctedPages: WikiPageOutput[];
}

// ========== Review & Refine ==========

/**
 * Self-review wiki pages and refine any scoring below threshold.
 *
 * Extracted from init-agent.ts Step 4.25 (review_refine).
 */
export async function reviewAndRefinePages(
  config: ReviewConfig,
  emit: (event: Record<string, unknown>) => void,
  tokenCounter: TokenCounter,
): Promise<ReviewResult> {
  const pages = [...config.pages];
  let refinedCount = 0;
  const trackerModule = config.trackerModule ?? "init-agent";

  // Build citation entries from resources
  const citations: CitationEntry[] = config.resources
    .filter((r) => r.title)
    .map((r) => ({
      key: `${(r.authors[0]?.split(" ").pop() ?? "Unknown")}${r.year ?? ""}`,
      title: r.title,
      authors: r.authors,
      year: r.year,
      arxivId: r.arxivId,
      url: r.url,
      isSurvey: r.isSurvey,
    }));

  const reviewOutline: NarrativeOutline = config.outline ?? { globalThesis: "", pages: [] };

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    emit({ type: "review_page_start", slug: page.slug, title: page.title, pageIndex: i, totalPages: pages.length });
    try {
      const reviewPrompt = buildWikiReviewPrompt(page.title, page.content, reviewOutline, citations);
      const reviewRaw = await callAzureLLM(reviewPrompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-review" }, timeoutMs: 120_000 });
      const reviewResult = JSON.parse(extractJSON(reviewRaw));

      const overallScore = typeof reviewResult.overallScore === "number" ? reviewResult.overallScore : 10;
      const issues = Array.isArray(reviewResult.issues) ? reviewResult.issues : [];

      emit({ type: "log", message: `Review "${page.title}": score=${overallScore}, issues=${issues.length}` });

      if (overallScore < 7 && issues.length > 0) {
        emit({ type: "log", message: `Refining "${page.title}" (score ${overallScore} < 7)...` });
        const issuesSummary = issues
          .map((i: { section?: string; problem?: string; suggestion?: string }) =>
            `- Section "${i.section ?? "?"}": ${i.problem ?? "?"} → ${i.suggestion ?? "?"}`)
          .join("\n");

        const refinePrompt = `You are refining a mathematical wiki page based on review feedback.

## Page Title: ${page.title}

## Current Content:
${page.content}

## Review Issues:
${issuesSummary}

## Task
Rewrite the ENTIRE page, addressing all the issues above. Maintain the same structure and style. Preserve all @ws: references and LaTeX formatting.

Output ONLY the corrected markdown content. No JSON wrapping.`;

        const refined = await callAzureLLM(refinePrompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-refine" }, timeoutMs: 120_000 });
        let refinedContent = refined.trim();
        if (!refinedContent.includes("[AI-GENERATED]")) {
          refinedContent = `> [AI-GENERATED] [AI-REVIEWED] This content was automatically generated and refined.\n\n${refinedContent}`;
        }
        page.content = refinedContent;
        page.workspaceRefs = extractWorkspaceRefs(refinedContent);
        refinedCount++;
        emit({ type: "log", message: `Refined "${page.title}" successfully` });
      }
      emit({ type: "review_page_complete", slug: page.slug, score: overallScore, refined: overallScore < 7 && issues.length > 0 });
    } catch (err) {
      emit({ type: "log", message: `Review of "${page.title}" failed: ${err instanceof Error ? err.message : "unknown"}` });
      // FIX [audit-2 M10] previously emitted `score: 0` on review failure
      // — but the page content is unchanged, so any downstream consumer
      // gating on `score < 7` would mistakenly think the page is bad
      // *and* unrefined. Use a sentinel `score: -1` and an explicit
      // `skipped: true` flag so consumers can distinguish.
      emit({ type: "review_page_complete", slug: page.slug, score: -1, refined: false, skipped: true });
    }
  }

  return { pages, refinedCount };
}

// ========== Verify ==========

/**
 * Verify wiki page content accuracy against source material.
 *
 * Extracted from init-agent.ts Step 4.5 (verify).
 * Delegates to `executeVerify()` from init-enrichment.ts.
 */
export async function verifyContent(
  pages: WikiPageOutput[],
  config: VerifyConfig,
  emit: (event: Record<string, unknown>) => void,
): Promise<VerifyResult> {
  // Build the input shape expected by executeVerify
  const input = {
    problem: config.problem,
    seedReferences: [] as Array<{ originalInput: string; type: "arxiv" | "doi" | "url" | "unknown"; resolved: boolean }>,
    aiInit: { enableWiki: true, enableWorkspace: true, searchDepth: "deep" as const },
  };

  const workspace: WorkspaceResult = config.workspace;

  const verifyOutput = await executeVerify(
    input,
    pages,
    workspace,
    config.resources,
    emit as (e: Record<string, unknown>) => void,
  );

  return {
    result: verifyOutput.result,
    correctedPages: verifyOutput.correctedPages,
  };
}
