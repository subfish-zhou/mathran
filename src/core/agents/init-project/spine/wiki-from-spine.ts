/**
 * Spine-First Architecture — Wiki Generation from Spine (fs port of mathub's
 * `wiki-from-spine.ts`).
 *
 * Generates wiki pages driven by the spine structure and writes each to
 * `<project>/wiki/<slug>.md` (with frontmatter):
 *   - overview, key-results, techniques, open-problems, bibliography
 *
 * The spine provides the OUTLINE; the LLM EXPANDS structured content into
 * prose. The DB layer (mathub) is replaced by the fs paper-graph; the
 * `@ws:` workspace-ref repair is a small self-contained helper here.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  buildOverviewFromSpinePrompt,
  buildKeyResultsFromSpinePrompt,
  buildTechniquesFromSpinePrompt,
  buildOpenProblemsFromSpinePrompt,
  buildBibliographyFromSpinePrompt,
} from "./prompts.js";
import { errMsg, noopEmit, type SpineLLM, type EmitFn } from "./llm.js";
import type {
  NarrativeSpine,
  SpineDiff,
  WikiPageOutput,
  WorkspaceEffortOutput,
} from "./types.js";

export interface WikiFromSpineConfig {
  spine: NarrativeSpine;
  projectDir: string;
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
//  @ws ref helpers (self-contained, fs port)
// ============================================================

const WS_REF = /@ws:([a-z0-9][a-z0-9-]*)/gi;

export function extractWorkspaceRefs(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(WS_REF)) out.add(m[1]!);
  return [...out];
}

/** Strip @ws references that don't match a known effort id. */
function repairWorkspaceRefs(
  content: string,
  efforts: WorkspaceEffortOutput[],
): { content: string; fixedRefs: number; removedRefs: number } {
  const valid = new Set(efforts.map((e) => e.id));
  let removed = 0;
  const repaired = content.replace(WS_REF, (full, id: string) => {
    if (valid.has(id)) return full;
    removed++;
    return id; // drop the @ws: prefix, keep the text
  });
  return { content: repaired, fixedRefs: 0, removedRefs: removed };
}

// ============================================================
//  fs persistence
// ============================================================

export function wikiDir(projectDir: string): string {
  return path.join(projectDir, "wiki");
}

function wikiFrontmatter(page: WikiPageOutput, tags: string[]): string {
  return [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `slug: ${page.slug}`,
    page.parentSlug ? `parentSlug: ${page.parentSlug}` : null,
    `createdAt: ${new Date().toISOString()}`,
    `tags: [${[...new Set([...tags, "ai-generated"])].map((t) => JSON.stringify(t)).join(", ")}]`,
    "version: 1",
    "---",
    "",
  ].filter((l): l is string => l != null).join("\n");
}

