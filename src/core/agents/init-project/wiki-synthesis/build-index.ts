/**
 * Wiki Synthesis — auto-generated TOC `_index.md` (DESIGN-REFERENCE Part 4,
 * Phase H Task 29).
 *
 * Pure template, no LLM call. Renders the WikiPlan's `pageOrder` as a numbered
 * reading list (each captioned with the page's `purpose`) plus `[next →]` /
 * `[← prev]` navigation chips between consecutive pages.
 */

import type { WikiPlan } from "../wiki-plan/index.js";

export function buildWikiIndex(
  plan: WikiPlan,
  writtenPages: Array<{ slug: string; title: string }>,
): string {
  const titleBySlug = new Map(writtenPages.map((p) => [p.slug, p.title]));
  const pageBySlug = new Map(plan.pages.map((p) => [p.slug, p]));

  // Reading order: prefer pageOrder, restricted to pages that were actually
  // written; fall back to the written-page order.
  const written = new Set(writtenPages.map((p) => p.slug));
  let order = plan.pageOrder.filter((s) => written.has(s));
  if (order.length === 0) order = writtenPages.map((p) => p.slug);

  const projectName = plan.globalThesis?.trim() || "Project";

  const lines: string[] = [];
  lines.push(`# Wiki — ${projectName}`);
  lines.push("");
  lines.push(
    `This wiki is organized as a ${order.length}-page survey; read it top-to-bottom or jump to any page below.`,
  );
  lines.push("");

  order.forEach((slug, i) => {
    const planPage = pageBySlug.get(slug);
    const title = titleBySlug.get(slug) ?? planPage?.title ?? slug;
    const purpose = (planPage?.purpose ?? "").replace(/\s+/g, " ").trim();

    lines.push(`${i + 1}. [${title}](./${slug}.md)`);
    if (purpose) lines.push(`   - ${purpose}`);

    const nav: string[] = [];
    const prev = i > 0 ? order[i - 1]! : null;
    const next = i < order.length - 1 ? order[i + 1]! : null;
    if (prev) nav.push(`[← prev](./${prev}.md)`);
    if (next) nav.push(`[next →](./${next}.md)`);
    if (nav.length > 0) lines.push(`   - ${nav.join(" · ")}`);
  });

  lines.push("");
  return lines.join("\n");
}
