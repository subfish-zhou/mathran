/**
 * Review + verify pipeline (v1b, fs port of mathub's shared/review-verify.ts).
 *
 * Four passes, all fs-persisting and failure-isolated (never throw):
 *   - reviewAndRefinePages : LLM-score each wiki page, rewrite low scorers,
 *                            write back to `<project>/wiki/<slug>.md`
 *   - verifyPages          : LLM claim verification, stamp a `verification:`
 *                            frontmatter field on each page
 *   - reviewLinks          : pure cross-link check (@ws refs + [[slug]] links)
 *   - checkCompleteness    : pure spine-coverage assessment
 *
 * The LLM is mathran's injected `SpineLLM`; the JSON shapes are validated
 * defensively (no zod dependency added).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { extractSpineJSON, errMsg, noopEmit, type SpineLLM, type EmitFn } from "./spine/llm.js";
import { extractWorkspaceRefs, wikiDir } from "./spine/wiki-from-spine.js";
import type { WikiPageOutput, WorkspaceEffortOutput, NarrativeSpine } from "./spine/types.js";

const REFINE_THRESHOLD = 7;

export interface ReviewProblem {
  title: string;
  formalStatement: string;
  description: string;
  tags: string[];
}

export interface ReviewVerifyConfig {
  projectDir: string;
  pages: WikiPageOutput[];
  problem: ReviewProblem;
  efforts?: WorkspaceEffortOutput[];
  spine?: NarrativeSpine;
  tags?: string[];
}

export interface PageScore {
  slug: string;
  score: number;
  refined: boolean;
  skipped?: boolean;
}

export interface ReviewResult {
  pages: WikiPageOutput[];
  refinedCount: number;
  scores: PageScore[];
}

export interface PageVerification {
  slug: string;
  status: "verified" | "flagged" | "skipped";
  flaggedClaims: string[];
}

export interface VerifyResult {
  results: PageVerification[];
  flaggedCount: number;
}

export interface LinkReviewResult {
  brokenWsRefs: Array<{ slug: string; ref: string }>;
  brokenWikiLinks: Array<{ slug: string; target: string }>;
}

export interface CompletenessResult {
  totalNodes: number;
  coveredNodes: number;
  coverage: number;
  uncoveredNodeIds: string[];
}

// ============================================================
//  fs persistence (frontmatter-aware re-writer)
// ============================================================

function frontmatter(
  page: WikiPageOutput,
  tags: string[],
  extra: Record<string, string> = {},
): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `slug: ${page.slug}`,
    page.parentSlug ? `parentSlug: ${page.parentSlug}` : null,
    `tags: [${[...new Set([...tags, "ai-generated"])].map((t) => JSON.stringify(t)).join(", ")}]`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
  ];
  return lines.filter((l): l is string => l != null).join("\n");
}

async function writePage(
  projectDir: string,
  page: WikiPageOutput,
  tags: string[],
  extra: Record<string, string> = {},
): Promise<void> {
  try {
    await fs.mkdir(wikiDir(projectDir), { recursive: true });
    await fs.writeFile(
      path.join(wikiDir(projectDir), `${page.slug}.md`),
      frontmatter(page, tags, extra) + page.content.trim() + "\n",
      "utf-8",
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[review-verify] writePage(${page.slug}) failed: ${errMsg(err)}`);
  }
}

// ============================================================
//  Phase A: review + refine
// ============================================================

function buildReviewPrompt(page: WikiPageOutput, problem: ReviewProblem): string {
  return `You are reviewing a mathematical wiki page for the problem "${problem.title}".

PROBLEM: ${problem.formalStatement.slice(0, 400)}

PAGE TITLE: ${page.title}

PAGE CONTENT:
${page.content.slice(0, 6000)}

Assess the page for mathematical accuracy, clarity, completeness and coherence.
Output a JSON object:
{"overallScore": <0-10 integer>, "issues": [{"section": "...", "problem": "...", "suggestion": "..."}]}
Output ONLY valid JSON.`;
}

function buildRefinePrompt(page: WikiPageOutput, issuesSummary: string): string {
  return `You are refining a mathematical wiki page based on review feedback.

## Page Title: ${page.title}

## Current Content:
${page.content}

## Review Issues:
${issuesSummary}

## Task
Rewrite the ENTIRE page, addressing all the issues above. Maintain the same
structure and style. Preserve all @ws: references and LaTeX formatting.

Output ONLY the corrected markdown content. No JSON wrapping.`;
}

/**
 * Self-review each wiki page; refine (and rewrite to fs) any scoring below the
 * threshold. Never throws — per-page failures degrade to a skipped sentinel.
 */
