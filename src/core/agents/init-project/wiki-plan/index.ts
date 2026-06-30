/**
 * Wiki Outliner — LLM-decided wiki page plan (DESIGN-REFERENCE Part 4).
 *
 * Replaces the fixed 5-page template
 * (overview/key-results/techniques/open-problems/bibliography) with a plan the
 * agent designs from the spine + read corpus + prior art. The LLM output is
 * treated as advisory: all structural invariants are re-enforced in code so the
 * downstream page-writing loop always receives a conformant plan.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { slugify } from "../../../../lib/slug.js";
import { extractSpineJSON, errMsg, type SpineLLM } from "../spine/llm.js";
import { buildWikiOutlinePrompt } from "./prompts.js";
import type { NarrativeSpine, SpineThread } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";
import type { PriorArtCorpus } from "../prior-art/index.js";

export { WIKI_OUTLINE_PROMPT_VERSION, buildWikiOutlinePrompt } from "./prompts.js";

// ── Public types ─────────────────────────────────────────────────────────────

export type WikiPageAudience =
  | "graduate-student-entering-field"
  | "specialist-refresher"
  | "expert-checking-status";

/**
 * 2026-06-30 — Argument Map (DESIGN-REFERENCE Part 4.6).
 *
 * The "second cut" optimization for wiki coherence: an explicit decomposition
 * of the global thesis into 3–8 sub-claims, each linked to the page(s) that
 * argue for it. Before this, the writer only saw a 1-line globalThesis and
 * had no way to know *how* the thesis is being divided across pages — pages
 * read as standalone short essays grouped by topic rather than as a single
 * coherent argument. With the argument map, each page knows:
 *   • which sub-claim it is arguing (subClaimId on the page),
 *   • where that sub-claim sits in the overall argument (dependsOn graph),
 *   • which other pages co-argue or build on its sub-claim.
 *
 * The overview page becomes the prose rendering of this map: it walks
 * thesis → subClaims → which page argues each → the reading arc that
 * follows. That is the "提纲挈领" (table-of-contents-with-a-spine) view
 * that was missing from the previous wiki output.
 *
 * Constraints (enforced by repair):
 *   • 3–8 sub-claims (fewer than 3 → trivial; more than 8 → unreadable).
 *   • Every non-intro, non-bibliography page should be supportedByPages of
 *     exactly one sub-claim (when LLM forgets, repair backfills).
 *   • dependsOn forms a DAG over sub-claim ids (cycles broken in repair).
 */
export interface SubClaim {
  /** Short id, e.g. "C1", "C2", or a slug like "circle-method-applies". */
  id: string;
  /** One-sentence sub-claim being argued — written for a specialist reader. */
  claim: string;
  /** Page slug(s) whose body argues for this sub-claim. */
  supportedByPages: string[];
  /** Other sub-claim ids that must be established before this one is meaningful. */
  dependsOn: string[];
}

export interface ArgumentMap {
  /**
   * Canonical thesis statement. Usually equals WikiPlan.globalThesis but
   * separated so the argument-map can stand alone (e.g. for export).
   */
  thesis: string;
  /** 3–8 sub-claims, each assigned to one or more pages. */
  subClaims: SubClaim[];
}

/**
 * 2026-06-30 — typed inter-page relationship (Argument Map cut).
 *
 * Replaces the bare `relatedPageSlugs: string[]` (still kept for back-compat
 * with already-persisted wiki-plan.json files). The writer prompt now shows
 * the *kind* of relationship so cross-references read as
 * "[[circle-method]] gives the toolkit this page extends" rather than the
 * old, semantically-empty "see [[circle-method]]".
 *
 * Vocabulary (deliberately small — easier for the LLM to honor + for the
 * reader to parse):
 *   • prerequisite  — "you should read X first to follow this page"
 *   • extends       — "this page builds directly on X's results"
 *   • contrasts-with — "this page presents an alternative / competing approach to X"
 *   • applies       — "this page applies the methods/results of X to a new setting"
 *   • follows-up    — "X partially answered a question; this page continues / refines"
 */
