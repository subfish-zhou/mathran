/**
 * Shared wiki generation pipeline — extracted from init-agent.ts executeGenerateWiki().
 *
 * Provides `generateWikiContent()` which generates narrative outline +
 * individual wiki pages from workspace efforts and resources.
 * Also supports incremental wiki generation via `mergeWikiContent()`.
 */

import { callAzureLLM, extractJSON, type TokenCounter } from "../azure-llm";
import { REQUIRED_WIKI_PAGES } from "../init-spec";
import { buildSinglePagePrompt, buildNarrativeOutlinePrompt } from "../init-prompts";
import { extractWorkspaceRefs } from "../ref-utils";
import { chunkString } from "../init-parsers";
import type {
  CrawledResource,
  WorkspaceEffortOutput,
  DependencyEdgeOutput,
  WikiPageOutput,
  NarrativeOutline,
  WorkspaceResult,
} from "../init-types";

// ========== Config ==========

export interface WikiGeneratorConfig {
  /** Problem metadata */
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    backgroundSummary: string;
    tags: string[];
    currentStatus?: string;
    mathStatus?: string;
    solvedBy?: string;
    solvedYear?: number;
    solvedReference?: string;
  };
  /** Workspace data (efforts + edges) */
  workspace: {
    efforts: WorkspaceEffortOutput[];
    edges: DependencyEdgeOutput[];
  };
  /** Crawled resources */
  resources: CrawledResource[];
  /**
   * Existing wiki content for incremental update mode.
   * When provided, generates only new/updated pages and merges them.
   */
  existingWiki?: WikiPageOutput[];
  /** Module name for LLM call tracking (default: 'init-agent') */
  trackerModule?: string;
  /** Project ID for wiki agent path */
  projectId?: string;
  /** User ID for wiki agent path */
  userId?: string;
}

export interface WikiGeneratorResult {
  pages: WikiPageOutput[];
  outline?: NarrativeOutline;
}

// ========== Merge Helper ==========

/**
 * Merge newly generated wiki pages into existing wiki content.
 * - New pages (by slug) are appended.
 * - Existing pages are updated with new content if the new version is longer.
 */
export function mergeWikiContent(
  existing: WikiPageOutput[],
  updates: WikiPageOutput[],
): WikiPageOutput[] {
  const merged = [...existing];
  const slugIndex = new Map(merged.map((p, i) => [p.slug, i]));

  for (const update of updates) {
    const existingIdx = slugIndex.get(update.slug);
    if (existingIdx != null) {
      // FIX [audit-2 M9] previous "≥80%" length heuristic silently dropped
      // any meaningful refinement: the refine pass typically *shortens*
      // text (compresses repetition, removes hallucinated citations) so
      // its output was reverted in-place by mergeWikiContent. Now: prefer
      // the update unless it's clearly truncated (less than 30% the size
      // of the existing page AND existing has substantive content).
      const existingLen = merged[existingIdx]!.content.length;
      const looksTruncated = existingLen > 500 && update.content.length < existingLen * 0.3;
      if (!looksTruncated) {
        merged[existingIdx] = update;
      }
    } else {
      // Append new page
      merged.push(update);
      slugIndex.set(update.slug, merged.length - 1);
    }
  }

  return merged;
}

// ========== Core Logic ==========

/**
 * Generate wiki content from workspace efforts and resources.
 *
 * Extracted from `executeGenerateWiki()` in init-agent.ts.
 * Steps:
 *   A. Generate narrative outline
 *   B. Generate each wiki page ordered by outline
 *   C. Set parent hierarchy
 */
