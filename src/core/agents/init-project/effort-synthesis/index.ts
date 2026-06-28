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

import {
  reviewLoop,
  DEFAULT_REVIEW_LOOP_BUDGET,
  type ReviewLoopBudget,
  type ReviewLoopResult,
} from "../review-loop/index.js";

import type { NarrativeSpine, SpineNode, SpineNodeDepth } from "../spine/types.js";
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
  /** Writer model: drafts the outline, sections, README. */
  llm: SpineLLM;
  /**
   * Reviewer model — SEPARATE from the writer (§6.7). When provided, document.md
   * and README.md are run through the writer-reviewer review loop after drafting.
   * When omitted, the review loop is skipped (back-compat for callers that have
   * no second model wired in).
   */
  reviewerLlm?: SpineLLM;
  /** Routing label for the writer model (cost estimation only). */
  writerModel?: string;
  /** Routing label for the reviewer model (cost estimation only). */
  reviewerModel?: string;
  /** Override the default per-artifact review budget (3 revisions / $5). */
  reviewBudget?: ReviewLoopBudget;
  estimateCost?: (model: string, tokens: { in: number; out: number }) => number;
  emitLog?: (m: string) => void;
}

export interface EffortDocumentRevision {
  revisionNumber: number;
  timestamp: string;
  /**
   * `approve` / `rewrite_requested` — normal reviewer verdicts.
   * `reviewer_broken` — reviewer returned unparseable JSON or threw mid-call
   * (after a strict-format retry). The artifact was kept and surfaced for
   * human review with the failure mode named, instead of silently approved.
   */
  reviewerVerdict: "approve" | "rewrite_requested" | "reviewer_broken";
  reviewerNotes: string;
}

export interface EffortSynthesisResult {
  effortId: string;
  documentPath: string;
  readmePath: string;
  readingNotesPath: string;
  outline: EffortOutline;
  /** Present only when the review loop ran (reviewerLlm supplied). */
  documentRevisions?: EffortDocumentRevision[];
}

const SCRATCH_PLACEHOLDER = "> Your scratch space; not touched by the agent.\n";

function effortId(node: SpineNode): string {
  return slugify(node.title, node.id || "effort");
}

/** Audience hint for the effort document, derived from spine-node depth. */
function documentAudience(depth: SpineNodeDepth): string {
  switch (depth) {
    case "incremental":
      return "expert";
    case "foundational":
      return "graduate-student-entering-field";
    default:
      return "specialist-refresher";
  }
}

/** Flatten a ReviewLoopResult's history into the effort.json revision schema (§5.5). */
function toDocumentRevisions(result: ReviewLoopResult): EffortDocumentRevision[] {
  return result.revisionHistory.map((r) => ({
    revisionNumber: r.revisionNumber,
    timestamp: r.timestamp,
    reviewerVerdict: r.reviewerVerdict.verdict,
    reviewerNotes:
      r.reviewerVerdict.overallReaderExperience ||
      r.reviewerVerdict.verdictReasoning ||
      "",
  }));
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
  let documentContent = document;
  const documentPath = path.join(dir, "document.md");
  await atomicWriteFile(documentPath, documentContent);

  // ── Step 3: README reading guide ──
  const readme = await generateEffortReadme(
    node,
    document,
    paperReads,
    { problemTitle, predecessors: predecessorNodes, successors: successorNodes },
    deps,
  );
  let readmeContent = readme;
  const readmePath = path.join(dir, "README.md");
  await atomicWriteFile(readmePath, readmeContent);

  // ── Step 3.5: writer-reviewer review loop (DESIGN-REFERENCE §6.5) ──
  // Only runs when a SEPARATE reviewer model is supplied. document.md is
  // reviewed for its node-depth audience; README.md as the most reader-facing
  // artifact for a graduate student entering the field.
  let documentRevisions: EffortDocumentRevision[] | undefined;
  if (deps.reviewerLlm) {
    const writerModel = deps.writerModel ?? "writer";
    const reviewerModel = deps.reviewerModel ?? "reviewer";
    const budget = deps.reviewBudget ?? DEFAULT_REVIEW_LOOP_BUDGET;
    const loopDeps = {
      writerLlm: deps.llm,
      reviewerLlm: deps.reviewerLlm,
      emitLog: emit,
      estimateCost: deps.estimateCost,
    };

    try {
      const docResult = await reviewLoop(
        {
          artifactKind: "effort-document",
          artifactTitle: outline.title,
          artifactSlug: id,
          initialContent: documentContent,
          sourcePaperReads: paperReads,
          topic: problemTitle,
          audienceHint: documentAudience(node.depth),
          writerModel,
          reviewerModel,
        },
        budget,
        loopDeps,
      );
      documentContent = docResult.finalContent;
      await atomicWriteFile(documentPath, documentContent);
      documentRevisions = toDocumentRevisions(docResult);
      emit(
        `[effort-synthesis] ${id}: document review ${docResult.finalVerdict} ` +
          `(${docResult.revisionHistory.length - 1} rewrite(s), $${docResult.totalCostUsd.toFixed(3)})`,
      );
    } catch (err) {
      emit(`[effort-synthesis] ${id}: document review loop failed (${errMsg(err)})`);
    }

    try {
      const readmeResult = await reviewLoop(
        {
          artifactKind: "effort-readme",
          artifactTitle: `${outline.title} — Reading Guide`,
          artifactSlug: `${id}-readme`,
          initialContent: readmeContent,
          sourcePaperReads: paperReads,
          topic: problemTitle,
          audienceHint: "graduate-student-entering-field",
          writerModel,
          reviewerModel,
        },
        budget,
        loopDeps,
      );
      readmeContent = readmeResult.finalContent;
      await atomicWriteFile(readmePath, readmeContent);
      emit(
        `[effort-synthesis] ${id}: README review ${readmeResult.finalVerdict} ` +
          `(${readmeResult.revisionHistory.length - 1} rewrite(s))`,
      );
    } catch (err) {
      emit(`[effort-synthesis] ${id}: README review loop failed (${errMsg(err)})`);
    }
  }

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
    ...(documentRevisions ? { documentRevisions } : {}),
    generatedBy: "effort-synthesis",
    generatedAt: new Date().toISOString(),
  };
  try {
    await atomicWriteFile(path.join(dir, "effort.json"), JSON.stringify(effortJson, null, 2) + "\n");
  } catch (err) {
    emit(`[effort-synthesis] ${id}: effort.json write failed (${errMsg(err)})`);
  }

  emit(`[effort-synthesis] ${id}: wrote 4-piece set (${outline.sections.length} sections, ${paperReads.length} reads)`);
  return { effortId: id, documentPath, readmePath, readingNotesPath, outline, documentRevisions };
}
