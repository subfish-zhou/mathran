import { callAzureLLM, extractJSON, DEFAULT_MATH_SYSTEM_PROMPT, TokenCounter } from "./azure-llm";
import type { WikiDraftPatch } from "./forum-wiki-sync";
import { logAgentRun, completeAgentRun, failAgentRun } from "./agent-logger";
import { mergeWikiContent } from "./shared/wiki-generator";
import { reviewAndRefinePages } from "./shared/review-verify";
import type { WikiPageOutput } from "./init-types";

// Re-export for convenience
export type { WikiDraftPatch };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EffortWikiSyncInput {
  projectId: string;
  effortId: string;
  effortTitle: string;
  effortDescription: string;
  effortDocument?: string;
  effortStatus: string;
  effortType?: string;
  linkedThreadId?: string;
  allWikiPages: {
    id: string;
    slug: string;
    title: string;
    content: string;
    version: number;
  }[];
}

export interface EffortWikiSyncResult {
  patches: WikiDraftPatch[];
  warnings: string[];
}

interface TriageTarget {
  pageSlug: string;
  action: "update_section" | "create_page";
  sectionHint?: string;
}

// Effort terminal statuses — kept in sync with workspace.efforts.updateStatus role matrix
// (see src/server/api/routers/workspace/efforts.ts W11 commit) and the auto-enqueue trigger.
const COMPLETE_STATUSES = ["VERIFIED", "MERGED", "DEAD_END", "REFERENCE", "SUPERSEDED"];
const WORKSHOP_SLUG = "workshop-exploratory-directions";
const WORKSHOP_TITLE = "Workshop — Exploratory Directions";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildEffortWikiPatches(
  input: EffortWikiSyncInput,
): Promise<EffortWikiSyncResult> {
  const { logger } = await logAgentRun({ agentType: 'effort-wiki-sync', targetType: 'effort', targetId: input.effortId, projectSlug: input.projectId });
  try {
    const warnings: string[] = [];
    const tokenCounter = new TokenCounter();
    const isComplete = COMPLETE_STATUSES.includes(input.effortStatus);

    // Step 1 — Triage: determine which pages to update
    const targets = await triageEffort(input, isComplete, warnings, tokenCounter);
    if (targets.length === 0) {
      const result = { patches: [], warnings };
      await completeAgentRun(logger, result);
      return result;
    }

    // Step 2 — Merge: generate updated content for each target page
    const patches = await mergeEffortIntoPages(input, targets, isComplete, warnings, tokenCounter);

    // Step 3 — Review: quality check via shared review pipeline
    if (patches.length > 0) {
      const pagesForReview: WikiPageOutput[] = patches.map(p => ({
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
      for (const patch of patches) {
        const reviewed = reviewResult.pages.find(rp => rp.slug === patch.pageSlug);
        if (reviewed) {
          patch.content = reviewed.content;
        }
      }
    }

    const result = { patches, warnings };
    await completeAgentRun(logger, result);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failAgentRun(logger, msg);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Step 1: Triage — single LLM call
// ---------------------------------------------------------------------------

async function triageEffort(
  input: EffortWikiSyncInput,
  isComplete: boolean,
  warnings: string[],
  tokenCounter?: TokenCounter,
): Promise<TriageTarget[]> {
  if (!isComplete) {
    // WIP efforts always go to Workshop page
    const workshopExists = input.allWikiPages.some(
      (p) => p.slug === WORKSHOP_SLUG,
    );
    return [
      {
        pageSlug: WORKSHOP_SLUG,
        action: workshopExists ? "update_section" : "create_page",
        sectionHint: `Add exploratory section for "${input.effortTitle}"`,
      },
    ];
  }

  // Completed efforts → LLM decides which formal wiki pages to update
  const pageSummaries = input.allWikiPages
    .map(
      (p) =>
        `- [${p.slug}] "${p.title}" — ${p.content.slice(0, 500).replace(/\n/g, " ")}`,
    )
    .join("\n");

  const triagePrompt = `You are a mathematical wiki editor. An effort has been completed and its findings should be incorporated into the project wiki.

Effort: "${input.effortTitle}" (ID: ${input.effortId}, Status: ${input.effortStatus}, Type: ${input.effortType ?? "unknown"})

Effort Description:
${input.effortDescription}

${input.effortDocument ? `Effort Document (full content):\n${input.effortDocument.slice(0, 4000)}` : ""}

Wiki pages:
${pageSummaries}

Determine which wiki pages should be updated to incorporate these findings. The effort is COMPLETE (${input.effortStatus}).

If there is a page with slug "${WORKSHOP_SLUG}" and this effort was previously listed there, include it so we can mark it as merged.

Return JSON array:
[{"pageSlug": "<slug>", "action": "update_section", "sectionHint": "<what to update>"}]

If a page needs to be created instead, use "action": "create_page".
Return empty array [] if no updates are needed.`;

  try {
    const raw = await callAzureLLM(triagePrompt, {
      systemPrompt: DEFAULT_MATH_SYSTEM_PROMPT,
      tokenCounter,
      tracker: {
        module: "wiki-sync",
        operation: "effort-triage",
        projectId: input.projectId,
      },
    });
    const parsed = JSON.parse(extractJSON(raw)) as TriageTarget[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    warnings.push("Failed to triage effort for wiki updates");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 2: Merge — LLM call per target page
// ---------------------------------------------------------------------------

async function mergeEffortIntoPages(
  input: EffortWikiSyncInput,
  targets: TriageTarget[],
  isComplete: boolean,
  warnings: string[],
  tokenCounter?: TokenCounter,
): Promise<WikiDraftPatch[]> {
  const patches: WikiDraftPatch[] = [];
  const pageBySlug = new Map(
    input.allWikiPages.map((p) => [p.slug, p]),
  );

  for (const target of targets) {
    const page = pageBySlug.get(target.pageSlug);

    if (target.action === "create_page" && !page) {
      // Create new page
      const patch = await generateNewPage(input, target, isComplete, warnings, tokenCounter);
      if (patch) patches.push(patch);
      continue;
    }

    if (!page) {
      warnings.push(
        `Skipping target slug=${target.pageSlug}: page not found`,
      );
      continue;
    }

    // Update existing page
    const patch = await generatePageUpdate(
      input,
      page,
      target,
      isComplete,
      warnings,
      tokenCounter,
    );
    if (patch) patches.push(patch);
  }

  return patches;
}

async function generatePageUpdate(
  input: EffortWikiSyncInput,
  page: { id: string; slug: string; title: string; content: string; version: number },
  target: TriageTarget,
  isComplete: boolean,
  warnings: string[],
  tokenCounter?: TokenCounter,
): Promise<WikiDraftPatch | null> {
  const isWorkshop = page.slug === WORKSHOP_SLUG;

  const effortContent = input.effortDocument ?? input.effortDescription;
  const threadRef = input.linkedThreadId
    ? `When referencing the linked forum thread, use @t:${input.linkedThreadId}.`
    : "";

  const mergePrompt = `You are a mathematical wiki editor. Incorporate the findings from ${isComplete ? "a COMPLETED" : "an in-progress"} effort into this wiki page.

${
  isWorkshop
    ? isComplete
      ? `This is the Workshop page. The effort "${input.effortTitle}" may have a section here from when it was in progress. If found, update that section to indicate "→ merged into relevant wiki pages" and keep a brief note. Do NOT remove the section entirely.`
      : `This is the Workshop page. Add a new exploratory section for this in-progress effort.`
    : `Preserve the existing page structure and content. Incorporate the new findings naturally — do not add a generic "Contributions" section or attribute by name.`
}

When referencing the effort, use @ws:${input.effortId}.
${threadRef}
When referencing other wiki pages, use @w:page-slug format.

Wiki page "${page.title}" (slug: ${page.slug}):
---
${page.content}
---

Effort: "${input.effortTitle}" (Status: ${input.effortStatus}, Type: ${input.effortType ?? "unknown"})
${target.sectionHint ? `Update hint: ${target.sectionHint}` : ""}

Effort content:
${effortContent}

Return the COMPLETE updated wiki page content in markdown. Do not truncate or summarize existing content. Output ONLY the markdown, no code fences.`;

  try {
    const raw = await callAzureLLM(mergePrompt, {
      maxTokens: 128000,
      systemPrompt: DEFAULT_MATH_SYSTEM_PROMPT,
      tokenCounter,
      tracker: {
        module: "wiki-sync",
        operation: "effort-merge",
        projectId: input.projectId,
      },
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
      return {
        pageId: page.id,
        pageSlug: page.slug,
        content,
        baseVersionNumber: page.version,
        title: page.title,
        changeSummary: isWorkshop
          ? `Marked "${input.effortTitle}" as merged in Workshop`
          : `Incorporated findings from effort "${input.effortTitle}"`,
        isNewPage: false,
      };
    }
    return null;
  } catch {
    warnings.push(`Failed to generate patch for ${page.slug}`);
    return null;
  }
}

async function generateNewPage(
  input: EffortWikiSyncInput,
  target: TriageTarget,
  isComplete: boolean,
  warnings: string[],
  tokenCounter?: TokenCounter,
): Promise<WikiDraftPatch | null> {
  // Only create Workshop page for now
  if (target.pageSlug !== WORKSHOP_SLUG) {
    warnings.push(
      `Skipping create_page for non-workshop slug: ${target.pageSlug}`,
    );
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const effortContent = input.effortDocument ?? input.effortDescription;
  const threadRef = input.linkedThreadId
    ? `- Use @t:${input.linkedThreadId} to reference the linked forum thread`
    : "";

  const prompt = `You are a mathematical wiki editor. Create a new Workshop page with an exploratory section for an ${isComplete ? "completed" : "in-progress"} effort.

Effort: "${input.effortTitle}" (ID: ${input.effortId}, Status: ${input.effortStatus})

Effort content:
${effortContent}

Instructions:
- Start with: # ${WORKSHOP_TITLE}
- Add intro paragraph explaining the page purpose
- Create a section: ## ${input.effortTitle} (${isComplete ? "Completed" : "In Progress"})
- Add date: *Added ${today}*
- Summarize the effort goals and findings
- Use @ws:${input.effortId} to reference the effort
${threadRef}
- Keep it concise but informative
- Output ONLY the full page markdown, no code fences`;

  try {
    const raw = await callAzureLLM(prompt, {
      maxTokens: 128000,
      systemPrompt: DEFAULT_MATH_SYSTEM_PROMPT,
      tokenCounter,
      tracker: {
        module: "wiki-sync",
        operation: "effort-create-workshop",
        projectId: input.projectId,
      },
    });
    const content = raw
      .replace(/^```(?:markdown|md)?\s*\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    if (content.length > 100) {
      return {
        pageId: "",
        pageSlug: WORKSHOP_SLUG,
        content,
        baseVersionNumber: 0,
        title: WORKSHOP_TITLE,
        changeSummary: `Created Workshop page with section for "${input.effortTitle}"`,
        isNewPage: true,
      };
    }
    return null;
  } catch {
    warnings.push("Failed to generate new Workshop page");
    return null;
  }
}
