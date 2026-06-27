/**
 * Wiki Synthesis — per-page writer (DESIGN-REFERENCE Part 4, Phase H Task 28).
 *
 * One LLM call per page in `WikiPlan.pageOrder`. The writer is shown the page's
 * own spec, the whole WikiPlan (so it knows its siblings), the summaries of
 * pages already written (so prose connects and proofs aren't repeated), the
 * `document.md` of every effort it must cite, and the cited PaperReads.
 *
 * Every mathematical claim must carry a traceable citation anchor:
 *   - `@ws:<effort-id>#<anchor>`              (workspace effort)
 *   - `@paper-read:<paper-id>#mainResult-N`   (literature result)
 *
 * The prompt enforces this; this module re-checks it (post-validation) and, if a
 * page carries no citation anchor at all, stamps a human-review banner rather
 * than throwing — the wiki always renders.
 */

import { errMsg, type SpineLLM } from "../spine/llm.js";
import { buildWikiPageWritePrompt, WIKI_PAGE_WRITE_PROMPT_VERSION } from "./prompts.js";
import type { WikiPlan, WikiPlanPage } from "../wiki-plan/index.js";
import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export { WIKI_PAGE_WRITE_PROMPT_VERSION } from "./prompts.js";

// ── Public API ────────────────────────────────────────────────────────────────

export interface WikiPageWriteInput {
  plan: WikiPlan;
  /** which page in `plan.pageOrder` to write. */
  pageIndex: number;
  spine: NarrativeSpine;
  /** all reads in the corpus. */
  reads: PaperRead[];
  /** effort-id → full document.md content. */
  effortDocuments: Map<string, string>;
  previouslyWrittenPageSummaries: Array<{ slug: string; title: string; summary: string }>;
  problem: { title: string; formalStatement: string; mathStatus?: string };
}

export interface WikiPageWriteDeps {
  llm: SpineLLM;
  emitLog?: (m: string) => void;
}

export interface WikiPageWriteResult {
  slug: string;
  title: string;
  content: string;
  workspaceRefs: string[];
}

// ── Citation-anchor helpers ─────────────────────────────────────────────────

const WS_REF = /@ws:([a-z0-9][a-z0-9-]*)(?:#[A-Za-z0-9._-]+)?/gi;
const PAPER_READ_REF = /@paper-read:([A-Za-z0-9._/-]+)#([A-Za-z0-9._-]+)/g;

/** Distinct effort ids referenced via `@ws:<id>[#anchor]` in `content`. */
export function extractWorkspaceRefs(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(WS_REF)) out.add(m[1]!);
  return [...out];
}

/** Distinct paper ids referenced via `@paper-read:<id>#anchor`. */
export function extractPaperReadRefs(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(PAPER_READ_REF)) out.add(m[1]!);
  return [...out];
}

/** Total number of traceable citation anchors (`@ws:` + `@paper-read:`). */
export function countCitationAnchors(content: string): number {
  const ws = content.match(WS_REF)?.length ?? 0;
  const pr = content.match(PAPER_READ_REF)?.length ?? 0;
  return ws + pr;
}

const REVIEW_BANNER =
  "> [AI-GENERATED] [NEEDS-CITATIONS] This page was generated without any traceable `@ws:` or `@paper-read:` citation anchors and requires human review.";

// ── Writer ──────────────────────────────────────────────────────────────────

export async function writeWikiPage(
  input: WikiPageWriteInput,
  deps: WikiPageWriteDeps,
): Promise<WikiPageWriteResult> {
  const log = deps.emitLog ?? (() => {});
  const page = resolvePage(input.plan, input.pageIndex);

  const prompt = buildWikiPageWritePrompt({
    plan: input.plan,
    page,
    spine: input.spine,
    reads: input.reads,
    effortDocuments: input.effortDocuments,
    previouslyWrittenPageSummaries: input.previouslyWrittenPageSummaries,
    problem: input.problem,
  });

  let body: string;
  try {
    body = (await deps.llm(prompt, { temperature: 0.3, maxTokens: 4000 })).trim();
  } catch (err) {
    const msg = errMsg(err);
    log(`Wiki page "${page.slug}" generation failed: ${msg}`);
    return {
      slug: page.slug,
      title: page.title,
      content: `> [AI-GENERATED] [GENERATION-FAILED] Automatic generation failed: ${msg}\n\nThis page is a placeholder. Please retry or edit manually.`,
      workspaceRefs: [],
    };
  }

  let content = stripWrappingFence(body);

  const anchors = countCitationAnchors(content);
  if (anchors === 0) {
    log(`Wiki page "${page.slug}" has no citation anchors — stamping review banner (promptVer ${WIKI_PAGE_WRITE_PROMPT_VERSION})`);
    content = `${REVIEW_BANNER}\n\n${content}`;
  } else {
    log(`Wiki page "${page.slug}" written with ${anchors} citation anchors`);
  }

  return {
    slug: page.slug,
    title: page.title,
    content,
    workspaceRefs: extractWorkspaceRefs(content),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolvePage(plan: WikiPlan, pageIndex: number): WikiPlanPage {
  const order = plan.pageOrder.length > 0 ? plan.pageOrder : plan.pages.map((p) => p.slug);
  if (pageIndex < 0 || pageIndex >= order.length) {
    throw new Error(`writeWikiPage: pageIndex ${pageIndex} out of range (0..${order.length - 1})`);
  }
  const slug = order[pageIndex]!;
  const page = plan.pages.find((p) => p.slug === slug);
  if (!page) {
    throw new Error(`writeWikiPage: pageOrder slug "${slug}" not found in plan.pages`);
  }
  return page;
}

/** Remove a single ```/```markdown fence wrapping the entire body, if present. */
function stripWrappingFence(s: string): string {
  const m = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return m?.[1] ? m[1].trim() : s;
}