export type RelatedPageRelation =
  | "prerequisite"
  | "extends"
  | "contrasts-with"
  | "applies"
  | "follows-up";

export interface RelatedPage {
  slug: string;
  relation: RelatedPageRelation;
}

export interface WikiPlanPage {
  slug: string;
  title: string;
  purpose: string;
  audience: WikiPageAudience;
  estimatedLengthWords: number;
  coreSections: string[];
  /** effort ids (forward refs; spine node ids used as proxies for now). */
  keyEffortsCited: string[];
  /** paper ids. */
  keyPaperReadsCited: string[];
  /**
   * Back-compat: simple slug list. Still consulted by the nav footer and by
   * legacy code paths. Always kept in sync with `relatedPages` post-repair.
   */
  relatedPageSlugs: string[];
  /**
   * 2026-06-30: typed inter-page relationships. New writer prompts read from
   * this. When loading a legacy wiki-plan.json that only has
   * `relatedPageSlugs`, repair backfills here with relation="extends" as a
   * neutral default.
   */
  relatedPages: RelatedPage[];
  narrativeRole: string;
  /**
   * 2026-06-30 — which SubClaim.id this page argues for. Optional because:
   *   • the intro page renders the argument-map itself (no single sub-claim),
   *   • the bibliography page is a reference, not an argument,
   *   • on legacy plans without an argumentMap this is left blank.
   * Repair tries to backfill from ArgumentMap.subClaims[*].supportedByPages.
   */
  subClaimId?: string;
}

export interface WikiPlan {
  globalThesis: string;
  totalPages: number;
  pages: WikiPlanPage[];
  pageOrder: string[];
  /**
   * 2026-06-30 — argument map. Optional so legacy plan files still load.
   * Repair synthesizes a degenerate one (1 sub-claim per content page,
   * thesis=globalThesis) when missing, so downstream prompts always have
   * something to consume.
   */
  argumentMap?: ArgumentMap;
}

/**
 * Internal constants for argument-map repair. Exported for tests so the
 * invariants can be asserted directly rather than re-derived from behavior.
 */
export const ARGUMENT_MAP_MIN_SUBCLAIMS = 3;
export const ARGUMENT_MAP_MAX_SUBCLAIMS = 8;

/** Used when repair backfills relations on a legacy plan that only had slugs. */
const DEFAULT_RELATION: RelatedPageRelation = "extends";
const VALID_RELATIONS = new Set<RelatedPageRelation>([
  "prerequisite",
  "extends",
  "contrasts-with",
  "applies",
  "follows-up",
]);

export interface OutlineWikiInput {
  problem: {
    title: string;
    formalStatement: string;
    description: string;
    tags: string[];
    mathStatus?: string;
  };
  spine: NarrativeSpine;
  reads: PaperRead[];
  priorArt: PriorArtCorpus | null;
}

export interface OutlineWikiDeps {
  llm: SpineLLM;
  emitLog?: (message: string) => void;
}

const MIN_PAGES = 3;
const MAX_PAGES = 12;
const INTRO_AUDIENCE: WikiPageAudience = "graduate-student-entering-field";
const VALID_AUDIENCES = new Set<WikiPageAudience>([
  "graduate-student-entering-field",
  "specialist-refresher",
  "expert-checking-status",
]);

// ── Outliner ─────────────────────────────────────────────────────────────────

