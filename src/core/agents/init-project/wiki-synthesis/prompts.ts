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

export const WIKI_PAGE_WRITE_PROMPT_VERSION = "v3";

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

  // 2026-06-30 — argument-map awareness (DESIGN-REFERENCE Part 4.6).
  //
  // The writer used to see only a 1-line globalThesis. With v3 the writer
  // sees:
  //   • THIS page's sub-claim (what it is arguing) + its position in the
  //     argument graph (what comes before, what comes after);
  //   • the WHOLE argument map (the thesis split into 3-8 sub-claims with a
  //     dependency DAG and a page→subClaim assignment);
  //   • the typed relation to each related sibling page (prerequisite /
  //     extends / contrasts-with / applies / follows-up) so cross-references
  //     read as load-bearing prose instead of "see [[X]]" filler;
  //   • a separate block listing which pages come AFTER this one and what
  //     they will argue, so the current page can hand off (avoid covering
  //     what the next page will deepen, plant the right setup).
  //
  // When plan.argumentMap is missing (legacy plan loaded from disk), the
  // map block is omitted and the writer falls back to v2 behavior on that
  // page. The repair pass in wiki-plan/index.ts synthesizes a map for new
  // runs so this missing-map branch should rarely fire in production.
  const argMap = plan.argumentMap;
  const subClaim = page.subClaimId
    ? argMap?.subClaims.find((sc) => sc.id === page.subClaimId)
    : undefined;

  const relatedPagesBlock = (page.relatedPages?.length ?? 0) > 0
    ? page.relatedPages
        .map((rp) => {
          const sibling = plan.pages.find((p) => p.slug === rp.slug);
          const title = sibling?.title ?? rp.slug;
          return `  - [[${rp.slug}]] (${rp.relation}): ${title}`;
        })
        .join("\n")
    : "  (none — this page stands alone in the wiki graph)";

  const pageSpec = [
    `slug: ${page.slug}`,
    `title: ${page.title}`,
    `purpose: ${page.purpose}`,
    `audience: ${page.audience}`,
    `narrativeRole: ${page.narrativeRole}`,
    subClaim
      ? `subClaim being argued (${subClaim.id}): ${subClaim.claim}`
      : `subClaim being argued: (this page does not argue a single sub-claim — see "Wiki argument map" below)`,
    `coreSections (use as top-level "## " headings, in order):`,
    ...page.coreSections.map((s) => `  - ${s}`),
    `keyEffortsCited (you MUST reference each): ${page.keyEffortsCited.join(", ") || "(none)"}`,
    `keyPaperReadsCited (you MUST cite each): ${page.keyPaperReadsCited.join(", ") || "(none)"}`,
    `Related sibling pages (reference via prose with the relation in mind, e.g. "the circle-method machinery developed in [[circle-method]] is extended here"):`,
    relatedPagesBlock,
  ].join("\n");

  const planSummary = plan.pageOrder
    .map((slug, i) => {
      const p = plan.pages.find((pg) => pg.slug === slug);
      const here = slug === page.slug ? "  ← THIS PAGE" : "";
      return `  ${i + 1}. [[${slug}]] — ${p?.title ?? slug}: ${truncate(p?.purpose ?? "", 160)}${here}`;
    })
    .join("\n");

  // 2026-06-30: explicit "later pages" block. Writer must know what's
  // coming so it can hand off cleanly: don't pre-empt the next page's
  // deep-dive, do plant the setup the next page expects.
  const myIndex = plan.pageOrder.indexOf(page.slug);
  const laterPages = myIndex >= 0
    ? plan.pageOrder.slice(myIndex + 1).map((slug) => plan.pages.find((p) => p.slug === slug)).filter(Boolean)
    : [];
  const laterBlock = laterPages.length > 0
    ? laterPages
        .map((p) => {
          const sc = p!.subClaimId && argMap
            ? argMap.subClaims.find((s) => s.id === p!.subClaimId)
            : undefined;
          const claimLine = sc ? ` — argues: ${truncate(sc.claim, 140)}` : "";
          return `  - [[${p!.slug}]] (${p!.title})${claimLine}`;
        })
        .join("\n")
    : "  (this is the last page — no follow-ups to defer to)";

  const argumentMapBlock = argMap
    ? [
        `## Wiki argument map (the wiki's intellectual skeleton)`,
        `Thesis: ${argMap.thesis}`,
        ``,
        `The thesis decomposes into ${argMap.subClaims.length} sub-claim(s); each is argued by a specific page. Knowing where THIS page sits lets you connect prose across pages instead of restating shared context:`,
        ...argMap.subClaims.map((sc) => {
          const pages = sc.supportedByPages.length > 0 ? sc.supportedByPages.map((s) => `[[${s}]]`).join(", ") : "(no page yet)";
          const deps = sc.dependsOn.length > 0 ? ` (depends on: ${sc.dependsOn.join(", ")})` : "";
          const thisOne = sc.id === page.subClaimId ? "  ← THIS PAGE argues this sub-claim" : "";
          return `  - ${sc.id}: ${sc.claim}${deps}\n      argued by: ${pages}${thisOne}`;
        }),
      ].join("\n")
    : "";

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

