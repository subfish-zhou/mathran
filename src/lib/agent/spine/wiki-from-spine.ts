/**
 * Spine-First Architecture — Wiki Generation from Spine
 *
 * Generates wiki pages driven by the Narrative Spine structure:
 *   - Overview: eras + globalThesis → Historical narrative
 *   - Key Results: timeline nodes → Chronological milestone chronicle
 *   - Techniques: threads → Per-thread technical exposition
 *   - Open Problems: openQuestions + barrier nodes → Precise open question catalog
 *   - Bibliography: paper graph → Grouped reference list
 *
 * The spine provides the OUTLINE; LLM only needs to EXPAND structured content
 * into readable prose — no more discovering structure and writing simultaneously.
 */

import { callAzureLLM, type TokenCounter } from "../azure-llm";
import { chunkString } from "../init-parsers";
import { extractWorkspaceRefs, repairWorkspaceRefs } from "../ref-utils";
import {
  buildOverviewFromSpinePrompt,
  buildKeyResultsFromSpinePrompt,
  buildTechniquesFromSpinePrompt,
  buildOpenProblemsFromSpinePrompt,
  buildBibliographyFromSpinePrompt,
} from "./prompts";
import type { NarrativeSpine, SpineDiff, SpinePipelineEvent } from "./types";
import type { WikiPageOutput, WorkspaceEffortOutput } from "../init-types";

// ============================================================
//  Config
// ============================================================

export interface WikiFromSpineConfig {
  spine: NarrativeSpine;
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    tags: string[];
    mathStatus?: string;
  };
  /** Only regenerate specific pages (patrol incremental) */
  onlySlugs?: string[];
  /** Paper IDs in the project (for bibliography) */
  paperIds: string[];
  /** Generated workspace efforts, used to produce valid @ws links */
  workspaceEfforts?: WorkspaceEffortOutput[];
}

// ============================================================
//  Main Entry Point
// ============================================================

export async function generateWikiFromSpine(
  config: WikiFromSpineConfig,
  emit: (e: SpinePipelineEvent) => void,
  tokenCounter: TokenCounter,
): Promise<WikiPageOutput[]> {
  const { spine, problem } = config;
  const pages: WikiPageOutput[] = [];
  const allSlugs = config.onlySlugs ?? ["overview", "key-results", "techniques", "open-problems", "bibliography"];

  emit({ type: "log", message: `Generating ${allSlugs.length} wiki pages from spine (${spine.nodes.length} nodes, ${spine.threads.length} threads)` });

  const failures: Array<{ slug: string; title: string; error: string }> = [];

  // Generate each page
  for (const slug of allSlugs) {
    const generator = PAGE_GENERATORS[slug];
    if (!generator) {
      emit({ type: "log", message: `Unknown wiki page slug: ${slug}, skipping` });
      continue;
    }

    const title = generator.titleFn(problem.title);
    emit({ type: "wiki_page_start", slug, title });
    emit({ type: "log", message: `Writing: ${title}...` });

    try {
      const prompt = withWorkspaceReferenceContext(generator.promptFn(config), config.workspaceEfforts ?? []);
      const content = await callAzureLLM(prompt, {
        tokenCounter,
        tracker: { module: "spine-wiki", operation: `wiki-${slug}` },
        timeoutMs: 900_000,
      });

      // Ensure AI-GENERATED tag
      const taggedContent = content.includes("[AI-GENERATED]")
        ? content
        : `> [AI-GENERATED] This content was automatically generated and requires human review.\n\n${content}`;
      const repaired = repairWorkspaceRefs(taggedContent, config.workspaceEfforts ?? []);
      if (repaired.fixedRefs > 0 || repaired.removedRefs > 0) {
        emit({
          type: "log",
          message: `Workspace refs repaired in "${title}": ${repaired.fixedRefs} fixed, ${repaired.removedRefs} removed`,
        });
      }

      const page: WikiPageOutput = {
        slug,
        title,
        content: repaired.content,
        workspaceRefs: extractWorkspaceRefs(repaired.content),
      };
      pages.push(page);

      // Emit content in chunks for streaming
      const chunks = chunkString(page.content, 300);
      for (const chunk of chunks) {
        emit({ type: "wiki_page_chunk", slug, chunk });
      }
      emit({ type: "wiki_page_complete", slug });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      failures.push({ slug, title, error: msg });
      // H2: surface the failure as a first-class error event so downstream
      // pipelines / frontends can distinguish "LLM error" from "empty page".
      // We still emit wiki_page_complete to avoid the frontend showing a
      // perpetually-loading skeleton, but we also add a STUB page with an
      // explicit failure marker so `applyInitResult` doesn't silently drop
      // the page (and subsequent completeness checks can regenerate).
      emit({ type: "log", message: `❌ Page "${title}" generation failed: ${msg}` });
      const stubContent = `> [AI-GENERATED] [GENERATION-FAILED] Automatic generation failed: ${msg}\n\nThis page is a placeholder. Please retry or edit manually.`;
      pages.push({
        slug,
        title,
        content: stubContent,
        workspaceRefs: [],
      });
      emit({ type: "wiki_page_complete", slug });
    }
  }

  // H2: if *every* page failed, throw so the pipeline goes to "error" state
  // instead of completing silently with five stub pages (the previous
  // behaviour produced an empty-looking completed run).
  if (pages.length > 0 && failures.length === pages.length) {
    throw new Error(
      `Wiki generation failed for all ${pages.length} pages. First error: ${failures[0]!.error}`,
    );
  }
  if (failures.length > 0) {
    emit({
      type: "log",
      message: `⚠️ Wiki generation partially failed: ${failures.length}/${pages.length} pages placeholdered`,
    });
  }

  // Set parent hierarchy: first page is root, rest are children
  if (pages.length > 0) {
    for (let i = 1; i < pages.length; i++) {
      pages[i]!.parentSlug = pages[0]!.slug;
    }
  }

  emit({ type: "log", message: `Wiki generation complete: ${pages.length} pages` });
  return pages;
}

