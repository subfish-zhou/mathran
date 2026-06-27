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
  relatedPageSlugs: string[];
  narrativeRole: string;
}

export interface WikiPlan {
  globalThesis: string;
  totalPages: number;
  pages: WikiPlanPage[];
  pageOrder: string[];
}

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
    const raw = await deps.llm(prompt, { temperature: 0.4, maxTokens: 4000 });
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
      relatedPageSlugs: asStringArray(p.relatedPageSlugs),
      narrativeRole: String(p.narrativeRole ?? ""),
    };
  });

  return {
    globalThesis: String(parsed.globalThesis ?? input.spine.globalThesis ?? input.problem.title),
    totalPages: pages.length,
    pages,
    pageOrder: asStringArray(parsed.pageOrder),
  };
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
  }

  return {
    globalThesis: plan.globalThesis,
    totalPages: finalPages.length,
    pages: finalPages,
    pageOrder,
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
