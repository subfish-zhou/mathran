/**
 * Wiki Synthesis — page-writer prompt construction (DESIGN-REFERENCE Part 4.4).
 *
 * Unlike the legacy fixed-5-page generator (each page prompted independently →
 * repeated content, no cross-links), the v3 page writer is prompted *in service
 * of one WikiPlan*: it sees its own page spec, its sibling pages, the summaries
 * of pages already written, the document.md of every effort it must cite, and
 * the PaperReads it must cite. Every mathematical claim is required to carry a
 * traceable `@ws:<effort-id>#<anchor>` or `@paper-read:<paper-id>#mainResult-N`
 * citation; the down-stream validator (write-page.ts) re-checks this.
 */

import type { WikiPlan, WikiPlanPage } from "../wiki-plan/index.js";
import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export const WIKI_PAGE_WRITE_PROMPT_VERSION = "v2";

/** Combined budget for cited effort documents injected into a single prompt. */
export const EFFORT_DOC_BUDGET_BYTES = 30_000;

export interface WikiPageWritePromptInput {
  plan: WikiPlan;
  page: WikiPlanPage;
  spine: NarrativeSpine;
  reads: PaperRead[];
  effortDocuments: Map<string, string>;
  previouslyWrittenPageSummaries: Array<{ slug: string; title: string; summary: string }>;
  problem: { title: string; formalStatement: string; mathStatus?: string };
}

export function buildWikiPageWritePrompt(input: WikiPageWritePromptInput): string {
  const { plan, page, reads, effortDocuments, previouslyWrittenPageSummaries, problem } = input;

  const pageSpec = [
    `slug: ${page.slug}`,
    `title: ${page.title}`,
    `purpose: ${page.purpose}`,
    `audience: ${page.audience}`,
    `narrativeRole: ${page.narrativeRole}`,
    `coreSections (use as top-level "## " headings, in order):`,
    ...page.coreSections.map((s) => `  - ${s}`),
    `keyEffortsCited (you MUST reference each): ${page.keyEffortsCited.join(", ") || "(none)"}`,
    `keyPaperReadsCited (you MUST cite each): ${page.keyPaperReadsCited.join(", ") || "(none)"}`,
    `relatedPageSlugs (reference these via prose, e.g. "see [[slug]]"): ${
      page.relatedPageSlugs.join(", ") || "(none)"
    }`,
  ].join("\n");

  const planSummary = plan.pageOrder
    .map((slug, i) => {
      const p = plan.pages.find((pg) => pg.slug === slug);
      const here = slug === page.slug ? "  ← THIS PAGE" : "";
      return `  ${i + 1}. [[${slug}]] — ${p?.title ?? slug}: ${truncate(p?.purpose ?? "", 160)}${here}`;
    })
    .join("\n");

  const priorSummaries =
    previouslyWrittenPageSummaries.length > 0
      ? previouslyWrittenPageSummaries
          .map((s) => `  - [[${s.slug}]] (${s.title}): ${truncate(s.summary, 200)}`)
          .join("\n")
      : "  (this is the first page — nothing written yet)";

  const effortBlock = buildEffortBlock(page, effortDocuments);
  const readsBlock = buildReadsBlock(page, reads);

  // Issue #2 from dogfood-run-2-report: writer fabricated `@paper-read:chen-1973`
  // and `@paper-read:iwaniec-kowalski-2004` even though the prompt said "don't
  // invent ids". Surface the entire allowlist of valid ids explicitly so the
  // writer cannot plead ignorance. Post-validation in write-page.ts will catch
  // anything that slips through anyway, but the explicit list is the primary
  // defense (post-validation just leaves an `[external-reference: ...]` marker).
  const allowedPaperIds = reads.map((r) => r.paperId);
  const allowedEffortIds = [...effortDocuments.keys()];
  const allowlistBlock = [
    "AVAILABLE @paper-read: IDS (cite ONLY these — there are no others):",
    allowedPaperIds.length > 0 ? allowedPaperIds.map((id) => `  - ${id}`).join("\n") : "  (none — do NOT cite any @paper-read:X)",
    "",
    "AVAILABLE @ws: EFFORT IDS (cite ONLY these — there are no others):",
    allowedEffortIds.length > 0 ? allowedEffortIds.map((id) => `  - ${id}`).join("\n") : "  (none — do NOT cite any @ws:X)",
  ].join("\n");

  const statusLine = problem.mathStatus ? `\nKnown math status: ${problem.mathStatus}` : "";

  return `You are the editor writing ONE page of a self-organized mathematics research wiki.
The wiki's pages were designed together to form a single coherent survey; you are writing the page below as part of that whole — not a standalone document.

## Problem
${problem.title}
Formal statement: ${problem.formalStatement}${statusLine}

## Wiki through-line (globalThesis)
${plan.globalThesis}

## The full wiki plan (your siblings, in reading order)
${planSummary}

## THIS PAGE — write exactly this page
${pageSpec}

## Pages already written (do NOT repeat their content — link to them instead)
${priorSummaries}

## Cited efforts — document.md content (quote / paraphrase faithfully)
${effortBlock}

## Cited paper-reads (cite these for results that come from the literature)
${readsBlock}

## ALLOWLIST OF CITABLE IDS — cite ONLY ids from these lists
${allowlistBlock}

## HARD RULES (the page will be rejected if violated)
1. EVERY mathematical claim MUST carry a traceable citation anchor: either
   \`@ws:<effort-id>#<anchor>\` (for an effort listed above) OR
   \`@paper-read:<paper-id>#mainResult-N\` (for a cited paper-read result).
   A sentence asserting a theorem, bound, or construction with no anchor is forbidden.
2. NEVER write vague claims like "improved the bound" or "made progress" — always
   give the actual new bound / statement in LaTeX (e.g. "reduced the exponent to $7/12 + \\\\varepsilon$").
3. Use the page's coreSections as the top-level "## " headings, in the given order.
   You may add "### " sub-headings freely.
4. Naturally cross-reference the relatedPageSlugs via prose, using \`[[slug]]\` link syntax
   (e.g. "the circle-method machinery is developed in [[circle-method]]").
5. Match the audience: ${page.audience}.
6. DO NOT INVENT effort ids or paper ids. The ALLOWLIST above is exhaustive — any
   id you cite that is not in the allowlist will be replaced post-hoc with an
   \`[external-reference: …, citation needed]\` marker AND the page will be flagged.
   If a result comes from a paper not in your corpus, do NOT make up an id — write
   the claim as a natural-prose reference (e.g. "Chen (1973) showed …") WITHOUT
   the \`@paper-read:\` anchor syntax. Such prose-only references are acceptable
   when the paper is universally known to the field; they will be reported as
   unresolvedCitations in the run report.
7. Do not restate proofs already covered on a previously-written page; link to that page instead.

## Output
Return ONLY the page body as GitHub-flavored Markdown (no frontmatter, no JSON, no code fences around the whole thing).
Start directly with the first "## " section heading.`;
}

