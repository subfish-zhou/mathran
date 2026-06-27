/**
 * Reader — Read pass, Regime B (section-by-section read).
 *
 * Used by the orchestrator when the source is large (`source.bytes > 30_000`)
 * and `source.sectionMarkers` are available. The source is split into per-section
 * chunks; each section is read in its own LLM call, then a final LLM call merges
 * the section reads into one coherent `PaperReadBody` (deduplicated main results,
 * consolidated technical dependencies).
 *
 * Reads run sequentially (mathran's LLMProvider may not handle concurrency well).
 * Never throws: section-read and synthesis failures degrade gracefully.
 */

import type { PaperNode, PaperReadBody } from "../../../paper-graph/types.js";
import { extractSpineJSON, errMsg } from "../spine/llm.js";
import { buildSectionReadPrompt, buildSectionSynthesisPrompt } from "./prompts.js";
import type { LoadedSource } from "./source-loader.js";
import {
  coercePaperReadBody,
  degeneratePaperReadBody,
  ensureMainResults,
  readPaperRegimeA,
  type ReadRegimeDeps,
} from "./read-regime-a.js";

/** Per-section structured read; exported for tests. */
export interface SectionRead {
  sectionTitle: string;
  byteOffset: number;
  theoremsStated: Array<{ label: string; statement: string }>;
  dependenciesIntroduced: string[];
  techniqueRole: string;
}

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function coerceTheorems(v: unknown): Array<{ label: string; statement: string }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ label: string; statement: string }> = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const label = asString(o.label).trim();
    const statement = asString(o.statement).trim();
    if (!label && !statement) continue;
    out.push({ label: label || "Theorem", statement });
  }
  return out;
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(asString).filter((s) => s.trim().length > 0);
}

/**
 * Split `source.text` by `sectionMarkers` into `{ title, text, offset }` chunks.
 * Each section spans `[marker.byteOffset, nextMarker.byteOffset)`.
 */
export function splitIntoSections(
  source: LoadedSource,
): Array<{ title: string; text: string; byteOffset: number }> {
  const markers = source.sectionMarkers;
  const sections: Array<{ title: string; text: string; byteOffset: number }> = [];
  if (!markers || markers.length === 0) return sections;
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].byteOffset;
    const end = i + 1 < markers.length ? markers[i + 1].byteOffset : source.text.length;
    sections.push({
      title: markers[i].title,
      text: source.text.slice(start, end),
      byteOffset: start,
    });
  }
  return sections;
}

/** Read a single section in its own LLM call. Never throws. */
export async function readSection(
  paper: PaperNode,
  sectionTitle: string,
  sectionText: string,
  deps: ReadRegimeDeps,
  alreadyReadSectionTitles: string[] = [],
  byteOffset = 0,
): Promise<SectionRead> {
  const log = deps.emitLog ?? (() => {});
  const prompt = buildSectionReadPrompt(
    paper,
    sectionTitle,
    sectionText,
    alreadyReadSectionTitles,
  );

  const empty: SectionRead = {
    sectionTitle,
    byteOffset,
    theoremsStated: [],
    dependenciesIntroduced: [],
    techniqueRole: "",
  };

  let reply: string;
  try {
    reply = await deps.llm(prompt, { temperature: 0.2 });
  } catch (err) {
    log(`[read:B] section "${sectionTitle}" LLM call failed: ${errMsg(err)}`);
    return empty;
  }

  const raw = extractSpineJSON(reply);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    log(`[read:B] section "${sectionTitle}" produced unparseable output`);
    return empty;
  }
  const o = raw as Record<string, unknown>;
  return {
    sectionTitle: asString(o.sectionTitle).trim() || sectionTitle,
    byteOffset,
    theoremsStated: coerceTheorems(o.theoremsStated),
    dependenciesIntroduced: coerceStringArray(o.dependenciesIntroduced),
    techniqueRole: asString(o.techniqueRole),
  };
}

/** Render a section read as a compact textual summary for the synthesis prompt. */
function summarizeSectionRead(sr: SectionRead): string {
  const lines: string[] = [];
  if (sr.theoremsStated.length > 0) {
    lines.push("Results stated:");
    for (const t of sr.theoremsStated) {
      lines.push(`  - ${t.label}: ${t.statement}`);
    }
  } else {
    lines.push("Results stated: (none)");
  }
  if (sr.dependenciesIntroduced.length > 0) {
    lines.push(`External results invoked: ${sr.dependenciesIntroduced.join("; ")}`);
  }
  if (sr.techniqueRole.trim()) {
    lines.push(`Role of this section: ${sr.techniqueRole.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Build a degenerate body directly from the section reads (used when the final
 * synthesis LLM call fails). Aggregates every stated theorem as a main result.
 */
function bodyFromSectionReads(paper: PaperNode, sectionReads: SectionRead[]): PaperReadBody {
  const body = degeneratePaperReadBody(paper);
  const mainResults: PaperReadBody["mainResults"] = [];
  const deps = new Set<string>();
  for (const sr of sectionReads) {
    for (const t of sr.theoremsStated) {
      mainResults.push({
        label: t.label,
        statement: t.statement,
        whereInPaper: sr.sectionTitle,
        noveltyVsPrior: "",
      });
    }
    for (const d of sr.dependenciesIntroduced) deps.add(d);
  }
  if (mainResults.length > 0) {
    body.mainResults = mainResults;
  }
  body.technicalDependencies = [...deps].map((claim) => ({
    claim,
    source: "",
    whereUsed: "",
  }));
  return body;
}

/** Merge section reads into a coherent PaperReadBody via one final LLM call. */
export async function synthesizeSections(
  paper: PaperNode,
  sectionReads: SectionRead[],
  deps: ReadRegimeDeps,
): Promise<PaperReadBody> {
  const log = deps.emitLog ?? (() => {});
  const summaries = sectionReads.map((sr) => ({
    title: sr.sectionTitle,
    summary: summarizeSectionRead(sr),
  }));
  const prompt = buildSectionSynthesisPrompt(paper, summaries);

  let reply: string;
  try {
    reply = await deps.llm(prompt, { temperature: 0.2 });
  } catch (err) {
    log(`[read:B] synthesis LLM call failed: ${errMsg(err)} — assembling body from sections`);
    return bodyFromSectionReads(paper, sectionReads);
  }

  const body = coercePaperReadBody(extractSpineJSON(reply));
  if (!body) {
    log(`[read:B] synthesis output unparseable — assembling body from sections`);
    return bodyFromSectionReads(paper, sectionReads);
  }
  return ensureMainResults(body, paper);
}

/**
 * Section-by-section read. Splits the source by `sectionMarkers`, reads each
 * section in its own LLM call, then synthesizes a single PaperReadBody.
 * Falls back to Regime A when there are fewer than 2 section markers.
 */
export async function readPaperRegimeB(
  paper: PaperNode,
  source: LoadedSource,
  deps: ReadRegimeDeps,
): Promise<PaperReadBody> {
  const log = deps.emitLog ?? (() => {});
  if (!source.sectionMarkers || source.sectionMarkers.length < 2) {
    log(`[read:B] <2 section markers — falling back to Regime A`);
    return readPaperRegimeA(paper, source, deps);
  }

  const sections = splitIntoSections(source);
  const sectionReads: SectionRead[] = [];
  const readTitles: string[] = [];
  for (const sec of sections) {
    const sr = await readSection(paper, sec.title, sec.text, deps, readTitles, sec.byteOffset);
    sectionReads.push(sr);
    readTitles.push(sec.title);
  }

  return synthesizeSections(paper, sectionReads, deps);
}
