import { callAzureLLM, extractJSON, DEFAULT_MATH_SYSTEM_PROMPT, TokenCounter } from "./azure-llm";
import { logAgentRun, completeAgentRun, failAgentRun } from "./agent-logger";
import { mergeWikiContent } from "./shared/wiki-generator";
import { reviewAndRefinePages } from "./shared/review-verify";
import type { WikiPageOutput } from "./init-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Legacy type kept for wiki-sync-engine compatibility */
export interface ForumPushChange {
  postId: string;
  threadId: string;
  action: "created" | "updated";
  title: string;
  body: string;
  authorName: string;
  qualityScore?: number;
  isInsightful?: boolean;
}

export interface ThreadSummary {
  summary: string;
  turningPoints?: string[];
  disagreements?: string[];
  evolution?: string[];
  conclusion?: string;
}

export interface ForumWikiSyncInput {
  threadId: string;
  threadTitle: string;
  threadSummary: ThreadSummary;
  effort: {
    id: string;
    title: string;
    description: string;
    status: string;
  };
  wikiPages: readonly { id: string; slug: string; title: string; content: string; version: number }[];
  projectId: string;
  projectTitle?: string;
}

export interface WikiDraftPatch {
  pageId: string;
  pageSlug: string;
  content: string;
  baseVersionNumber: number;
  title: string;
  changeSummary: string;
  isNewPage: boolean;
}

export interface ForumWikiSyncResult {
  patches: WikiDraftPatch[];
  warnings: string[];
}

// Effort terminal statuses — kept in sync with workspace.efforts.updateStatus role matrix
// (see src/server/api/routers/workspace/efforts.ts W11 commit) and the auto-enqueue trigger.
const COMPLETE_STATUSES = ["VERIFIED", "MERGED", "DEAD_END", "REFERENCE", "SUPERSEDED"];
const WORKSHOP_SLUG = "workshop-exploratory-directions";
const WORKSHOP_TITLE = "Workshop — Exploratory Directions";