export async function outlineWikiPages(
  input: OutlineWikiInput,
  deps: OutlineWikiDeps,
): Promise<WikiPlan> {
  const log = deps.emitLog ?? (() => {});
  const prompt = buildWikiOutlinePrompt(input);

  let parsed: Record<string, unknown> = {};
  try {
    // No maxTokens override — plan output is a JSON tree of N wiki pages with
    // titles/audiences/key topics; capping at 4K silently truncates mid-array,
    // leaves wiki-plan with fewer pages than intended. Same fix class as
    // spine builders + reviewer + rewriter.
    const raw = await deps.llm(prompt, { temperature: 0.4 });
    parsed = extractSpineJSON<Record<string, unknown>>(raw) ?? {};
  } catch (err) {
    log(`Wiki outline LLM failed: ${errMsg(err)}`);
  }

  const draft = coercePlan(parsed, input);
  const plan = repairPlan(draft, input);
  log(`Wiki plan: ${plan.totalPages} pages [${plan.pageOrder.join(" → ")}]`);
  return plan;
}

// ── Coercion (LLM JSON → typed draft) ───────────────────────────────────────

function coercePlan(parsed: Record<string, unknown>, input: OutlineWikiInput): WikiPlan {
  const rawPages = Array.isArray(parsed.pages) ? (parsed.pages as Array<Record<string, unknown>>) : [];
  const usedSlugs = new Set<string>();
  const pages: WikiPlanPage[] = rawPages.map((p, i) => {
    let slug = slugify(String(p.slug ?? p.title ?? `page-${i}`), `page-${i}`);
    while (usedSlugs.has(slug)) slug = `${slug}-${i}`;
    usedSlugs.add(slug);
    const audience = VALID_AUDIENCES.has(p.audience as WikiPageAudience)
      ? (p.audience as WikiPageAudience)
      : "specialist-refresher";
    // 2026-06-30: accept BOTH the old shape (relatedPageSlugs: string[]) and
    // the new typed shape (relatedPages: [{slug, relation}]). Whichever the
    // LLM produced, we end up with both fields kept in sync downstream.
    const relatedPages = coerceRelatedPages(p.relatedPages);
    const relatedPageSlugs =
      relatedPages.length > 0
        ? relatedPages.map((r) => r.slug)
        : asStringArray(p.relatedPageSlugs);
    return {
      slug,
      title: String(p.title ?? slug),
      purpose: String(p.purpose ?? ""),
      audience,
      estimatedLengthWords:
        typeof p.estimatedLengthWords === "number" && p.estimatedLengthWords > 0
          ? Math.round(p.estimatedLengthWords)
          : 1500,
      coreSections: asStringArray(p.coreSections),
      keyEffortsCited: asStringArray(p.keyEffortsCited),
      keyPaperReadsCited: asStringArray(p.keyPaperReadsCited),
      relatedPageSlugs,
      relatedPages,
      narrativeRole: String(p.narrativeRole ?? ""),
      // 2026-06-30: subClaimId is optional + only meaningful for content
      // pages. Coerce blank strings → undefined so downstream "is this an
      // intro/biblio page" checks don't false-positive on "".
      ...(typeof p.subClaimId === "string" && p.subClaimId.trim()
        ? { subClaimId: p.subClaimId.trim() }
        : {}),
    };
  });

  const argumentMap = coerceArgumentMap(parsed.argumentMap, parsed.globalThesis);

  return {
    globalThesis: String(parsed.globalThesis ?? input.spine.globalThesis ?? input.problem.title),
    totalPages: pages.length,
    pages,
    pageOrder: asStringArray(parsed.pageOrder),
    ...(argumentMap ? { argumentMap } : {}),
  };
}

/**
 * 2026-06-30: coerce one page's relatedPages field. Accept either a typed
 * `{slug, relation}` array (new LLM output) OR a bare string[] (a model that
 * ignored the v2 instructions). Returns [] when neither produces a usable
 * entry — repair will then backfill from relatedPageSlugs if appropriate.
 */