${argumentMapBlock}

## The full wiki plan (your siblings, in reading order)
${planSummary}

## Pages that come AFTER this one (do NOT pre-empt their deep-dives — set them up cleanly)
${laterBlock}

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
4. Naturally cross-reference the related sibling pages via prose, using \`[[slug]]\` link syntax. Honor the TYPED relation (prerequisite / extends / contrasts-with / applies / follows-up): a "prerequisite" link reads "see [[X]] first for the toolkit"; "extends" reads "this builds on [[X]]'s result by …"; "contrasts-with" reads "unlike the approach of [[X]], here we …"; "applies" reads "applying [[X]]'s machinery to …"; "follows-up" reads "[[X]] left open …, which we continue here". The relation IS the meaning of the link — don't just say "see [[X]]" without conveying the relation.
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
8. Honor the "Pages that come AFTER this one" block above. If a later page will deep-dive a topic, this page should set the reader up with the minimum needed (and forward them via \`[[later-slug]]\`) rather than steal that page's content. The wiki reads end-to-end.
${page.audience === "graduate-student-entering-field" ? introPageDirective(plan, argMap) : ""}
## Output
Return ONLY the page body as GitHub-flavored Markdown (no frontmatter, no JSON, no code fences around the whole thing).
Start directly with the first "## " section heading.`;
}

/**
 * 2026-06-30 — special directive appended for the introductory page.
 *
 * The intro page is NOT just "problem statement + history + state-of-the-art"
 * (that was the legacy template). With the argument-map cut, its job is to
 * render the wiki's intellectual skeleton as readable prose so a newcomer
 * can SEE the structure before reading any content page. This block tells
 * the writer exactly that and gives it the recipe.
 *
 * When no argumentMap is available (legacy plan), the directive degrades to
 * a generic "write a proper introduction" prompt — strictly better than
 * silence, and never worse than v2 behavior.
 */
function introPageDirective(plan: WikiPlan, argMap: WikiPlan["argumentMap"]): string {
  if (!argMap || argMap.subClaims.length === 0) {
    return `
## SPECIAL INSTRUCTIONS — this is the WIKI'S INTRODUCTION
This is the first page a reader sees. After stating the problem and its significance, the rest of the page should orient the reader to the wiki's overall structure (what each subsequent page argues, and why they are arranged in that order). End with a "How to read this wiki" section that walks through the pageOrder above.
`;
  }
  const subClaimSummary = argMap.subClaims
    .map((sc) => {
      const pages = sc.supportedByPages.map((s) => `[[${s}]]`).join(", ") || "(no page yet)";
      return `  - ${sc.id} — ${sc.claim} (argued by ${pages})`;
    })
    .join("\n");
  return `
## SPECIAL INSTRUCTIONS — this is the WIKI'S INTRODUCTION
The introductory page is the wiki's MAP. Your job is NOT just to recap the problem; it is to render the argument map in human prose so the reader can SEE the wiki's intellectual structure before clicking into any content page.

Required structure (use these as top-level \`## \` headings, in order):

1. \`## Problem\` — state the problem and what counts as progress on it. 1–3 paragraphs.
2. \`## Why this wiki exists / what it adds\` — what is the through-line (the globalThesis: "${plan.globalThesis}")? Why is the standard textbook account not enough? 1–2 paragraphs.
3. \`## The argument in ${argMap.subClaims.length} parts\` — render the argument map IN PROSE, one short paragraph per sub-claim. For each sub-claim, write a paragraph that (a) states the sub-claim in plain language, (b) names the page(s) that argue it via \`[[slug]]\` links, (c) where relevant, names the prerequisite sub-claims using their plain-language statements (NOT the C1/C2 ids — those are for the editor, not the reader). The sub-claims to cover, in the order they should appear:

${subClaimSummary}

4. \`## How to read this wiki\` — walk the reader through pageOrder. For each subsequent page (not this one), one sentence on what they'll learn and how it builds on what came before. End with the bibliography pointer.

You may add other \`## \` sections (e.g. notation, prerequisites) if genuinely useful, but the four sections above are required and must appear in this order. The reader should be able to STOP after this page and have a complete mental model of what the wiki is arguing and which page to jump to.
`;
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