function withWorkspaceReferenceContext(prompt: string, efforts: WorkspaceEffortOutput[]): string {
  if (efforts.length === 0) return prompt;

  const effortList = efforts
    .map((effort) => {
      const sourceHint = effort.sources?.[0]
        ? `; source: ${effort.sources[0].authors.slice(0, 2).join(", ")}${effort.sources[0].year ? ` ${effort.sources[0].year}` : ""}`
        : "";
      return `- @ws:${effort.id} "${effort.title}" (${effort.type}, ${effort.status}${sourceHint})`;
    })
    .join("\n");

  return `${prompt}

## Workspace Effort Link Contract

Use ONLY the following exact @ws IDs when cross-referencing workspace efforts:
${effortList}

Do not invent citation-key @ws references such as @ws:Tao2017. If you cite a paper or result and no matching effort is listed above, use plain text instead of @ws.`;
}

// ============================================================
//  Per-Page Generators
// ============================================================

interface PageGenerator {
  titleFn: (problemTitle: string) => string;
  promptFn: (config: WikiFromSpineConfig) => string;
}

const PAGE_GENERATORS: Record<string, PageGenerator> = {
  overview: {
    titleFn: (t) => `Overview — ${t}`,
    promptFn: (config) => buildOverviewFromSpinePrompt(
      config.problem,
      config.spine,
      config.problem.mathStatus,
    ),
  },

  "key-results": {
    titleFn: () => "Key Results & Timeline",
    promptFn: (config) => {
      const timelineNodes = config.spine.nodes
        .filter((n) => ["milestone", "refinement", "technique_origin", "bridge", "foundation"].includes(n.type))
        .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
      return buildKeyResultsFromSpinePrompt(config.problem, timelineNodes, config.spine);
    },
  },

  techniques: {
    titleFn: () => "Technical Methods",
    promptFn: (config) => buildTechniquesFromSpinePrompt(
      config.problem,
      config.spine.threads.filter((t) => t.status !== "dead_end"),
      config.spine,
    ),
  },

  "open-problems": {
    titleFn: () => "Open Problems",
    promptFn: (config) => {
      const barrierNodes = config.spine.nodes.filter((n) => n.type === "barrier");
      return buildOpenProblemsFromSpinePrompt(config.problem, config.spine.openQuestions, barrierNodes);
    },
  },

  bibliography: {
    titleFn: () => "Bibliography",
    promptFn: (config) => buildBibliographyPromptAsync(config),
  },
};

/**
 * Build bibliography prompt — needs to load paper metadata from DB.
 * Since promptFn must be sync, we pre-load and cache paper data.
 */
function buildBibliographyPromptAsync(config: WikiFromSpineConfig): string {
  // Extract paper data from spine nodes (no DB call needed for prompt)
  const paperRefs = config.spine.nodes.flatMap((n) =>
    (n.authors ?? []).length > 0
      ? [{ title: n.title.replace(/^.+?:\s*/, ""), authors: n.authors ?? [], year: n.year }]
      : []
  );

  // Deduplicate by title
  const seen = new Set<string>();
  const uniquePapers = paperRefs.filter((p) => {
    if (seen.has(p.title)) return false;
    seen.add(p.title);
    return true;
  });

  return buildBibliographyFromSpinePrompt(
    config.problem,
    uniquePapers,
    config.spine,
  );
}

// ============================================================
//  Incremental Wiki Update Helper
// ============================================================

/**
 * Given a spine diff, regenerate only the affected wiki pages.
 * Returns the set of wiki page slugs that were regenerated.
 */
export async function patchWikiFromSpineDiff(
  config: WikiFromSpineConfig & { diff: SpineDiff },
  existingPages: WikiPageOutput[],
  emit: (e: SpinePipelineEvent) => void,
  tokenCounter: TokenCounter,
): Promise<WikiPageOutput[]> {
  const slugsToRegenerate = config.diff.affectedWikiSlugs;

  if (slugsToRegenerate.length === 0) {
    emit({ type: "log", message: "No wiki pages affected by spine diff" });
    return existingPages;
  }

  emit({ type: "log", message: `Spine diff affects ${slugsToRegenerate.length} wiki pages: ${slugsToRegenerate.join(", ")}` });

  // Regenerate affected pages
  const updatedPages = await generateWikiFromSpine(
    { ...config, onlySlugs: slugsToRegenerate },
    emit,
    tokenCounter,
  );

  // Merge: replace regenerated pages, keep unchanged ones
  const updatedSlugs = new Set(updatedPages.map((p) => p.slug));
  const merged = [
    ...existingPages.filter((p) => !updatedSlugs.has(p.slug)),
    ...updatedPages,
  ];

  return merged;
}