function coerceRelatedPages(v: unknown): RelatedPage[] {
  if (!Array.isArray(v)) return [];
  const out: RelatedPage[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      const slug = item.trim();
      if (slug) out.push({ slug, relation: DEFAULT_RELATION });
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const slug = typeof rec.slug === "string" ? rec.slug.trim() : "";
      const rawRel = typeof rec.relation === "string" ? rec.relation.trim() : "";
      const relation = VALID_RELATIONS.has(rawRel as RelatedPageRelation)
        ? (rawRel as RelatedPageRelation)
        : DEFAULT_RELATION;
      if (slug) out.push({ slug, relation });
    }
  }
  return out;
}

/**
 * 2026-06-30: coerce argumentMap from raw LLM JSON. Tolerates missing fields
 * but rejects nonsense (non-array subClaims, no thesis). Returns null when
 * we should fall back to repair-synthesized degenerate map.
 */
function coerceArgumentMap(v: unknown, fallbackThesis: unknown): ArgumentMap | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const thesis = typeof rec.thesis === "string" && rec.thesis.trim()
    ? rec.thesis.trim()
    : typeof fallbackThesis === "string" && fallbackThesis.trim()
      ? fallbackThesis.trim()
      : "";
  if (!thesis) return null;
  const rawSubs = Array.isArray(rec.subClaims) ? (rec.subClaims as Array<Record<string, unknown>>) : [];
  const subClaims: SubClaim[] = rawSubs
    .map((s, i) => ({
      id: typeof s.id === "string" && s.id.trim() ? s.id.trim() : `C${i + 1}`,
      claim: typeof s.claim === "string" ? s.claim.trim() : "",
      supportedByPages: asStringArray(s.supportedByPages),
      dependsOn: asStringArray(s.dependsOn),
    }))
    .filter((s) => s.claim.length > 0);
  return { thesis, subClaims };
}

// ── Repair (enforce invariants) ─────────────────────────────────────────────

