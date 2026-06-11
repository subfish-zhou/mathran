/**
 * Wiki Patrol v2 — Extract → Match → Patch pipeline.
 *
 * Replaces the monolithic updateWikiIncremental() with a three-step approach:
 *   1. extractKnowledgeItems()  — extract discrete knowledge items from new papers
 *   2. matchKnowledgeToPlacements() — decide where each item goes in the wiki
 *   3. patchWikiSections()      — surgically patch only affected sections
 *
 * Also includes classifyDiscoveriesToEfforts() for smarter effort assignment.
 */

import { callAzureLLM, extractJSON, type TokenCounter } from "../azure-llm";

// ========== Types ==========

export interface KnowledgeItem {
  id: string;
  type: "result" | "technique" | "connection" | "open_problem" | "definition" | "historical";
  title: string;
  content: string;
  sourceDiscoveryIndex: number;
  relevantEfforts: string[];
  tags: string[];
}

export interface PlacementDecision {
  knowledgeItemId: string;
  action: "insert_section" | "append_to_section" | "new_page" | "skip";
  targetPageSlug: string;
  targetSectionHeading?: string;
  reason: string;
}

export interface WikiPatch {
  pageSlug: string;
  pageTitle: string;
  action: "update" | "create";
  newContent: string;
  changeSummary: string;
}

// ========== Helpers ==========

function extractSectionHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^(#{1,4})\s+(.+)/);
    if (match) {
      headings.push(match[2]!.trim());
    }
  }
  return headings;
}

/** Split page content into sections by ## headings. Returns array of { heading, content }. */
function splitIntoSections(content: string): Array<{ heading: string; content: string }> {
  const lines = content.split("\n");
  const sections: Array<{ heading: string; content: string }> = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      if (currentHeading || currentLines.length > 0) {
        sections.push({ heading: currentHeading, content: currentLines.join("\n") });
      }
      currentHeading = match[1]!.trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  if (currentHeading || currentLines.length > 0) {
    sections.push({ heading: currentHeading, content: currentLines.join("\n") });
  }
  return sections;
}

/** Reassemble sections into full page content */
function reassembleSections(sections: Array<{ heading: string; content: string }>): string {
  return sections.map((s) => s.content).join("\n");
}

// ========== Phase 1: Extract ==========

export interface ExtractConfig {
  discoveries: Array<{ title: string; abstract: string; fullText?: string; url?: string }>;
  existingEfforts: Array<{ title: string; description: string }>;
  projectTitle: string;
  trackerModule?: string;
}

export async function extractKnowledgeItems(
  config: ExtractConfig,
  tokenCounter: TokenCounter,
): Promise<KnowledgeItem[]> {
  const trackerModule = config.trackerModule ?? "patrol-agent";

  const discoverySummaries = config.discoveries
    .map(
      (d, i) =>
        `[${i}] "${d.title}"${d.url ? ` (${d.url})` : ""}\n${(d.fullText ?? d.abstract ?? "").slice(0, 4000)}`,
    )
    .join("\n\n---\n\n");

  const effortList = config.existingEfforts
    .slice(0, 40)
    .map((e) => `- ${e.title}: ${(e.description ?? "").slice(0, 200)}`)
    .join("\n");

  const prompt = `You are a mathematical research knowledge extractor. Given new paper discoveries and a project's existing research efforts, extract discrete knowledge items from the papers.

PROJECT: ${config.projectTitle}

EXISTING RESEARCH EFFORTS:
${effortList || "(none)"}

NEW PAPER DISCOVERIES:
${discoverySummaries}

Extract knowledge items — each is a self-contained piece of information (a result, technique, connection, open problem, definition, or historical note). Each item should be 1-3 paragraphs of markdown.

Output a JSON array:
[
  {
    "id": "ki-001",
    "type": "result",
    "title": "Short descriptive title",
    "content": "1-3 paragraphs of self-contained markdown describing this knowledge item. Use LaTeX ($...$) for math.",
    "sourceDiscoveryIndex": 0,
    "relevantEfforts": ["Effort Title 1"],
    "tags": ["keyword1", "keyword2"]
  }
]

Rules:
- Each item must be self-contained (understandable without reading the source paper)
- type must be one of: result, technique, connection, open_problem, definition, historical
- sourceDiscoveryIndex is 0-based, matching the discovery list above
- relevantEfforts: list titles of existing efforts this item relates to (empty array if none)
- tags: mathematical keywords for categorization
- Aim for 2-5 items per paper, fewer if papers overlap
- Skip trivial/obvious information
- Use proper LaTeX notation for mathematical expressions`;

  try {
    const response = await callAzureLLM(prompt, {
      maxTokens: 8192,
      tokenCounter,
      tracker: { module: trackerModule, operation: "patrol-wiki-v2-extract" },
      timeoutMs: 360_000,
    });

    const parsed = JSON.parse(extractJSON(response)) as unknown;
    if (!Array.isArray(parsed)) return [];

    return (parsed as KnowledgeItem[]).filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.title === "string" &&
        typeof item.content === "string" &&
        typeof item.sourceDiscoveryIndex === "number",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`extractKnowledgeItems failed: ${msg}`);
    throw new Error(`extractKnowledgeItems failed: ${msg}`);
  }
}