async function writeWikiPage(projectDir: string, page: WikiPageOutput, tags: string[]): Promise<void> {
  try {
    await fs.mkdir(wikiDir(projectDir), { recursive: true });
    await fs.writeFile(
      path.join(wikiDir(projectDir), `${page.slug}.md`),
      wikiFrontmatter(page, tags) + page.content.trim() + "\n",
      "utf-8",
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[spine-wiki] writeWikiPage(${page.slug}) failed: ${errMsg(err)}`);
  }
}

// ============================================================
//  Main Entry Point
// ============================================================

export async function generateWikiFromSpine(
  config: WikiFromSpineConfig,
  llm: SpineLLM,
  emit: EmitFn = noopEmit,
): Promise<WikiPageOutput[]> {
  const { spine, problem, projectDir } = config;
  const pages: WikiPageOutput[] = [];
  const allSlugs = config.onlySlugs ?? ["overview", "key-results", "techniques", "open-problems", "bibliography"];

  emit({ type: "log", message: `Generating ${allSlugs.length} wiki pages from spine (${spine.nodes.length} nodes, ${spine.threads.length} threads)` });

  const failures: Array<{ slug: string; error: string }> = [];

  for (const slug of allSlugs) {
    const generator = PAGE_GENERATORS[slug];
    if (!generator) {
      emit({ type: "log", message: `Unknown wiki page slug: ${slug}, skipping` });
      continue;
    }

    const title = generator.titleFn(problem.title);
    emit({ type: "wiki_page_start", slug, title });

    try {
      const prompt = withWorkspaceReferenceContext(generator.promptFn(config), config.workspaceEfforts ?? []);
      const content = await llm(prompt, { temperature: 0.3, maxTokens: 4000 });

      const taggedContent = content.includes("[AI-GENERATED]")
        ? content
        : `> [AI-GENERATED] This content was automatically generated and requires human review.\n\n${content}`;
      const repaired = repairWorkspaceRefs(taggedContent, config.workspaceEfforts ?? []);

      const page: WikiPageOutput = {
        slug,
        title,
        content: repaired.content,
        workspaceRefs: extractWorkspaceRefs(repaired.content),
      };
      pages.push(page);
      emit({ type: "wiki_page_complete", slug });
    } catch (err) {
      const msg = errMsg(err);
      failures.push({ slug, error: msg });
      emit({ type: "log", message: `Page "${title}" generation failed: ${msg}` });
      pages.push({
        slug,
        title,
        content: `> [AI-GENERATED] [GENERATION-FAILED] Automatic generation failed: ${msg}\n\nThis page is a placeholder. Please retry or edit manually.`,
        workspaceRefs: [],
      });
      emit({ type: "wiki_page_complete", slug });
    }
  }

  if (pages.length > 0 && failures.length === pages.length) {
    throw new Error(`Wiki generation failed for all ${pages.length} pages. First error: ${failures[0]!.error}`);
  }
  if (failures.length > 0) {
    emit({ type: "log", message: `Wiki generation partially failed: ${failures.length}/${pages.length} pages placeholdered` });
  }

  // First page is root; rest are children.
  if (pages.length > 0) {
    for (let i = 1; i < pages.length; i++) pages[i]!.parentSlug = pages[0]!.slug;
  }

  // Persist all pages.
  for (const page of pages) {
    await writeWikiPage(projectDir, page, problem.tags);
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
    promptFn: (config) => buildOverviewFromSpinePrompt(config.problem, config.spine, config.problem.mathStatus),
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
    promptFn: (config) =>
      buildTechniquesFromSpinePrompt(config.problem, config.spine.threads.filter((t) => t.status !== "dead_end"), config.spine),
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
    promptFn: (config) => buildBibliographyPrompt(config),
  },
};

function buildBibliographyPrompt(config: WikiFromSpineConfig): string {
  const paperRefs = config.spine.nodes.flatMap((n) =>
    (n.authors ?? []).length > 0
      ? [{ title: n.title.replace(/^.+?:\s*/, ""), authors: n.authors ?? [], year: n.year }]
      : [],
  );

  const seen = new Set<string>();
  const uniquePapers = paperRefs.filter((p) => {
    if (seen.has(p.title)) return false;
    seen.add(p.title);
    return true;
  });

  return buildBibliographyFromSpinePrompt(config.problem, uniquePapers, config.spine);
}

// ============================================================
//  Incremental Wiki Update Helper
// ============================================================

export async function patchWikiFromSpineDiff(
  config: WikiFromSpineConfig & { diff: SpineDiff },
  existingPages: WikiPageOutput[],
  llm: SpineLLM,
  emit: EmitFn = noopEmit,
): Promise<WikiPageOutput[]> {
  const slugsToRegenerate = config.diff.affectedWikiSlugs;

  if (slugsToRegenerate.length === 0) {
    emit({ type: "log", message: "No wiki pages affected by spine diff" });
    return existingPages;
  }

  emit({ type: "log", message: `Spine diff affects ${slugsToRegenerate.length} wiki pages: ${slugsToRegenerate.join(", ")}` });

  const updatedPages = await generateWikiFromSpine({ ...config, onlySlugs: slugsToRegenerate }, llm, emit);

  const updatedSlugs = new Set(updatedPages.map((p) => p.slug));
  return [...existingPages.filter((p) => !updatedSlugs.has(p.slug)), ...updatedPages];
}