function repairPlan(plan: WikiPlan, input: OutlineWikiInput): WikiPlan {
  let pages = [...plan.pages];

  // 1. Exactly one bibliography page.
  const biblioPages = pages.filter(isBibliographyPage);
  if (biblioPages.length === 0) {
    pages.push(synthesizeBibliography(input));
  } else if (biblioPages.length > 1) {
    // Keep the first bibliography; convert the rest into normal content pages.
    const keep = biblioPages[0]!;
    for (const extra of biblioPages.slice(1)) {
      extra.slug = ensureUniqueSlug(`${extra.slug}-notes`, pages);
      extra.narrativeRole = extra.narrativeRole || "supplementary";
      if (isBibliographyPage(extra)) extra.title = `${extra.title} (notes)`;
    }
    void keep;
  }

  // 2. Exactly one introductory page.
  let introPages = pages.filter((p) => p.audience === INTRO_AUDIENCE && !isBibliographyPage(p));
  if (introPages.length === 0) {
    pages.unshift(synthesizeIntro(input));
  } else if (introPages.length > 1) {
    // Demote all but the first to specialist-refresher.
    for (const extra of introPages.slice(1)) extra.audience = "specialist-refresher";
  }
  introPages = pages.filter((p) => p.audience === INTRO_AUDIENCE && !isBibliographyPage(p));

  // 3. No orphan pages — every page must cite something.
  for (const page of pages) {
    if (isBibliographyPage(page)) continue;
    if (page.keyEffortsCited.length === 0 && page.keyPaperReadsCited.length === 0) {
      page.keyEffortsCited = topNodeIdsForRole(page.narrativeRole, input.spine, 2);
      if (page.keyEffortsCited.length === 0) {
        page.keyPaperReadsCited = input.reads.slice(0, 2).map((r) => r.paperId);
      }
    }
  }

  // 4. Lower bound: at least MIN_PAGES.
  if (pages.length < MIN_PAGES) {
    const biblioIdx = pages.findIndex(isBibliographyPage);
    const sota = synthesizeStateOfTheArt(input, pages);
    if (biblioIdx >= 0) pages.splice(biblioIdx, 0, sota);
    else pages.push(sota);
  }

  // 5. Upper bound: at most MAX_PAGES (keep intro + bibliography + longest).
  if (pages.length > MAX_PAGES) {
    const intro = pages.find((p) => p.audience === INTRO_AUDIENCE && !isBibliographyPage(p));
    const biblio = pages.find(isBibliographyPage);
    const protectedSlugs = new Set([intro?.slug, biblio?.slug].filter(Boolean) as string[]);
    const rest = pages
      .filter((p) => !protectedSlugs.has(p.slug))
      .sort((a, b) => b.estimatedLengthWords - a.estimatedLengthWords);
    const keepCount = MAX_PAGES - protectedSlugs.size;
    const kept = rest.slice(0, keepCount);
    pages = [
      ...(intro ? [intro] : []),
      ...kept,
      ...(biblio ? [biblio] : []),
    ];
  }

  // 6. Build a coherent pageOrder: intro first, bibliography last.
  const intro = pages.find((p) => p.audience === INTRO_AUDIENCE && !isBibliographyPage(p))!;
  const biblio = pages.find(isBibliographyPage)!;
  const middle = pages.filter((p) => p.slug !== intro.slug && p.slug !== biblio.slug);

  const slugSet = new Set(pages.map((p) => p.slug));
  const givenOrder = plan.pageOrder.filter((s) => slugSet.has(s));
  const validGivenOrder =
    givenOrder.length === pages.length && new Set(givenOrder).size === pages.length;

  let orderedMiddle: WikiPlanPage[];
  if (validGivenOrder) {
    const pos = new Map(givenOrder.map((s, i) => [s, i]));
    orderedMiddle = [...middle].sort((a, b) => (pos.get(a.slug)! - pos.get(b.slug)!));
  } else {
    orderedMiddle = [...middle].sort((a, b) => b.coreSections.length - a.coreSections.length);
  }

  const finalPages = [intro, ...orderedMiddle, biblio];
  const pageOrder = finalPages.map((p) => p.slug);

  // 7. Prune relatedPageSlugs to existing slugs.
  for (const page of finalPages) {
    page.relatedPageSlugs = page.relatedPageSlugs.filter((s) => slugSet.has(s) && s !== page.slug);
    // 2026-06-30: keep relatedPages in sync with the pruned slug list AND
    // back-fill missing typed entries from the surviving slug list. Two
    // legitimate states we have to handle:
    //   (a) v2 LLM produced relatedPages with proper relations → just prune.
    //   (b) v1 LLM produced relatedPageSlugs only; coerce produced empty
    //       relatedPages → synthesize {slug, "extends"} entries so the writer
    //       prompt isn't blank.
    if (page.relatedPages.length > 0) {
      page.relatedPages = page.relatedPages.filter(
        (rp) => slugSet.has(rp.slug) && rp.slug !== page.slug,
      );
    }
    const existingRelSlugs = new Set(page.relatedPages.map((rp) => rp.slug));
    for (const slug of page.relatedPageSlugs) {
      if (!existingRelSlugs.has(slug)) {
        page.relatedPages.push({ slug, relation: DEFAULT_RELATION });
        existingRelSlugs.add(slug);
      }
    }
    // And in the other direction: a v2 plan may have relatedPages without
    // relatedPageSlugs being populated → rebuild from the typed list so the
    // legacy field is never empty.
    if (page.relatedPageSlugs.length === 0 && page.relatedPages.length > 0) {
      page.relatedPageSlugs = page.relatedPages.map((rp) => rp.slug);
    }
  }

  // 8. Repair / synthesize the argument map (2026-06-30).
  const argumentMap = repairArgumentMap(plan.argumentMap, plan.globalThesis, finalPages);

  // 9. Backfill subClaimId on content pages from the argument map. Content
  //    page = anything that is neither the introductory page nor the
  //    bibliography page. If repair backfilled supportedByPages for orphans,
  //    those pages now inherit a subClaimId here.
  const subClaimByPage = new Map<string, string>();
  for (const sc of argumentMap.subClaims) {
    for (const slug of sc.supportedByPages) subClaimByPage.set(slug, sc.id);
  }
  for (const page of finalPages) {
    if (page.audience === INTRO_AUDIENCE || isBibliographyPage(page)) {
      // Intro renders the whole map; bibliography is a reference list.
      // Clear any stray subClaimId the LLM put there.
      delete page.subClaimId;
      continue;
    }
    const mapped = subClaimByPage.get(page.slug);
    if (mapped) page.subClaimId = mapped;
  }

  return {
    globalThesis: plan.globalThesis,
    totalPages: finalPages.length,
    pages: finalPages,
    pageOrder,
    argumentMap,
  };
}

