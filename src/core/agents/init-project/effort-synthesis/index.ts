/**
 * Effort Synthesis — Task 26: 4-piece-set orchestrator (Phase 5 entry point).
 *
 * For one spine node, generate all four pieces of the effort directory:
 *   1. document.md                  — real content (outline → section-by-section)
 *   2. README.md                    — agent-to-human reading guide
 *   3. notes/agent-reading-notes.md — PaperRead(s) rendered to markdown
 *   4. scratch/.placeholder.md       — reserved for the human
 *
 * Writes atomically and persists effort.json with the outline + metadata.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicWriteFile } from "../../../chat/atomic-write.js";
import { slugify } from "../../../../lib/slug.js";
import { errMsg, type SpineLLM } from "../spine/llm.js";

import { generateEffortOutline, type EffortOutline } from "./outline.js";
import { writeEffortSection } from "./write-sections.js";
import { generateEffortReadme } from "./readme.js";
import { renderReadingNotes } from "./reading-notes.js";

import type { NarrativeSpine, SpineNode } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export interface EffortSynthesisInput {
  node: SpineNode;
  spine: NarrativeSpine;
  paperReads: PaperRead[];
  predecessorNodes: SpineNode[];
  successorNodes: SpineNode[];
  problemTitle: string;
  /** `<workspace>/projects/<slug>` */
  projectDir: string;
}

export interface EffortSynthesisDeps {
  llm: SpineLLM;
  emitLog?: (m: string) => void;
}

export interface EffortSynthesisResult {
  effortId: string;
  documentPath: string;
  readmePath: string;
  readingNotesPath: string;
  outline: EffortOutline;
}

const SCRATCH_PLACEHOLDER = "> Your scratch space; not touched by the agent.\n";

function effortId(node: SpineNode): string {
  return slugify(node.title, node.id || "effort");
}

function documentFrontmatter(node: SpineNode, outline: EffortOutline, id: string): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(outline.title)}`,
    `spineNodeId: ${node.id}`,
    `narrativeRole: ${outline.narrativeRole}`,
    node.year != null ? `year: ${node.year}` : null,
    `thesis: ${JSON.stringify(outline.thesis)}`,
    "generatedBy: effort-synthesis",
    "---",
    "",
  ].filter((l): l is string => l != null).join("\n");
}

/** Concatenate per-section markdown into the document body. */
function assembleDocument(node: SpineNode, outline: EffortOutline, sections: string[], id: string): string {
  const intro = `# ${outline.title}\n\n*${outline.thesis}*\n`;
  return documentFrontmatter(node, outline, id) + intro + "\n" + sections.join("\n\n").trimEnd() + "\n";
}

export async function synthesizeEffort(
  input: EffortSynthesisInput,
  deps: EffortSynthesisDeps,
): Promise<EffortSynthesisResult> {
  const emit = deps.emitLog ?? (() => {});
  const { node, spine, paperReads, predecessorNodes, successorNodes, problemTitle, projectDir } = input;
  const id = effortId(node);
  const dir = path.join(projectDir, "efforts", id);

  await fs.mkdir(path.join(dir, "notes"), { recursive: true });
  await fs.mkdir(path.join(dir, "scratch"), { recursive: true });
  await fs.mkdir(path.join(dir, "references"), { recursive: true });

  // ── Step 1: outline ──
  const outline = await generateEffortOutline(
    node,
    paperReads,
    { spine, predecessors: predecessorNodes, successors: successorNodes },
    deps,
  );

  // ── Step 2: section-by-section write ──
  const sectionTexts: string[] = [];
  for (let i = 0; i < outline.sections.length; i++) {
    const section = outline.sections[i];
    const text = await writeEffortSection(
      section,
      {
        title: outline.title,
        thesis: outline.thesis,
        previousSectionText: i > 0 ? sectionTexts[i - 1] : null,
        nextSectionHeading: i + 1 < outline.sections.length ? outline.sections[i + 1].heading : null,
      },
      paperReads,
      deps,
    );
    sectionTexts.push(text);
  }
  const document = assembleDocument(node, outline, sectionTexts, id);
  const documentPath = path.join(dir, "document.md");
  await atomicWriteFile(documentPath, document);

  // ── Step 3: README reading guide ──
  const readme = await generateEffortReadme(
    node,
    document,
    paperReads,
    { problemTitle, predecessors: predecessorNodes, successors: successorNodes },
    deps,
  );
  const readmePath = path.join(dir, "README.md");
  await atomicWriteFile(readmePath, readme);

  // ── Step 4a: reading notes (no LLM) ──
  const notesBody = paperReads.length > 0
    ? paperReads.map(renderReadingNotes).join("\n\n---\n\n")
    : "# Reading Notes\n\n_(no paper-reads available for this effort)_\n";
  const readingNotesPath = path.join(dir, "notes", "agent-reading-notes.md");
  await atomicWriteFile(readingNotesPath, notesBody.trimEnd() + "\n");

  // ── Step 4b: scratch placeholder ──
  await atomicWriteFile(path.join(dir, "scratch", ".placeholder.md"), SCRATCH_PLACEHOLDER);

  // ── Persist effort.json ──
  const effortJson = {
    id,
    spineNodeId: node.id,
    title: outline.title,
    thesis: outline.thesis,
    narrativeRole: outline.narrativeRole,
    year: node.year,
    outline,
    readmeStatus: "generated" as const,
    readingNotesStatus: paperReads.length > 0 ? ("generated" as const) : ("skipped" as const),
    includedPaperIds: paperReads.map((r) => r.paperId),
    generatedBy: "effort-synthesis",
    generatedAt: new Date().toISOString(),
  };
  try {
    await atomicWriteFile(path.join(dir, "effort.json"), JSON.stringify(effortJson, null, 2) + "\n");
  } catch (err) {
    emit(`[effort-synthesis] ${id}: effort.json write failed (${errMsg(err)})`);
  }

  emit(`[effort-synthesis] ${id}: wrote 4-piece set (${outline.sections.length} sections, ${paperReads.length} reads)`);
  return { effortId: id, documentPath, readmePath, readingNotesPath, outline };
}