// ========== Phase 2: Match ==========

export interface MatchConfig {
  items: KnowledgeItem[];
  existingPages: Array<{ slug: string; title: string; content: string }>;
  projectTitle: string;
  trackerModule?: string;
}

export async function matchKnowledgeToPlacements(
  config: MatchConfig,
  tokenCounter: TokenCounter,
): Promise<PlacementDecision[]> {
  const trackerModule = config.trackerModule ?? "patrol-agent";

  if (config.items.length === 0) return [];

  // Build page structure summary (no LLM needed)
  const pageStructures = config.existingPages
    .map((p) => {
      const headings = extractSectionHeadings(p.content);
      const contentPreview = p.content.slice(0, 500);
      return `Page "${p.title}" (slug: ${p.slug}):\n  Sections: ${headings.length > 0 ? headings.map((h) => `"${h}"`).join(", ") : "(no headings)"}\n  Preview: ${contentPreview}...`;
    })
    .join("\n\n");

  const itemSummaries = config.items
    .map(
      (item) =>
        `[${item.id}] "${item.title}" (type: ${item.type})\n  ${item.content.slice(0, 200)}...`,
    )
    .join("\n\n");

  const prompt = `You are a wiki editor deciding where to place new knowledge items in an existing mathematical research wiki.

PROJECT: ${config.projectTitle}

EXISTING WIKI PAGES:
${pageStructures}

KNOWLEDGE ITEMS TO PLACE:
${itemSummaries}

For each knowledge item, decide the best placement:

Output a JSON array:
[
  {
    "knowledgeItemId": "ki-001",
    "action": "append_to_section",
    "targetPageSlug": "key-results",
    "targetSectionHeading": "Recent Progress",
    "reason": "This result extends the discussion in Recent Progress"
  }
]

Actions:
- "append_to_section": Add content to the end of an existing section
- "insert_section": Create a new subsection within a page
- "new_page": Create an entirely new wiki page (only if no existing page fits)
- "skip": Item is already covered by existing wiki content or is not worth adding

Rules:
- Prefer appending to existing sections over creating new ones
- Prefer updating existing pages over creating new pages
- Use "skip" if the wiki already discusses this topic adequately
- targetPageSlug must match an existing page slug (except for new_page)
- targetSectionHeading must match an existing heading in the target page (for append_to_section)
- For insert_section, targetSectionHeading is the new heading to create
- For new_page, targetPageSlug is the proposed slug for the new page`;

  try {
    const response = await callAzureLLM(prompt, {
      maxTokens: 4096,
      tokenCounter,
      tracker: { module: trackerModule, operation: "patrol-wiki-v2-match" },
      timeoutMs: 360_000,
    });

    const parsed = JSON.parse(extractJSON(response)) as unknown;
    if (!Array.isArray(parsed)) return [];

    return (parsed as PlacementDecision[]).filter(
      (p) =>
        p &&
        typeof p.knowledgeItemId === "string" &&
        typeof p.action === "string" &&
        typeof p.targetPageSlug === "string",
    );
  } catch (err) {
    console.error(
      `matchKnowledgeToPlacements failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return [];
  }
}

// ========== Phase 3: Patch ==========

export interface PatchConfig {
  placements: PlacementDecision[];
  items: KnowledgeItem[];
  existingPages: Array<{ slug: string; title: string; content: string }>;
  problem?: {
    title: string;
    formalStatement: string;
    description: string;
    tags: string[];
    mathStatus?: string;
  };
  workspace?: {
    efforts: Array<{
      title: string;
      description: string;
      document?: string;
      type?: string;
    }>;
    edges: unknown[];
  };
  trackerModule?: string;
}

export async function patchWikiSections(
  config: PatchConfig,
  tokenCounter: TokenCounter,
  emit: (event: Record<string, unknown>) => void,
): Promise<WikiPatch[]> {
  const trackerModule = config.trackerModule ?? "patrol-agent";
  const itemMap = new Map(config.items.map((item) => [item.id, item]));
  const patches: WikiPatch[] = [];

  // Group placements by target page
  const pageGroups = new Map<
    string,
    { placements: PlacementDecision[]; items: KnowledgeItem[] }
  >();

  for (const placement of config.placements) {
    if (placement.action === "skip") continue;

    const item = itemMap.get(placement.knowledgeItemId);
    if (!item) continue;

    const key = placement.targetPageSlug;
    if (!pageGroups.has(key)) {
      pageGroups.set(key, { placements: [], items: [] });
    }
    const group = pageGroups.get(key)!;
    group.placements.push(placement);
    group.items.push(item);
  }

  // Process each page
  for (const [slug, group] of pageGroups) {
    const existingPage = config.existingPages.find((p) => p.slug === slug);

    // Check if this is a new page
    const isNewPage = group.placements.some((p) => p.action === "new_page");

    if (isNewPage && !existingPage) {
      // Create new page
      emit({ type: "log", message: `Wiki v2 patch: creating new page "${slug}"...` });
      try {
        const patch = await createNewPage(
          slug,
          group.items,
          config,
          tokenCounter,
          trackerModule,
        );
        if (patch) patches.push(patch);
      } catch (err) {
        emit({
          type: "log",
          message: `Failed to create new page "${slug}": ${err instanceof Error ? err.message : "unknown"}`,
        });
      }
      continue;
    }

    if (!existingPage) {
      emit({
        type: "log",
        message: `Wiki v2 patch: page "${slug}" not found, skipping`,
      });
      continue;
    }

    // Patch existing page
    emit({
      type: "log",
      message: `Wiki v2 patch: updating "${existingPage.title}" with ${group.items.length} items...`,
    });

    try {
      const sections = splitIntoSections(existingPage.content);
      const changeSummaries: string[] = [];

      for (const placement of group.placements) {
        const item = itemMap.get(placement.knowledgeItemId);
        if (!item) continue;

        if (placement.action === "append_to_section") {
          // Find target section
          const sectionIdx = sections.findIndex(
            (s) =>
              s.heading.toLowerCase() ===
              (placement.targetSectionHeading ?? "").toLowerCase(),
          );
          if (sectionIdx === -1) {
            // Fallback: append to last section
            emit({
              type: "log",
              message: `Section "${placement.targetSectionHeading}" not found in "${existingPage.title}", appending to end`,
            });
            const lastIdx = sections.length - 1;
            if (lastIdx >= 0) {
              const updatedSection = await patchSingleSection(
                sections[lastIdx]!.content,
                item,
                "append",
                existingPage.title,
                tokenCounter,
                trackerModule,
              );
              sections[lastIdx] = {
                heading: sections[lastIdx]!.heading,
                content: updatedSection,
              };
            }
          } else {
            const updatedSection = await patchSingleSection(
              sections[sectionIdx]!.content,
              item,
              "append",
              existingPage.title,
              tokenCounter,
              trackerModule,
            );
            sections[sectionIdx] = {
              heading: sections[sectionIdx]!.heading,
              content: updatedSection,
            };
          }
          changeSummaries.push(`Added "${item.title}" to ${placement.targetSectionHeading ?? "page"}`);
        } else if (placement.action === "insert_section") {
          // Create a new section and insert it
          const newSectionContent = await patchSingleSection(
            "",
            item,
            "new_section",
            existingPage.title,
            tokenCounter,
            trackerModule,
          );
          const newSection = {
            heading: placement.targetSectionHeading ?? item.title,
            content: newSectionContent,
          };
          // Insert before the last section (or at end)
          sections.push(newSection);
          changeSummaries.push(`New section "${placement.targetSectionHeading ?? item.title}"`);
        }
      }

      const newContent = reassembleSections(sections);
      if (newContent.trim() !== existingPage.content.trim()) {
        patches.push({
          pageSlug: slug,
          pageTitle: existingPage.title,
          action: "update",
          newContent,
          changeSummary: changeSummaries.join("; "),
        });
      }
    } catch (err) {
      emit({
        type: "log",
        message: `Failed to patch page "${slug}": ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }

  return patches;
}

async function patchSingleSection(
  existingContent: string,
  item: KnowledgeItem,
  mode: "append" | "new_section",
  pageTitle: string,
  tokenCounter: TokenCounter,
  trackerModule: string,
): Promise<string> {
  if (mode === "new_section") {
    const prompt = `You are editing a mathematical research wiki page titled "${pageTitle}".

Create a new section for the following knowledge item. Output ONLY the section content (including the ## heading).

KNOWLEDGE ITEM:
Title: ${item.title}
Type: ${item.type}
Content: ${item.content}

Write a well-structured wiki section with:
- A ## heading
- Clear mathematical exposition
- Proper LaTeX notation ($...$ for inline, $$...$$ for display)
- Academic tone consistent with a research wiki`;

    return await callAzureLLM(prompt, {
      maxTokens: 4096,
      tokenCounter,
      tracker: { module: trackerModule, operation: "patrol-wiki-v2-patch-section" },
      timeoutMs: 180_000,
    });
  }

  // Append mode
  const prompt = `You are editing a mathematical research wiki page titled "${pageTitle}".

Here is an existing section of the page:
---
${existingContent}
---

Add the following new knowledge item to this section. Integrate it naturally — add it at an appropriate place (usually near the end), maintaining consistent style and formatting.

KNOWLEDGE ITEM TO ADD:
Title: ${item.title}
Type: ${item.type}
Content: ${item.content}

Output the COMPLETE updated section (including the ## heading line if present). Do NOT remove or significantly modify existing content — only ADD the new information.`;

  return await callAzureLLM(prompt, {
    maxTokens: 4096,
    tokenCounter,
    tracker: { module: trackerModule, operation: "patrol-wiki-v2-patch-section" },
    timeoutMs: 180_000,
  });
}

async function createNewPage(
  slug: string,
  items: KnowledgeItem[],
  config: PatchConfig,
  tokenCounter: TokenCounter,
  trackerModule: string,
): Promise<WikiPatch | null> {
  const pageTitle =
    items.length === 1
      ? items[0]!.title
      : `${items[0]!.title} and Related Results`;

  // Try to use buildSinglePagePrompt for high-quality generation
  if (config.problem && config.workspace) {
    try {
      const { buildSinglePagePrompt } = await import("../init-prompts");
      const problemWithBg = {
        ...config.problem,
        backgroundSummary: config.problem.description,
      };
      const workspaceForPrompt = {
        efforts: config.workspace.efforts.map((e) => ({
          id: e.title.toLowerCase().replace(/\s+/g, "-"),
          type: e.type ?? "METHOD",
          title: e.title,
          description: e.description,
          status: "ACTIVE",
          document: e.document,
        })),
        edges: config.workspace.edges as Array<{ source: string; target: string; label: string }>,
      };
      const prompt = buildSinglePagePrompt(
        problemWithBg,
        workspaceForPrompt as unknown as Parameters<typeof buildSinglePagePrompt>[1],
        { slug, title: pageTitle, instruction: `Write about: ${items.map((i) => i.title).join(", ")}` },
        config.problem.mathStatus,
        config.existingPages.map((p) => p.title),
      );

      // Augment prompt with the specific knowledge items
      const augmented = `${prompt}\n\nIMPORTANT: This page must include the following specific knowledge items:\n${items.map((item) => `- ${item.title}: ${item.content.slice(0, 500)}`).join("\n")}`;

      const content = await callAzureLLM(augmented, {
        maxTokens: 16384,
        tokenCounter,
        tracker: { module: trackerModule, operation: "patrol-wiki-v2-new-page" },
        timeoutMs: 1_800_000,
      });

      return {
        pageSlug: slug,
        pageTitle,
        action: "create",
        newContent: content,
        changeSummary: `New page with ${items.length} knowledge items`,
      };
    } catch {
      // Fall through to simple prompt
    }
  }

  // Simple fallback prompt
  const itemDescriptions = items
    .map((item) => `### ${item.title}\nType: ${item.type}\n\n${item.content}`)
    .join("\n\n---\n\n");

  const prompt = `You are creating a new mathematical research wiki page.

PAGE TITLE: ${pageTitle}
PAGE SLUG: ${slug}

Create a well-structured wiki page incorporating the following knowledge items:

${itemDescriptions}

Requirements:
- Start with a brief introduction paragraph
- Organize content with clear ## section headings
- Use proper LaTeX notation ($...$ for inline, $$...$$ for display)
- Academic tone consistent with a research wiki
- Include connections between items where relevant
- End with a brief summary or outlook section if appropriate`;

  const content = await callAzureLLM(prompt, {
    maxTokens: 16384,
    tokenCounter,
    tracker: { module: trackerModule, operation: "patrol-wiki-v2-new-page" },
    timeoutMs: 1_800_000,
  });

  return {
    pageSlug: slug,
    pageTitle,
    action: "create",
    newContent: content,
    changeSummary: `New page with ${items.length} knowledge items`,
  };
}

// ========== Effort Classification ==========

export interface ClassifyEffortsConfig {
  discoveries: Array<{ title: string; abstract: string }>;
  existingEfforts: Array<{ id: string; title: string; description: string }>;
  projectTitle: string;
  trackerModule?: string;
}

export interface ClassifyEffortsResult {
  /** Maps existing effort id -> array of discovery indices that belong to it */
  existing: Map<string, number[]>;
  /** Discovery indices that need new efforts created */
  newDiscoveryIndices: number[];
}

export async function classifyDiscoveriesToEfforts(
  config: ClassifyEffortsConfig,
  tokenCounter: TokenCounter,
): Promise<ClassifyEffortsResult> {
  const trackerModule = config.trackerModule ?? "patrol-agent";
  const result: ClassifyEffortsResult = {
    existing: new Map(),
    newDiscoveryIndices: [],
  };

  if (config.discoveries.length === 0) return result;

  if (config.existingEfforts.length === 0) {
    // No existing efforts, all discoveries need new efforts
    result.newDiscoveryIndices = config.discoveries.map((_, i) => i);
    return result;
  }

  const effortList = config.existingEfforts
    .map((e) => `[${e.id}] "${e.title}": ${(e.description ?? "").slice(0, 200)}`)
    .join("\n");

  const discoveryList = config.discoveries
    .map(
      (d, i) =>
        `[${i}] "${d.title}"\n   ${(d.abstract ?? "").slice(0, 300)}`,
    )
    .join("\n\n");

  const prompt = `You are classifying new paper discoveries into existing research efforts for the project "${config.projectTitle}".

EXISTING EFFORTS:
${effortList}

NEW DISCOVERIES:
${discoveryList}

For each discovery, decide: should it be assigned to an existing effort, or does it need a new effort?

Output JSON:
{
  "assignments": [
    { "discoveryIndex": 0, "effortId": "existing-effort-id", "reason": "why it fits" },
    { "discoveryIndex": 1, "effortId": "NEW", "reason": "why it needs a new effort" }
  ]
}

Rules:
- Use the effort id from the list above for existing efforts
- Use "NEW" as effortId if no existing effort fits well
- A discovery can only be assigned to ONE effort
- Prefer assigning to existing efforts when there's a reasonable match
- Only mark as NEW if the discovery represents a genuinely different research direction`;

  try {
    const response = await callAzureLLM(prompt, {
      maxTokens: 4096,
      tokenCounter,
      tracker: { module: trackerModule, operation: "patrol-wiki-v2-classify-efforts" },
      timeoutMs: 360_000,
    });

    const parsed = JSON.parse(extractJSON(response)) as {
      assignments?: Array<{ discoveryIndex: number; effortId: string; reason?: string }>;
    };

    if (!parsed.assignments || !Array.isArray(parsed.assignments)) {
      // Fallback: all new
      result.newDiscoveryIndices = config.discoveries.map((_, i) => i);
      return result;
    }

    for (const assignment of parsed.assignments) {
      if (
        typeof assignment.discoveryIndex !== "number" ||
        assignment.discoveryIndex < 0 ||
        assignment.discoveryIndex >= config.discoveries.length
      ) {
        continue;
      }

      if (assignment.effortId === "NEW") {
        result.newDiscoveryIndices.push(assignment.discoveryIndex);
      } else {
        // Verify effort exists
        const effortExists = config.existingEfforts.some(
          (e) => e.id === assignment.effortId,
        );
        if (effortExists) {
          if (!result.existing.has(assignment.effortId)) {
            result.existing.set(assignment.effortId, []);
          }
          result.existing.get(assignment.effortId)!.push(assignment.discoveryIndex);
        } else {
          result.newDiscoveryIndices.push(assignment.discoveryIndex);
        }
      }
    }

    // Any unassigned discoveries default to new
    const assigned = new Set([
      ...result.newDiscoveryIndices,
      ...[...result.existing.values()].flat(),
    ]);
    for (let i = 0; i < config.discoveries.length; i++) {
      if (!assigned.has(i)) {
        result.newDiscoveryIndices.push(i);
      }
    }
  } catch (err) {
    console.error(
      `classifyDiscoveriesToEfforts failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    result.newDiscoveryIndices = config.discoveries.map((_, i) => i);
  }

  return result;
}