export async function reviewAndRefinePages(
  config: ReviewVerifyConfig,
  llm: SpineLLM,
  emit: EmitFn = noopEmit,
): Promise<ReviewResult> {
  const pages = [...config.pages];
  const tags = config.tags ?? config.problem.tags ?? [];
  const scores: PageScore[] = [];
  let refinedCount = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    emit({ type: "log", message: `Reviewing "${page.title}" (${i + 1}/${pages.length})` });
    try {
      const raw = await llm(buildReviewPrompt(page, config.problem), { temperature: 0.1, maxTokens: 1500 });
      const review = extractSpineJSON<{ overallScore?: number; issues?: Array<{ section?: string; problem?: string; suggestion?: string }> }>(raw);
      const overallScore = typeof review?.overallScore === "number" ? review.overallScore : 10;
      const issues = Array.isArray(review?.issues) ? review!.issues! : [];
      emit({ type: "log", message: `Review "${page.title}": score=${overallScore}, issues=${issues.length}` });

      let refined = false;
      if (overallScore < REFINE_THRESHOLD && issues.length > 0) {
        const issuesSummary = issues
          .map((it) => `- Section "${it.section ?? "?"}": ${it.problem ?? "?"} → ${it.suggestion ?? "?"}`)
          .join("\n");
        const refinedRaw = await llm(buildRefinePrompt(page, issuesSummary), { temperature: 0.3, maxTokens: 4000 });
        let refinedContent = refinedRaw.trim();
        if (refinedContent.length > 0) {
          if (!refinedContent.includes("[AI-GENERATED]")) {
            refinedContent = `> [AI-GENERATED] [AI-REVIEWED] This content was automatically generated and refined.\n\n${refinedContent}`;
          }
          page.content = refinedContent;
          page.workspaceRefs = extractWorkspaceRefs(refinedContent);
          await writePage(config.projectDir, page, tags);
          refined = true;
          refinedCount++;
          emit({ type: "log", message: `Refined "${page.title}" (score ${overallScore} < ${REFINE_THRESHOLD})` });
        }
      }
      scores.push({ slug: page.slug, score: overallScore, refined });
    } catch (err) {
      emit({ type: "log", message: `Review of "${page.title}" failed: ${errMsg(err)}` });
      scores.push({ slug: page.slug, score: -1, refined: false, skipped: true });
    }
  }

  return { pages, refinedCount, scores };
}

// ============================================================
//  Phase B: verify
// ============================================================

function buildVerifyPrompt(page: WikiPageOutput, problem: ReviewProblem): string {
  return `You are verifying the factual/mathematical accuracy of a wiki page about "${problem.title}".

PAGE TITLE: ${page.title}

PAGE CONTENT:
${page.content.slice(0, 6000)}

Identify any claims that appear mathematically incorrect, unsupported, or
misattributed. Output a JSON object:
{"status": "verified" | "flagged", "flaggedClaims": ["..."]}
Use "verified" if no significant issues. Output ONLY valid JSON.`;
}

/**
 * LLM claim-verification per page; stamps a `verification:` frontmatter field
 * (verified | flagged) onto the persisted fs page. Never throws.
 */
