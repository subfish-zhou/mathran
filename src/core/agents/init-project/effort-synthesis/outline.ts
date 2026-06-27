/**
 * Effort Synthesis — Step 1: outline call (Task 22).
 *
 * One LLM call per effort produces an `EffortOutline`: the LLM decides the
 * document's section structure (NOT a fixed 7-point template). Post-LLM repair
 * enforces the invariants the prompt asks for:
 *   - 3 ≤ sections ≤ 10
 *   - every section cites ≥1 paper-read OR ≥1 predecessor effort
 *   - anchors are url-safe and unique
 *
 * If the LLM fails entirely, we fall back to a 3-section default
 * (Setup + Main Results + Discussion).
 */

import { slugify } from "../../../../lib/slug.js";
import { extractSpineJSON, errMsg, type SpineLLM } from "../spine/llm.js";
import { buildEffortOutlinePrompt } from "./prompts.js";
import type { NarrativeSpine, SpineNode } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export type EffortNarrativeRole =
  | "core_technique"
  | "milestone"
  | "bridge"
  | "barrier"
  | "refinement"
  | "foundational"
  | "dead_end"
  | "open_direction"
  | "background";

export interface EffortOutlineCitation {
  kind: "paper-read" | "effort";
  id: string;
  anchor?: string;
}

export interface EffortOutlineSection {
  heading: string;
  anchor: string;
  purpose: string;
  targetParagraphs: number;
  mustCite: EffortOutlineCitation[];
}

export interface EffortOutline {
  title: string;
  thesis: string;
  narrativeRole: EffortNarrativeRole;
  sections: EffortOutlineSection[];
}

const VALID_ROLES: ReadonlySet<EffortNarrativeRole> = new Set([
  "core_technique",
  "milestone",
  "bridge",
  "barrier",
  "refinement",
  "foundational",
  "dead_end",
  "open_direction",
  "background",
]);

const MIN_SECTIONS = 3;
const MAX_SECTIONS = 10;

/** Map a spine node type onto the closest effort narrative role. */
function defaultRoleForNode(node: SpineNode): EffortNarrativeRole {
  switch (node.type) {
    case "foundation": return "foundational";
    case "milestone": return "milestone";
    case "technique_origin": return "core_technique";
    case "refinement": return "refinement";
    case "barrier": return "barrier";
    case "bridge": return "bridge";
    case "dead_end": return "dead_end";
    case "open_direction": return "open_direction";
    default: return "background";
  }
}

function firstCitation(
  paperReads: PaperRead[],
  predecessors: SpineNode[],
): EffortOutlineCitation | null {
  if (paperReads.length > 0) {
    return { kind: "paper-read", id: paperReads[0].arxivId ?? paperReads[0].paperId };
  }
  if (predecessors.length > 0) {
    return { kind: "effort", id: predecessors[0].id };
  }
  return null;
}

/** The deterministic fallback used when the LLM produces nothing usable. */
export function defaultEffortOutline(
  node: SpineNode,
  paperReads: PaperRead[],
  predecessors: SpineNode[],
): EffortOutline {
  const cite = firstCitation(paperReads, predecessors);
  const mustCite = cite ? [cite] : [];
  return {
    title: node.title,
    thesis: node.significance || node.statement.slice(0, 200),
    narrativeRole: defaultRoleForNode(node),
    sections: [
      { heading: "Setup", anchor: "setup", purpose: "Define the objects, notation, and standing assumptions.", targetParagraphs: 2, mustCite: [...mustCite] },
      { heading: "Main Results", anchor: "main-results", purpose: "State the key theorems with full LaTeX.", targetParagraphs: 3, mustCite: [...mustCite] },
      { heading: "Discussion", anchor: "discussion", purpose: "Situate the result and note limitations.", targetParagraphs: 2, mustCite: [...mustCite] },
    ],
  };
}

function sanitizeCitation(
  raw: unknown,
  validReadIds: Set<string>,
  validEffortIds: Set<string>,
): EffortOutlineCitation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === "string" ? c.id : null;
  if (!id) return null;
  const kind = c.kind === "effort" ? "effort" : "paper-read";
  if (kind === "paper-read" && !validReadIds.has(id)) return null;
  if (kind === "effort" && !validEffortIds.has(id)) return null;
  const out: EffortOutlineCitation = { kind, id };
  if (typeof c.anchor === "string" && c.anchor) out.anchor = c.anchor;
  return out;
}

