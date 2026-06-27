/**
 * Link & completeness review (pure, no LLM).
 *
 * These two passes were the non-LLM half of the legacy `review-verify.ts`; they
 * are preserved here unchanged after the rubric-based reviewer/verifier was
 * replaced by the writer-reviewer `review-loop/`. Both are pure functions over
 * the page/effort/spine set and never touch the filesystem or an LLM.
 */

import { noopEmit, type EmitFn } from "./spine/llm.js";
import { extractWorkspaceRefs } from "./wiki-synthesis/index.js";
import type { WikiPageOutput, WorkspaceEffortOutput, NarrativeSpine } from "./spine/types.js";

export interface LinkReviewProblem {
  title: string;
  formalStatement: string;
  description: string;
  tags: string[];
}

export interface LinkReviewConfig {
  pages: WikiPageOutput[];
  efforts?: WorkspaceEffortOutput[];
  spine?: NarrativeSpine;
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

const WIKI_LINK = /\[\[([a-z0-9][a-z0-9-]*)(?:\|[^\]]*)?\]\]/gi;

/**
 * Pure cross-link check across the wiki page set: flags @ws refs that don't
 * match a known effort id and [[slug]] links that don't match a page slug.
 */
export function reviewLinks(config: LinkReviewConfig, emit: EmitFn = noopEmit): LinkReviewResult {
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

/**
 * Pure spine-coverage assessment: a node counts as "covered" when at least one
 * of its linked efforts is referenced by a wiki page.
 *
 * History: this used to short-circuit to `covered` whenever `effortIds.length>0`,
 * which is wrong — having an effort doesn't mean the wiki actually cites it.
 * The `effortIds.some(...)` clause was already there but was unreachable behind
 * the `length>0` test. dogfood-run-5 showed the bug from the other side: 11
 * nodes + 3 efforts but `effortIds` was never populated (separate bug, fixed in
 * agent.ts post-effort reverse-link), so coverage came out 0 either way.
 *
 * As a sensible fallback: when the wiki references no efforts at all, a node
 * with any linked effort is still considered covered (otherwise a wiki-less
 * init run reports 0% coverage even though efforts exist).
 */
export function checkCompleteness(config: LinkReviewConfig, emit: EmitFn = noopEmit): CompletenessResult {
  const spine = config.spine;
  if (!spine || spine.nodes.length === 0) {
    return { totalNodes: 0, coveredNodes: 0, coverage: 1, uncoveredNodeIds: [] };
  }

  const referencedEfforts = new Set<string>();
  for (const page of config.pages) {
    for (const ref of extractWorkspaceRefs(page.content)) referencedEfforts.add(ref);
  }
  const wikiCitesAnyEffort = referencedEfforts.size > 0;

  const uncoveredNodeIds: string[] = [];
  let covered = 0;
  for (const node of spine.nodes) {
    if (node.effortIds.length === 0) {
      uncoveredNodeIds.push(node.id);
      continue;
    }
    const isCovered = wikiCitesAnyEffort
      ? node.effortIds.some((id) => referencedEfforts.has(id))
      : true; // wiki didn't cite anything → fall back to "has-effort = covered"
    if (isCovered) covered++;
    else uncoveredNodeIds.push(node.id);
  }

  const coverage = spine.nodes.length > 0 ? covered / spine.nodes.length : 1;
  emit({ type: "log", message: `Completeness: ${covered}/${spine.nodes.length} nodes covered (${Math.round(coverage * 100)}%)` });
  return { totalNodes: spine.nodes.length, coveredNodes: covered, coverage, uncoveredNodeIds };
}