function buildEffortBlock(page: WikiPlanPage, effortDocuments: Map<string, string>): string {
  // Prioritize keyEffortsCited; then any remaining efforts, within a byte budget.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of page.keyEffortsCited) {
    if (effortDocuments.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  for (const id of effortDocuments.keys()) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }

  if (ordered.length === 0) return "  (no effort documents available — rely on cited paper-reads)";

  const parts: string[] = [];
  let used = 0;
  for (const id of ordered) {
    if (used >= EFFORT_DOC_BUDGET_BYTES) {
      parts.push(`### @ws:${id}\n(omitted — effort-document budget exhausted; cite via @ws:${id}#<anchor>)`);
      continue;
    }
    const doc = effortDocuments.get(id) ?? "";
    const remaining = EFFORT_DOC_BUDGET_BYTES - used;
    const slice = doc.length > remaining ? doc.slice(0, remaining) + "\n…(truncated)…" : doc;
    used += slice.length;
    parts.push(`### @ws:${id}\n${slice.trim() || "(empty document)"}`);
  }
  return parts.join("\n\n");
}

function buildReadsBlock(page: WikiPlanPage, reads: PaperRead[]): string {
  const wanted = new Set(page.keyPaperReadsCited);
  const cited = reads.filter((r) => wanted.has(r.paperId));
  const list = cited.length > 0 ? cited : reads.slice(0, Math.min(reads.length, 6));
  if (list.length === 0) return "  (no paper-reads available)";

  return list
    .map((r) => {
      const role = r.read?.role ?? (r.isSurvey ? "survey" : "unknown");
      const results = (r.read?.mainResults ?? [])
        .map((m, i) => `    - @paper-read:${r.paperId}#mainResult-${i + 1} ${m.label}: ${truncate(m.statement, 240)}`)
        .join("\n");
      const header = `  - paper-read id: ${r.paperId} (role: ${role}) — ${truncate(r.skim.oneLineSummary, 160)}`;
      return results ? `${header}\n${results}` : header;
    })
    .join("\n");
}

function truncate(s: string, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