/**
 * Repair a raw (possibly partial / malformed) outline into a valid one.
 * Exported for unit testing the invariant enforcement in isolation.
 */
export function repairOutline(
  raw: Partial<EffortOutline> | null | undefined,
  node: SpineNode,
  paperReads: PaperRead[],
  predecessors: SpineNode[],
): EffortOutline {
  const fallback = defaultEffortOutline(node, paperReads, predecessors);
  if (!raw || !Array.isArray(raw.sections) || raw.sections.length === 0) {
    if (raw && typeof raw.title === "string" && raw.title) fallback.title = raw.title;
    if (raw && typeof raw.thesis === "string" && raw.thesis) fallback.thesis = raw.thesis;
    if (raw && typeof raw.narrativeRole === "string" && VALID_ROLES.has(raw.narrativeRole as EffortNarrativeRole)) {
      fallback.narrativeRole = raw.narrativeRole as EffortNarrativeRole;
    }
    return fallback;
  }

  const validReadIds = new Set(paperReads.map((r) => r.arxivId ?? r.paperId));
  const validEffortIds = new Set(predecessors.map((n) => n.id));
  const defaultCite = firstCitation(paperReads, predecessors);

  const usedAnchors = new Set<string>();
  const uniqueAnchor = (base: string): string => {
    let a = slugify(base, "section");
    let n = 2;
    while (usedAnchors.has(a)) a = `${slugify(base, "section")}-${n++}`;
    usedAnchors.add(a);
    return a;
  };

  let sections: EffortOutlineSection[] = (raw.sections as unknown[])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => {
      const heading = typeof s.heading === "string" && s.heading.trim() ? s.heading.trim() : "Section";
      const anchor = uniqueAnchor(typeof s.anchor === "string" && s.anchor ? s.anchor : heading);
      const purpose = typeof s.purpose === "string" ? s.purpose : "";
      const tp = typeof s.targetParagraphs === "number" && s.targetParagraphs > 0
        ? Math.min(8, Math.round(s.targetParagraphs))
        : 2;
      const mustCiteRaw = Array.isArray(s.mustCite) ? s.mustCite : [];
      let mustCite = mustCiteRaw
        .map((c) => sanitizeCitation(c, validReadIds, validEffortIds))
        .filter((c): c is EffortOutlineCitation => c != null);
      if (mustCite.length === 0 && defaultCite) mustCite = [defaultCite];
      return { heading, anchor, purpose, targetParagraphs: tp, mustCite };
    });

  // Enforce ≥3 sections: pad from the default outline.
  if (sections.length < MIN_SECTIONS) {
    for (const extra of fallback.sections) {
      if (sections.length >= MIN_SECTIONS) break;
      const anchor = uniqueAnchor(extra.anchor);
      sections.push({ ...extra, anchor });
    }
  }
  // Enforce ≤10 sections: truncate.
  if (sections.length > MAX_SECTIONS) sections = sections.slice(0, MAX_SECTIONS);

  const role = typeof raw.narrativeRole === "string" && VALID_ROLES.has(raw.narrativeRole as EffortNarrativeRole)
    ? (raw.narrativeRole as EffortNarrativeRole)
    : fallback.narrativeRole;

  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : fallback.title,
    thesis: typeof raw.thesis === "string" && raw.thesis.trim() ? raw.thesis.trim() : fallback.thesis,
    narrativeRole: role,
    sections,
  };
}

export async function generateEffortOutline(
  node: SpineNode,
  paperReads: PaperRead[],
  spineContext: { spine: NarrativeSpine; predecessors: SpineNode[]; successors: SpineNode[] },
  deps: { llm: SpineLLM; emitLog?: (m: string) => void },
): Promise<EffortOutline> {
  const emit = deps.emitLog ?? (() => {});
  let raw: Partial<EffortOutline> | null = null;
  try {
    const prompt = buildEffortOutlinePrompt(node, paperReads, spineContext);
    const reply = await deps.llm(prompt, { temperature: 0.4 });
    raw = extractSpineJSON<Partial<EffortOutline>>(reply);
    if (!raw) emit(`[effort-outline] ${node.id}: LLM reply had no parseable JSON; using fallback`);
  } catch (err) {
    emit(`[effort-outline] ${node.id}: LLM call failed (${errMsg(err)}); using fallback`);
  }
  const outline = repairOutline(raw, node, paperReads, spineContext.predecessors);
  emit(`[effort-outline] ${node.id}: ${outline.sections.length} sections`);
  return outline;
}