export async function verifyPages(
  config: ReviewVerifyConfig,
  llm: SpineLLM,
  emit: EmitFn = noopEmit,
): Promise<VerifyResult> {
  const tags = config.tags ?? config.problem.tags ?? [];
  const results: PageVerification[] = [];
  let flaggedCount = 0;

  for (const page of config.pages) {
    emit({ type: "log", message: `Verifying "${page.title}"` });
    try {
      const raw = await llm(buildVerifyPrompt(page, config.problem), { temperature: 0.1, maxTokens: 1500 });
      const v = extractSpineJSON<{ status?: string; flaggedClaims?: string[] }>(raw);
      const flaggedClaims = Array.isArray(v?.flaggedClaims) ? v!.flaggedClaims!.filter((c): c is string => typeof c === "string") : [];
      const status: PageVerification["status"] = v?.status === "flagged" || flaggedClaims.length > 0 ? "flagged" : "verified";
      if (status === "flagged") flaggedCount++;
      await writePage(config.projectDir, page, tags, { verification: status });
      results.push({ slug: page.slug, status, flaggedClaims });
      emit({ type: "log", message: `Verify "${page.title}": ${status} (${flaggedClaims.length} flagged)` });
    } catch (err) {
      emit({ type: "log", message: `Verify of "${page.title}" failed: ${errMsg(err)}` });
      results.push({ slug: page.slug, status: "skipped", flaggedClaims: [] });
    }
  }

  return { results, flaggedCount };
}

// ============================================================
//  Phase C: link review (pure)
// ============================================================

const WIKI_LINK = /\[\[([a-z0-9][a-z0-9-]*)(?:\|[^\]]*)?\]\]/gi;

/**
 * Pure cross-link check across the wiki page set: flags @ws refs that don't
 * match a known effort id and [[slug]] links that don't match a page slug.
 */
export function reviewLinks(
  config: ReviewVerifyConfig,
  emit: EmitFn = noopEmit,
): LinkReviewResult {
  const effortIds = new Set((config.efforts ?? []).map((e) => e.id));
  const pageSlugs = new Set(config.pages.map((p) => p.slug));
  const brokenWsRefs: Array<{ slug: string; ref: string }> = [];
  const brokenWikiLinks: Array<{ slug: string; target: string }> = [];

  for (const page of config.pages) {
    for (const ref of extractWorkspaceRefs(page.content)) {
      if (!effortIds.has(ref)) brokenWsRefs.push({ slug: page.slug, ref });
    }
    for (const m of page.content.matchAll(WIKI_LINK)) {
      const target = m[1]!;
      if (!pageSlugs.has(target)) brokenWikiLinks.push({ slug: page.slug, target });
    }
  }

  emit({ type: "log", message: `Link review: ${brokenWsRefs.length} broken @ws refs, ${brokenWikiLinks.length} broken wiki links` });
  return { brokenWsRefs, brokenWikiLinks };
}

// ============================================================
//  Phase D: completeness (pure)
// ============================================================

/**
 * Pure spine-coverage assessment: a node counts as "covered" if one of its
 * linked efforts is referenced by a wiki page (@ws) or it has effortIds.
 */
export function checkCompleteness(
  config: ReviewVerifyConfig,
  emit: EmitFn = noopEmit,
): CompletenessResult {
  const spine = config.spine;
  if (!spine || spine.nodes.length === 0) {
    return { totalNodes: 0, coveredNodes: 0, coverage: 1, uncoveredNodeIds: [] };
  }

  const referencedEfforts = new Set<string>();
  for (const page of config.pages) {
    for (const ref of extractWorkspaceRefs(page.content)) referencedEfforts.add(ref);
  }

  const uncoveredNodeIds: string[] = [];
  let covered = 0;
  for (const node of spine.nodes) {
    // A node is "covered" if an effort was generated for it, or one of its
    // efforts is referenced by a wiki page.
    const isCovered =
      node.effortIds.length > 0 || node.effortIds.some((id) => referencedEfforts.has(id));
    if (isCovered) covered++;
    else uncoveredNodeIds.push(node.id);
  }

  const coverage = spine.nodes.length > 0 ? covered / spine.nodes.length : 1;
  emit({ type: "log", message: `Completeness: ${covered}/${spine.nodes.length} nodes covered (${Math.round(coverage * 100)}%)` });
  return { totalNodes: spine.nodes.length, coveredNodes: covered, coverage, uncoveredNodeIds };
}