/**
 * 2026-06-30 — repair / synthesize the argument map.
 *
 * Goals:
 *   • argumentMap exists (synthesize a degenerate one if the LLM forgot)
 *   • 3 ≤ subClaims.length ≤ 8 (pad with synthetic claims from spine threads;
 *     drop excess by merging supportedByPages into the kept ones)
 *   • supportedByPages references existing page slugs only
 *   • dependsOn references existing sub-claim ids only, no cycles
 *   • EVERY content page (not intro, not bibliography) appears in exactly
 *     one sub-claim's supportedByPages (orphans assigned to a synthetic
 *     "uncategorized" claim or distributed round-robin)
 *
 * The repaired map is never empty: if everything fails, we synthesize a
 * single sub-claim covering all content pages, then split into 3 by
 * partitioning the pages, so downstream prompts always have material.
 */
function repairArgumentMap(
  raw: ArgumentMap | undefined,
  globalThesis: string,
  pages: WikiPlanPage[],
): ArgumentMap {
  const contentPages = pages.filter(
    (p) => p.audience !== INTRO_AUDIENCE && !isBibliographyPage(p),
  );
  const contentSlugSet = new Set(contentPages.map((p) => p.slug));

  // Start from whatever the LLM gave us (possibly empty / nonsense).
  let subClaims: SubClaim[] = (raw?.subClaims ?? []).map((sc, i) => ({
    id: sc.id || `C${i + 1}`,
    claim: sc.claim || "",
    supportedByPages: sc.supportedByPages.filter((s) => contentSlugSet.has(s)),
    dependsOn: sc.dependsOn,
  }));

  // Drop empty-claim entries (LLM hallucinated structure with no content).
  subClaims = subClaims.filter((sc) => sc.claim.trim().length > 0);

  // Dedupe ids — if the LLM reused an id, suffix to disambiguate.
  const seenIds = new Set<string>();
  for (const sc of subClaims) {
    let id = sc.id;
    let i = 2;
    while (seenIds.has(id)) id = `${sc.id}-${i++}`;
    sc.id = id;
    seenIds.add(id);
  }

  // Synthesize from spine-derived narrative roles when LLM gave us nothing.
  // Each content page gets its own sub-claim (one page = one claim) so the
  // degenerate case still satisfies "every content page argues for a claim".
  if (subClaims.length === 0 && contentPages.length > 0) {
    subClaims = contentPages.map((p, i) => ({
      id: `C${i + 1}`,
      claim:
        p.purpose ||
        p.narrativeRole ||
        `${p.title} is a load-bearing piece of the argument`,
      supportedByPages: [p.slug],
      dependsOn: [],
    }));
  }

  // Enforce "each content page is supported by exactly ONE sub-claim". If
  // the LLM listed the same page under multiple sub-claims, keep the FIRST
  // occurrence and remove from subsequent ones. This invariant lets the
  // writer prompt assign a single subClaimId per page deterministically.
  const seenPages = new Set<string>();
  for (const sc of subClaims) {
    sc.supportedByPages = sc.supportedByPages.filter((s) => {
      if (seenPages.has(s)) return false;
      seenPages.add(s);
      return true;
    });
  }
  // Drop sub-claims left with NO pages after dedup.
  subClaims = subClaims.filter((sc) => sc.supportedByPages.length > 0);

  // Assign orphan content pages to sub-claims. Greedy: pages without a
  // supportedBy mapping land in the first sub-claim by default; if there are
  // many orphans, distribute round-robin so no single claim balloons.
  const assigned = new Set<string>();
  for (const sc of subClaims) for (const s of sc.supportedByPages) assigned.add(s);
  const orphans = contentPages.filter((p) => !assigned.has(p.slug));
  if (orphans.length > 0) {
    if (subClaims.length === 0) {
      // Defensive: should not happen given the synthesize step above, but
      // keeps the function total.
      subClaims.push({
        id: "C1",
        claim: globalThesis || "Overall argument",
        supportedByPages: orphans.map((p) => p.slug),
        dependsOn: [],
      });
    } else {
      orphans.forEach((p, i) => {
        subClaims[i % subClaims.length]!.supportedByPages.push(p.slug);
      });
    }
  }

  // Trim to MAX. Merge tail claims' pages into the last kept claim.
  if (subClaims.length > ARGUMENT_MAP_MAX_SUBCLAIMS) {
    const kept = subClaims.slice(0, ARGUMENT_MAP_MAX_SUBCLAIMS);
    const dropped = subClaims.slice(ARGUMENT_MAP_MAX_SUBCLAIMS);
    const last = kept[kept.length - 1]!;
    for (const d of dropped) {
      for (const s of d.supportedByPages) {
        if (!last.supportedByPages.includes(s)) last.supportedByPages.push(s);
      }
    }
    subClaims = kept;
  }

  // Pad to MIN by splitting the largest sub-claim if needed (best-effort —
  // we don't invent new claims out of thin air, just partition pages).
  while (subClaims.length < ARGUMENT_MAP_MIN_SUBCLAIMS && contentPages.length >= ARGUMENT_MAP_MIN_SUBCLAIMS) {
    const largest = subClaims
      .slice()
      .sort((a, b) => b.supportedByPages.length - a.supportedByPages.length)[0];
    if (!largest || largest.supportedByPages.length < 2) break;
    const half = Math.ceil(largest.supportedByPages.length / 2);
    const split: SubClaim = {
      id: `${largest.id}-split`,
      claim: `${largest.claim} (continued)`,
      supportedByPages: largest.supportedByPages.slice(half),
      dependsOn: [largest.id],
    };
    largest.supportedByPages = largest.supportedByPages.slice(0, half);
    subClaims.push(split);
  }

  // Sanitize dependsOn: keep only references to other-existing sub-claim
  // ids, drop self-loops, then break any cycles by removing back-edges in a
  // DFS visit order.
  const idSet = new Set(subClaims.map((sc) => sc.id));
  for (const sc of subClaims) {
    sc.dependsOn = sc.dependsOn.filter((d) => idSet.has(d) && d !== sc.id);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const byId = new Map(subClaims.map((sc) => [sc.id, sc] as const));
  function visit(id: string): void {
    if (done.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const sc = byId.get(id);
    if (sc) {
      sc.dependsOn = sc.dependsOn.filter((d) => {
        if (visiting.has(d)) return false; // back-edge → drop
        visit(d);
        return true;
      });
    }
    visiting.delete(id);
    done.add(id);
  }
  for (const sc of subClaims) visit(sc.id);

  return {
    thesis: raw?.thesis?.trim() || globalThesis || "Argument map",
    subClaims,
  };
}

// ── Synthesizers ─────────────────────────────────────────────────────────────

function synthesizeIntro(input: OutlineWikiInput): WikiPlanPage {
  const coreSections =
    input.spine.eras.length > 0
      ? input.spine.eras.map((e) => e.name)
      : input.spine.threads.map((t) => t.name);
  return {
    slug: "overview",
    title: `Overview: ${input.problem.title}`,
    purpose: `Introduce ${input.problem.title} for a newcomer: the statement, why it matters, and the shape of the research landscape.`,
    audience: INTRO_AUDIENCE,
    estimatedLengthWords: 2000,
    coreSections: coreSections.length > 0 ? coreSections : ["Problem Statement", "Historical Development", "Current State"],
    keyEffortsCited: input.spine.nodes.slice(0, 3).map((n) => n.id),
    keyPaperReadsCited: input.reads.slice(0, 3).map((r) => r.paperId),
    relatedPageSlugs: [],
    relatedPages: [],
    narrativeRole: "introduction",
  };
}

function synthesizeBibliography(input: OutlineWikiInput): WikiPlanPage {
  return {
    slug: "bibliography",
    title: "Bibliography",
    purpose: "Annotated list of all papers consulted, grouped by role, with prior surveys called out separately.",
    audience: "specialist-refresher",
    estimatedLengthWords: 1000,
    coreSections: ["Primary Papers", "Foundational References", "Prior Surveys & Expositions"],
    keyEffortsCited: [],
    keyPaperReadsCited: input.reads.map((r) => r.paperId),
    relatedPageSlugs: [],
    relatedPages: [],
    narrativeRole: "references",
  };
}

function synthesizeStateOfTheArt(input: OutlineWikiInput, existing: WikiPlanPage[]): WikiPlanPage {
  return {
    slug: ensureUniqueSlug("current-state-of-the-art", existing),
    title: "Current State of the Art",
    purpose: input.spine.globalThesis || `The best known results and active frontier of ${input.problem.title}.`,
    audience: "expert-checking-status",
    estimatedLengthWords: 1800,
    coreSections: input.spine.threads.map((t) => t.name).slice(0, 5),
    keyEffortsCited: input.spine.nodes.slice(0, 2).map((n) => n.id),
    keyPaperReadsCited: input.reads.slice(0, 2).map((r) => r.paperId),
    relatedPageSlugs: [],
    relatedPages: [],
    narrativeRole: "current frontier",
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isBibliographyPage(p: WikiPlanPage): boolean {
  const role = p.narrativeRole.toLowerCase();
  return (
    p.slug === "bibliography" ||
    p.slug.endsWith("-bibliography") ||
    role.includes("bibliograph") ||
    role.includes("references")
  );
}

function topNodeIdsForRole(narrativeRole: string, spine: NarrativeSpine, n: number): string[] {
  if (spine.threads.length === 0) return spine.nodes.slice(0, n).map((node) => node.id);
  const role = narrativeRole.toLowerCase();
  const match: SpineThread | undefined =
    spine.threads.find((t) => role && (t.name.toLowerCase().includes(role) || role.includes(t.name.toLowerCase()))) ??
    spine.threads[0];
  return (match?.nodeIds ?? []).slice(0, n);
}

function ensureUniqueSlug(base: string, pages: WikiPlanPage[]): string {
  const used = new Set(pages.map((p) => p.slug));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

// ── Persistence ──────────────────────────────────────────────────────────────

export function wikiPlanDir(projectDir: string): string {
  return path.join(projectDir, ".mathran", "wiki-plan");
}

export function wikiPlanFile(projectDir: string): string {
  return path.join(wikiPlanDir(projectDir), "wiki-plan.json");
}

/** Persist a WikiPlan to `<project>/.mathran/wiki-plan/wiki-plan.json`. */
export async function persistWikiPlan(projectDir: string, plan: WikiPlan): Promise<void> {
  await fs.mkdir(wikiPlanDir(projectDir), { recursive: true });
  await fs.writeFile(wikiPlanFile(projectDir), JSON.stringify(plan, null, 2) + "\n", "utf-8");
}

/** Read a persisted WikiPlan, or null if none/invalid. */
export async function readWikiPlan(projectDir: string): Promise<WikiPlan | null> {
  try {
    return JSON.parse(await fs.readFile(wikiPlanFile(projectDir), "utf-8")) as WikiPlan;
  } catch {
    return null;
  }
}