export async function generateWikiContent(
  config: WikiGeneratorConfig & { maxPages?: number },
  emit: (event: Record<string, unknown>) => void,
  tokenCounter: TokenCounter,
): Promise<WikiGeneratorResult> {
  const { problem, workspace, resources, maxPages } = config;
  const trackerModule = config.trackerModule ?? "init-agent";
  const workspaceResult: WorkspaceResult = workspace;
  const pages: WikiPageOutput[] = [];

  // ── Try wiki agent path first (tool-based, no truncation) ──
  try {
    const { wikiAgentGenerate } = await import("../wiki-agent");

    if (config.projectId && config.userId) {
      const agentPages = await wikiAgentGenerate({
        projectId: config.projectId,
        userId: config.userId,
        problem: config.problem,
        existingPages: (config.existingWiki ?? []).map((p) => ({ slug: p.slug, title: p.title })),
        requiredPages: REQUIRED_WIKI_PAGES,
        mode: "full",
        maxIterations: 50,
      });

      if (agentPages.length > 0) {
        // Set parent hierarchy
        for (let i = 1; i < agentPages.length; i++) {
          agentPages[i]!.parentSlug = agentPages[0]!.slug;
        }
        emit({ type: "wiki_complete", stats: { pages: agentPages.length } });
        if (config.existingWiki && config.existingWiki.length > 0) {
          return { pages: mergeWikiContent(config.existingWiki, agentPages) };
        }
        return { pages: agentPages };
      }
    }
  } catch (err) {
    emit({ type: "log", message: `Wiki agent failed, falling back to legacy: ${err instanceof Error ? err.message : "unknown"}` });
  }

  // ── Legacy pipeline (fallback) ──

  // Generate wiki pages driven by the specification
  let specsToGenerate = REQUIRED_WIKI_PAGES;
  if (maxPages && maxPages < specsToGenerate.length) {
    specsToGenerate = specsToGenerate.slice(0, maxPages);
  }

  const pageSpecs = specsToGenerate.map((s) => ({
    slug: s.slug,
    title: s.titleTemplate.replace("{title}", problem.title),
    instruction: s.instruction,
  }));

  const allPageTitles = pageSpecs.map((s) => s.title);

  // --- Stage A: Generate Narrative Outline ---
  let outline: NarrativeOutline | undefined;
  try {
    emit({ type: "log", message: "Generating narrative outline..." });

    // Collect survey excerpts from resources
    const surveyExcerpts: string[] = [];
    const surveyResources = resources.filter((r) => r.isSurvey && r.arxivId);
    for (const r of surveyResources) {
      if (r.abstract) {
        surveyExcerpts.push(`[${r.title}]: ${r.abstract.slice(0, 2000)}`);
      }
    }

    const outlinePrompt = buildNarrativeOutlinePrompt(
      problem,
      workspace.efforts.filter((e) => e.type !== "REFERENCE").map((e) => ({
        title: e.title,
        description: e.description,
        document: e.document,
      })),
      surveyExcerpts,
      pageSpecs.map((s) => ({ slug: s.slug, title: s.title, instruction: s.instruction })),
    );

    const outlineRaw = await callAzureLLM(outlinePrompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-outline" }, timeoutMs: 1_800_000 });
    const outlineJson = JSON.parse(extractJSON(outlineRaw));
    if (outlineJson.globalThesis && Array.isArray(outlineJson.pages)) {
      outline = outlineJson as NarrativeOutline;
      emit({ type: "log", message: `Narrative outline generated: "${outline.globalThesis.slice(0, 100)}..." (${outline.pages.length} pages)` });
    }
  } catch (err) {
    emit({ type: "log", message: `Narrative outline generation failed: ${err instanceof Error ? err.message : "unknown"}. Falling back to sequential generation.` });
  }

  // --- Stage B: Generate pages (ordered by outline if available) ---
  const previousPages: Array<{ title: string; summary: string }> = [];

  // Determine page order: outline order if available, else spec order
  let orderedSpecs = pageSpecs;
  if (outline && outline.pages.length > 0) {
    const specBySlug = new Map(pageSpecs.map((s) => [s.slug, s]));
    const orderedFromOutline = outline.pages
      .map((op) => specBySlug.get(op.slug))
      .filter((s): s is typeof pageSpecs[number] => s != null);
    // Append any specs not in outline
    const outlineSlugs = new Set(outline.pages.map((op) => op.slug));
    const remaining = pageSpecs.filter((s) => !outlineSlugs.has(s.slug));
    orderedSpecs = [...orderedFromOutline, ...remaining];
  }

  for (const spec of orderedSpecs) {
    emit({ type: "wiki_page_start", slug: spec.slug, title: spec.title });
    emit({ type: "log", message: `AI is writing: ${spec.title}...` });

    const prompt = buildSinglePagePrompt(problem, workspaceResult, spec, problem.mathStatus, allPageTitles, outline, previousPages);
    try {
      const raw = await callAzureLLM(prompt, { tokenCounter, tracker: { module: trackerModule, operation: "init-wiki" }, timeoutMs: 1_800_000 });
      // Extract content — LLM may return JSON with "content" key or raw markdown
      let content: string;
      try {
        const parsed = JSON.parse(extractJSON(raw));
        content = String(parsed.content ?? parsed.text ?? raw);
      } catch {
        // LLM returned raw markdown, use as-is
        content = raw.trim();
      }

      // Ensure AI-GENERATED tag
      if (!content.includes("[AI-GENERATED]")) {
        content = `> [AI-GENERATED] This content was automatically generated and requires human review.\n\n${content}`;
      }

      const wikiPage: WikiPageOutput = {
        slug: spec.slug,
        title: spec.title,
        content,
        workspaceRefs: extractWorkspaceRefs(content),
      };
      pages.push(wikiPage);

      // Track summary for next page generation
      previousPages.push({
        title: spec.title,
        summary: content.slice(0, 500),
      });

      // Emit content in chunks
      const chunks = chunkString(wikiPage.content, 300);
      for (const chunk of chunks) {
        emit({ type: "wiki_page_chunk", slug: wikiPage.slug, chunk });
      }
      emit({ type: "wiki_page_complete", slug: wikiPage.slug });
    } catch (err) {
      emit({ type: "log", message: `Page "${spec.title}" generation failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  }

  // Set parent hierarchy: first page is root, rest are children
  if (pages.length > 0) {
    for (let i = 1; i < pages.length; i++) {
      pages[i]!.parentSlug = pages[0]!.slug;
    }
  }

  emit({ type: "wiki_complete", stats: { pages: pages.length } });

  // If incremental mode, merge with existing wiki
  if (config.existingWiki && config.existingWiki.length > 0) {
    const merged = mergeWikiContent(config.existingWiki, pages);
    return { pages: merged, outline };
  }

  return { pages, outline };
}

// ========== Incremental Wiki Update (Patrol) ==========

export interface WikiIncrementalConfig {
  projectTitle: string;
  projectDescription: string;
  existingPages: Array<{ slug: string; title: string; content: string }>;
  existingEfforts: Array<{ title: string; description: string; document?: string }>;
  newDiscoveries: Array<{ title: string; abstract: string; fullText?: string; url?: string }>;
  trackerModule?: string;
}

export interface WikiIncrementalResult {
  updates: Array<{
    pageSlug: string;
    pageTitle: string;
    action: "update" | "create";
    newContent: string;
    changeSummary: string;
  }>;
  unchanged: string[];
}

/**
 * Extract section headings from markdown content.
 */
function extractSectionHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^(#{1,4})\s+(.+)/);
    if (match) {
      headings.push(`${"  ".repeat(match[1]!.length - 1)}${match[2]!.trim()}`);
    }
  }
  return headings;
}

/**
 * Incrementally update existing wiki pages based on new discoveries.
 * Unlike generateWikiContent() which regenerates from scratch, this:
 *   1. Plans which pages need updates (lightweight LLM call)
 *   2. Generates updated content per page (preserving existing content)
 */
export async function updateWikiIncremental(
  config: WikiIncrementalConfig,
  emit: (event: Record<string, unknown>) => void,
  tokenCounter: TokenCounter,
): Promise<WikiIncrementalResult> {
  const trackerModule = config.trackerModule ?? "patrol-agent";
  const result: WikiIncrementalResult = { updates: [], unchanged: [] };

  if (config.newDiscoveries.length === 0) {
    result.unchanged = config.existingPages.map((p) => p.slug);
    return result;
  }

  // ── Step A: Planning ──
  emit({ type: "log", message: "Wiki incremental: planning updates..." });

  const pageSummaries = config.existingPages.map((p) => {
    const headings = extractSectionHeadings(p.content);
    return `Page "${p.title}" (slug: ${p.slug}):\n  Sections: ${headings.length > 0 ? headings.join(", ") : "(no headings)"}\n  Length: ${p.content.length} chars`;
  }).join("\n\n");

  const discoverySummaries = config.newDiscoveries.map((d, i) =>
    `${i + 1}. "${d.title}"${d.url ? ` (${d.url})` : ""}\n   ${(d.abstract ?? "").slice(0, 300)}`
  ).join("\n\n");

  const effortSummaries = config.existingEfforts.slice(0, 30).map((e) =>
    `- ${e.title}: ${(e.description ?? "").slice(0, 150)}`
  ).join("\n");

  const planPrompt = `You are a mathematical research wiki editor. A research project has existing wiki pages and new paper discoveries. Decide which pages need updating.

PROJECT: ${config.projectTitle}
DESCRIPTION: ${config.projectDescription}

EXISTING WIKI PAGES:
${pageSummaries}

EXISTING RESEARCH EFFORTS (${config.existingEfforts.length} total):
${effortSummaries}

NEW DISCOVERIES TO INTEGRATE:
${discoverySummaries}

Analyze: which existing pages should be updated with info from these discoveries? Should any new pages be created?

Output JSON:
{
  "page_updates": [
    { "slug": "existing-page-slug", "reason": "why this page needs updating", "relevant_discovery_indices": [0, 2] }
  ],
  "new_pages": [
    { "slug": "new-page-slug", "title": "New Page Title", "reason": "why needed", "relevant_discovery_indices": [1] }
  ]
}

Rules:
- Only update pages where discoveries add MEANINGFUL new information
- Prefer updating existing pages over creating new ones
- New pages only for genuinely new research directions not covered by existing pages
- Discovery indices are 0-based
- If no updates needed, return empty arrays`;

  let plan: {
    page_updates: Array<{ slug: string; reason: string; relevant_discovery_indices: number[] }>;
    new_pages: Array<{ slug: string; title: string; reason: string; relevant_discovery_indices: number[] }>;
  } = { page_updates: [], new_pages: [] };

  try {
    const planResponse = await callAzureLLM(planPrompt, {
      maxTokens: 4096,
      tokenCounter,
      tracker: { module: trackerModule, operation: "patrol-wiki-plan" },
      timeoutMs: 360_000,
    });
    plan = JSON.parse(extractJSON(planResponse)) as typeof plan;
    if (!plan || typeof plan !== "object") {
      plan = { page_updates: [], new_pages: [] };
    }
    plan.page_updates = Array.isArray(plan.page_updates) ? plan.page_updates : [];
    plan.new_pages = Array.isArray(plan.new_pages) ? plan.new_pages : [];
  } catch (err) {
    emit({ type: "log", message: `Wiki incremental planning failed: ${err instanceof Error ? err.message : "unknown"}` });
    result.unchanged = config.existingPages.map((p) => p.slug);
    return result;
  }

  emit({ type: "log", message: `Wiki plan: ${plan.page_updates.length} pages to update, ${plan.new_pages.length} new pages` });

  const updatedSlugs = new Set<string>();

  // ── Step B: Generate updates per page ──
  for (const update of plan.page_updates) {
    const existingPage = config.existingPages.find((p) => p.slug === update.slug);
    if (!existingPage) continue;

    const relevantDiscoveries = update.relevant_discovery_indices
      .filter((i) => i >= 0 && i < config.newDiscoveries.length)
      .map((i) => config.newDiscoveries[i]!);

    if (relevantDiscoveries.length === 0) continue;

    emit({ type: "log", message: `Wiki incremental: updating "${existingPage.title}"...` });

    const discoveryDetails = relevantDiscoveries.map((d, i) =>
      `### Discovery ${i + 1}: "${d.title}"${d.url ? `\nURL: ${d.url}` : ""}\n${(d.fullText ?? d.abstract ?? "").slice(0, 4000)}`
    ).join("\n\n");

    const updatePrompt = `You are updating a mathematical research wiki page with new discoveries. Your job is to integrate new information while preserving all existing content.

PROJECT: ${config.projectTitle}

CURRENT PAGE CONTENT (title: "${existingPage.title}", slug: "${existingPage.slug}"):
---
${existingPage.content}
---

NEW DISCOVERIES TO INTEGRATE:
${discoveryDetails}

UPDATE REASON: ${update.reason}

Instructions:
- Output the FULL updated page content (not just the changes)
- PRESERVE all existing content — do not remove or shorten anything
- ADD new information from the discoveries in appropriate sections
- If needed, add new subsections for new topics
- Maintain the same markdown formatting style
- Add references/citations for new discoveries where appropriate
- Keep the [AI-GENERATED] tag if present
- Write in the same language as the existing content

Output ONLY the updated markdown content, nothing else.`;

    try {
      const updatedContent = await callAzureLLM(updatePrompt, {
        maxTokens: 128000,
        tokenCounter,
        tracker: { module: trackerModule, operation: "patrol-wiki-update" },
        timeoutMs: 1_800_000,
      });

      const content = updatedContent.trim();
      if (content.length >= existingPage.content.length * 0.8) {
        result.updates.push({
          pageSlug: existingPage.slug,
          pageTitle: existingPage.title,
          action: "update",
          newContent: content,
          changeSummary: update.reason,
        });
        updatedSlugs.add(existingPage.slug);
      } else {
        emit({ type: "log", message: `Wiki update for "${existingPage.title}" too short (${content.length} vs ${existingPage.content.length}), skipping` });
      }
    } catch (err) {
      emit({ type: "log", message: `Wiki update for "${existingPage.title}" failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  }

  // ── Step C: Generate new pages ──
  for (const newPage of plan.new_pages) {
    // Skip if slug already exists
    if (config.existingPages.some((p) => p.slug === newPage.slug)) continue;

    const relevantDiscoveries = newPage.relevant_discovery_indices
      .filter((i) => i >= 0 && i < config.newDiscoveries.length)
      .map((i) => config.newDiscoveries[i]!);

    if (relevantDiscoveries.length === 0) continue;

    emit({ type: "log", message: `Wiki incremental: creating new page "${newPage.title}"...` });

    const discoveryDetails = relevantDiscoveries.map((d, i) =>
      `### Discovery ${i + 1}: "${d.title}"${d.url ? `\nURL: ${d.url}` : ""}\n${(d.fullText ?? d.abstract ?? "").slice(0, 4000)}`
    ).join("\n\n");

    const createPrompt = `You are creating a new wiki page for a mathematical research project.

PROJECT: ${config.projectTitle}
DESCRIPTION: ${config.projectDescription}

NEW PAGE: "${newPage.title}" (slug: ${newPage.slug})
REASON: ${newPage.reason}

RELEVANT DISCOVERIES:
${discoveryDetails}

EXISTING EFFORTS (for context, ${config.existingEfforts.length} total):
${config.existingEfforts.slice(0, 15).map((e) => `- ${e.title}`).join("\n")}

Instructions:
- Write a comprehensive wiki page about this topic
- Use proper markdown formatting with headers
- Include references to the discoveries
- Add an [AI-GENERATED] tag at the top
- Write in English unless the project context suggests otherwise

Output ONLY the markdown content.`;

    try {
      const content = (await callAzureLLM(createPrompt, {
        maxTokens: 128000,
        tokenCounter,
        tracker: { module: trackerModule, operation: "patrol-wiki-create" },
        timeoutMs: 1_800_000,
      })).trim();

      if (content.length > 200) {
        result.updates.push({
          pageSlug: newPage.slug,
          pageTitle: newPage.title,
          action: "create",
          newContent: content.includes("[AI-GENERATED]") ? content : `> [AI-GENERATED] This content was automatically generated and requires human review.\n\n${content}`,
          changeSummary: newPage.reason,
        });
        updatedSlugs.add(newPage.slug);
      }
    } catch (err) {
      emit({ type: "log", message: `Wiki create "${newPage.title}" failed: ${err instanceof Error ? err.message : "unknown"}` });
    }
  }

  // Track unchanged pages
  result.unchanged = config.existingPages
    .filter((p) => !updatedSlugs.has(p.slug))
    .map((p) => p.slug);

  emit({ type: "log", message: `Wiki incremental complete: ${result.updates.length} updates, ${result.unchanged.length} unchanged` });
  return result;
}
