/**
 * Wiki Synthesis — orchestrator (DESIGN-REFERENCE Part 4, Phase H).
 *
 * Replaces the legacy fixed-5-page `spine/wiki-from-spine.ts`. Pages are written
 * SEQUENTIALLY in `plan.pageOrder`; after each page a short summary (first ~200
 * chars) is injected into the next page's prompt so prose connects and proofs
 * aren't repeated across pages (DESIGN-REFERENCE §4.5). Each page is persisted
 * atomically to `<projectDir>/wiki/<slug>.md`; finally a `_index.md` TOC is
 * written.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { writeWikiPage, type WikiPageWriteResult } from "./write-page.js";
import { buildWikiIndex } from "./build-index.js";
import { errMsg, type SpineLLM } from "../spine/llm.js";
import type { WikiPlan } from "../wiki-plan/index.js";
import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export {
  writeWikiPage,
  extractWorkspaceRefs,
  extractPaperReadRefs,
  countCitationAnchors,
  WIKI_PAGE_WRITE_PROMPT_VERSION,
  type WikiPageWriteInput,
  type WikiPageWriteDeps,
  type WikiPageWriteResult,
} from "./write-page.js";
export { buildWikiIndex } from "./build-index.js";
export {
  buildWikiPageWritePrompt,
  EFFORT_DOC_BUDGET_BYTES,
  type WikiPageWritePromptInput,
} from "./prompts.js";

const SUMMARY_CHARS = 200;

// ── Public API ────────────────────────────────────────────────────────────────

export interface WikiSynthesisInput {
  plan: WikiPlan;
  spine: NarrativeSpine;
  reads: PaperRead[];
  effortDocuments: Map<string, string>;
  problem: { title: string; formalStatement: string; mathStatus?: string };
  projectDir: string;
}

export interface WikiSynthesisDeps {
  llm: SpineLLM;
  emitLog?: (m: string) => void;
}

export interface WikiSynthesisResult {
  pagesWritten: number;
  indexPath: string;
  pages: WikiPageWriteResult[];
}

export function wikiDir(projectDir: string): string {
  return path.join(projectDir, "wiki");
}

export function wikiIndexFile(projectDir: string): string {
  return path.join(wikiDir(projectDir), "_index.md");
}

export async function synthesizeWiki(
  input: WikiSynthesisInput,
  deps: WikiSynthesisDeps,
): Promise<WikiSynthesisResult> {
  const log = deps.emitLog ?? (() => {});
  const order = input.plan.pageOrder.length > 0 ? input.plan.pageOrder : input.plan.pages.map((p) => p.slug);
  const dir = wikiDir(input.projectDir);
  await fs.mkdir(dir, { recursive: true });

  log(`Synthesizing ${order.length} wiki pages [${order.join(" → ")}]`);

  const previouslyWrittenPageSummaries: Array<{ slug: string; title: string; summary: string }> = [];
  const pages: WikiPageWriteResult[] = [];

  for (let pageIndex = 0; pageIndex < order.length; pageIndex++) {
    const page = await writeWikiPage(
      {
        plan: input.plan,
        pageIndex,
        spine: input.spine,
        reads: input.reads,
        effortDocuments: input.effortDocuments,
        previouslyWrittenPageSummaries,
        problem: input.problem,
      },
      { llm: deps.llm, emitLog: log },
    );

    await persistPage(input.projectDir, page);
    pages.push(page);
    previouslyWrittenPageSummaries.push({
      slug: page.slug,
      title: page.title,
      summary: summarize(page.content),
    });
  }

  const indexMarkdown = buildWikiIndex(
    input.plan,
    pages.map((p) => ({ slug: p.slug, title: p.title })),
  );
  const indexPath = wikiIndexFile(input.projectDir);
  await atomicWrite(indexPath, indexMarkdown.endsWith("\n") ? indexMarkdown : indexMarkdown + "\n");

  log(`Wiki synthesis complete: ${pages.length} pages + _index.md`);
  return { pagesWritten: pages.length, indexPath, pages };
}

// ── Persistence ──────────────────────────────────────────────────────────────

function frontmatter(page: WikiPageWriteResult): string {
  return [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `slug: ${page.slug}`,
    `createdAt: ${new Date().toISOString()}`,
    `tags: ${JSON.stringify(["ai-generated"])}`,
    "version: 1",
    "---",
    "",
  ].join("\n");
}

async function persistPage(projectDir: string, page: WikiPageWriteResult): Promise<void> {
  try {
    const file = path.join(wikiDir(projectDir), `${page.slug}.md`);
    await atomicWrite(file, frontmatter(page) + page.content.trim() + "\n");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[wiki-synthesis] persistPage(${page.slug}) failed: ${errMsg(err)}`);
  }
}

/** Write `content` to `file` atomically (temp file + rename). */
async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** First ~200 chars of a page's prose (banner + heading markup stripped). */
function summarize(content: string): string {
  const cleaned = content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">")) // drop AI-generated/banner blockquotes
    .join(" ")
    .replace(/^#+\s*/gm, "") // drop heading hashes
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > SUMMARY_CHARS ? cleaned.slice(0, SUMMARY_CHARS - 1) + "…" : cleaned;
}