function appendUniqueWorkshopSection(existingContent: string, newSection: string): string {
  const seen = new Set<string>();
  return [...existingContent.trimEnd().split(/\n(?=##\s+)/), newSection.trim()]
    .filter(Boolean)
    .filter((section) => {
      const key = section.replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildForumWikiPatches(
  input: ForumWikiSyncInput
): Promise<ForumWikiSyncResult> {
  const { logger } = await logAgentRun({ agentType: 'forum-wiki-sync', targetType: 'thread', targetId: input.threadId, projectSlug: input.projectId });
  try {
    const warnings: string[] = [];
    const tokenCounter = new TokenCounter();
    const isComplete = COMPLETE_STATUSES.includes(input.effort.status);

    let result: ForumWikiSyncResult;
    if (isComplete) {
      result = await buildCompletePatches(input, warnings, tokenCounter);
    } else {
      result = await buildIncompletePatches(input, warnings, tokenCounter);
    }

    // Review patches via shared review pipeline
    if (result.patches.length > 0) {
      const pagesForReview: WikiPageOutput[] = result.patches.map(p => ({
        slug: p.pageSlug,
        title: p.title,
        content: p.content,
        workspaceRefs: [],
      }));
      const noopEmit = (_event: Record<string, unknown>) => { /* no-op */ };
      const reviewResult = await reviewAndRefinePages(
        { pages: pagesForReview, resources: [] },
        noopEmit,
        tokenCounter,
      );
      for (const patch of result.patches) {
        const reviewed = reviewResult.pages.find(rp => rp.slug === patch.pageSlug);
        if (reviewed) {
          patch.content = reviewed.content;
        }
      }
    }

    await completeAgentRun(logger, result);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failAgentRun(logger, msg);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Path A: Incomplete effort → Workshop page
// ---------------------------------------------------------------------------

async function buildIncompletePatches(
  input: ForumWikiSyncInput,
  warnings: string[],
  tokenCounter?: TokenCounter,
): Promise<ForumWikiSyncResult> {
  const workshopPage = input.wikiPages.find(p => p.slug === WORKSHOP_SLUG);
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are a mathematical wiki editor. Structure the following thread summary and effort description into a new section for the "Workshop — Exploratory Directions" wiki page.

This is an INCOMPLETE/in-progress effort. Format it as an exploratory section.

Thread: "${input.threadTitle}" (ID: ${input.threadId})
Effort: "${input.effort.title}" (ID: ${input.effort.id}, Status: ${input.effort.status})

Thread Summary:
${JSON.stringify(input.threadSummary, null, 2)}

Effort Description:
${input.effort.description}

Instructions:
- Create a section with heading: ## ${input.effort.title} (In Progress)
- Add date: *Added ${today}*
- Summarize the thread discussion and effort goals
- Use @t:${input.threadId} to reference the forum thread
- Use @ws:${input.effort.id} to reference the effort
- Keep it concise but informative
- Output ONLY the new section markdown (not the full page)`;

  let newSection: string;
  try {
    const raw = await callAzureLLM(prompt, {
      maxTokens: 128000,
      systemPrompt: DEFAULT_MATH_SYSTEM_PROMPT,
      tokenCounter,
      tracker: { module: "wiki-sync", operation: "workshop-section" },
    });
    newSection = raw
      .replace(/^```(?:markdown|md)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();
  } catch {
    warnings.push("Failed to generate workshop section via LLM");
    return { patches: [], warnings };
  }

  if (workshopPage) {
    // Append to existing workshop page
    const updatedContent = appendUniqueWorkshopSection(workshopPage.content, newSection);
    return {
      patches: [{
        pageId: workshopPage.id,
        pageSlug: WORKSHOP_SLUG,
        content: postProcessForumReferences(updatedContent, input),
        baseVersionNumber: workshopPage.version,
        title: WORKSHOP_TITLE,
        changeSummary: `Added exploratory section for "${input.effort.title}" from forum thread`,
        isNewPage: false,
      }],
      warnings,
    };
  } else {
    // Create new workshop page
    const header = `# ${WORKSHOP_TITLE}

This page collects in-progress explorations, early-stage ideas, and ongoing discussions that haven't yet reached a conclusion. Once an effort is verified or merged, its findings will be incorporated into the relevant wiki pages.

---

`;
    const content = header + newSection;
    return {
      patches: [{
        pageId: "", // will be created
        pageSlug: WORKSHOP_SLUG,
        content: postProcessForumReferences(content, input),
        baseVersionNumber: 0,
        title: WORKSHOP_TITLE,
        changeSummary: `Created Workshop page with exploratory section for "${input.effort.title}"`,
        isNewPage: true,
      }],
      warnings,
    };
  }
}

// ---------------------------------------------------------------------------
// Path B: Complete effort → LLM-driven wiki integration
// ---------------------------------------------------------------------------

async function buildCompletePatches(
  input: ForumWikiSyncInput,
  warnings: string[],
  tokenCounter?: TokenCounter,
): Promise<ForumWikiSyncResult> {
  const patches: WikiDraftPatch[] = [];

  const wikiSummary = input.wikiPages
    .map(p => `- [${p.slug}] "${p.title}" (id: ${p.id})`)
    .join("\n");

  // Step 1: Triage — which pages to update
  const triagePrompt = `You are a mathematical wiki editor. A forum thread has reached completion and its findings should be incorporated into the project wiki.

Project: "${input.projectTitle ?? input.projectId}"

Thread: "${input.threadTitle}" (ID: ${input.threadId})
Effort: "${input.effort.title}" (Status: ${input.effort.status})

Thread Summary:
${JSON.stringify(input.threadSummary, null, 2)}

Effort Description:
${input.effort.description}

Wiki pages:
${wikiSummary}

Determine which wiki pages should be updated to incorporate these findings. The effort is COMPLETE (${input.effort.status}).

Also check if there's a page with slug "workshop-exploratory-directions" — if this effort was previously listed there, include it so we can mark it as merged.

Return JSON array:
[{"pageId": "<page-id>", "slug": "<slug>", "reason": "<why>"}]

Return empty array [] if no updates are needed.`;

  let targets: Array<{ pageId: string; slug: string; reason: string }>;
  try {
    const raw = await callAzureLLM(triagePrompt, {
      systemPrompt: DEFAULT_MATH_SYSTEM_PROMPT,
      tokenCounter,
      tracker: { module: "wiki-sync", operation: "complete-triage" },
    });
    try {
      targets = JSON.parse(extractJSON(raw)) ?? [];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[forum-wiki-sync] Failed to parse triage JSON; falling back to no targets:", msg, raw.slice(0, 200));
      warnings.push("Triage JSON parse errors: 1; falling back to no wiki targets");
      targets = [];
    }
  } catch {
    warnings.push("Failed to triage completed effort for wiki updates");
    return { patches: [], warnings };
  }

  if (targets.length === 0) {
    return { patches: [], warnings };
  }

  // Step 2: Generate patches for each target page
  const pageById = new Map(input.wikiPages.map(p => [p.id, p]));
  const pageBySlug = new Map(input.wikiPages.map(p => [p.slug, p]));

  for (const target of targets) {
    const page = pageById.get(target.pageId) ?? pageBySlug.get(target.slug);
    if (!page) {
      warnings.push(`Skipping target slug=${target.slug}: page not found`);
      continue;
    }

    const isWorkshop = page.slug === WORKSHOP_SLUG;

    const mergePrompt = `You are a mathematical wiki editor. Incorporate the findings from a COMPLETED forum effort into this wiki page.

${isWorkshop
  ? `This is the Workshop page. The effort "${input.effort.title}" may have a section here from when it was in progress. If found, update that section to indicate "→ merged into relevant wiki pages" and keep a brief note. Do NOT remove the section entirely.`
  : `Preserve the existing page structure and content. Incorporate the new findings naturally — do not add a "Forum Contributions" section or attribute by name.`
}

When referencing the forum thread, use @t:${input.threadId}.
When referencing the effort, use @ws:${input.effort.id}.

Wiki page "${page.title}" (slug: ${page.slug}):
---
${page.content}
---

Completed effort: "${input.effort.title}" (Status: ${input.effort.status})
Thread: "${input.threadTitle}"

Thread Summary:
${JSON.stringify(input.threadSummary, null, 2)}

Effort Description:
${input.effort.description}

Reason for updating this page: ${target.reason}

Return the COMPLETE updated wiki page content in markdown. Do not truncate or summarize existing content.`;

    try {
      const raw = await callAzureLLM(mergePrompt, {
        maxTokens: 128000,
        systemPrompt: DEFAULT_MATH_SYSTEM_PROMPT,
        tokenCounter,
        tracker: { module: "wiki-sync", operation: "complete-merge" },
      });
      let content = raw
        .replace(/^```(?:markdown|md)?\s*\n?/i, "")
        .replace(/\n?```\s*$/, "")
        .trim();

      // Section-level merge with existing page content
      const existingPageOutput: WikiPageOutput = {
        slug: page.slug,
        title: page.title,
        content: page.content,
        workspaceRefs: [],
      };
      const newPageOutput: WikiPageOutput = {
        slug: page.slug,
        title: page.title,
        content,
        workspaceRefs: [],
      };
      const merged = mergeWikiContent([existingPageOutput], [newPageOutput]);
      const mergedPage = merged.find(p => p.slug === page.slug);
      if (mergedPage) {
        content = mergedPage.content;
      }

      if (content.length > 100) {
        patches.push({
          pageId: page.id,
          pageSlug: page.slug,
          content: postProcessForumReferences(content, input),
          baseVersionNumber: page.version,
          title: page.title,
          changeSummary: isWorkshop
            ? `Marked "${input.effort.title}" as merged in Workshop`
            : `Incorporated findings from completed effort "${input.effort.title}"`,
          isNewPage: false,
        });
      }
    } catch {
      warnings.push(`Failed to generate patch for ${page.slug}`);
    }
  }

  return { patches, warnings };
}

// ---------------------------------------------------------------------------
// Post-process: no-op for now. Thread/effort refs ([[thread:UUID|text]],
// [[effort:UUID|text]]) don't need quote-reference upgrading. If we later
// pass individual post IDs, we can re-enable post-level quote refs here.
// ---------------------------------------------------------------------------

function postProcessForumReferences(
  content: string,
  _input: ForumWikiSyncInput,
): string {
  return content;
}
