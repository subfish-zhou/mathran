/**
 * source-loader.ts — Multi-regime source loader for the v3 Reading Loop.
 *
 * Knows where to fetch a paper's full text from and picks the reading
 * regime the orchestrator should use. Unlike the v1 spine builder
 * (which truncates source to PER_PAPER_CAP / BATCH_CAP), this loader
 * NEVER truncates: v3 reads whole papers.
 *
 * Priority: arxiv tex → arxiv pdf (pdftotext) → existing abstract.
 * Failure-isolated: `loadPaperSource` never throws; it falls back to
 * `{ kind: "abstract-only", text: <abstract> }`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";

import type { PaperNode } from "../../../paper-graph/types.js";
import { fetchArxivSource as realFetchArxivSource } from "../../../paper-graph/arxiv-source.js";

export type ReadingRegime = "A" | "B" | "C";

export interface LoadedSource {
  paperId: string;
  kind: "tex" | "pdf-text" | "html" | "abstract-only";
  bytes: number;
  text: string; // full text, NEVER truncated by this loader
  path?: string; // absolute path to underlying file (when applicable)
  /** Always false in v3 — kept optional for downstream callers that fill it. */
  truncated?: boolean;
  sectionMarkers?: Array<{
    title: string;
    level: 1 | 2 | 3;
    byteOffset: number;
  }>;
}

export interface SourceLoaderDeps {
  workspace: string;
  /** Inject for tests; defaults to the real fetchArxivSource. */
  fetchArxivSource?: typeof import("../../../paper-graph/arxiv-source.js").fetchArxivSource;
  /** Inject for tests; defaults to actually invoking pdftotext via child_process. */
  runPdfToText?: (pdfPath: string) => Promise<string | null>;
  /** ms between external fetches; honor arxiv rate-limit when calling real fetchArxivSource. */
  rateDelayMs?: number;
}

const REGIME_A_MAX_BYTES = 30_000;

/**
 * Default pdftotext runner. Spawns `pdftotext -layout <pdf> -` and reads
 * stdout. Returns null on ENOENT (binary missing) or any spawn/exit error
 * so callers can fall back to abstract-only.
 */
function defaultRunPdfToText(pdfPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("pdftotext", ["-layout", pdfPath, "-"]);
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", (code) => {
      done(code === 0 ? out : null);
    });
  });
}

/**
 * Extract \section / \chapter / \subsection markers from .tex source.
 * Returns byte offsets so callers can slice the text without re-parsing.
 * Exported for tests; called internally by loadPaperSource for .tex sources.
 *
 * Defensive: skips commented-out lines (`% \section{...}`), handles the
 * starred variant (`\section*{...}`), and balances nested braces in titles.
 * Levels: \chapter → 1, \section → 2, \subsection → 3. When the paper has
 * no \chapter at all, \section is promoted to level 1.
 */
export function extractSectionMarkers(
  tex: string,
): Array<{ title: string; level: 1 | 2 | 3; byteOffset: number }> {
  const markers: Array<{
    title: string;
    level: 1 | 2 | 3;
    byteOffset: number;
    cmd: "chapter" | "section" | "subsection";
  }> = [];

  const re = /\\(chapter|section|subsection)\*?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex)) !== null) {
    const cmd = m[1] as "chapter" | "section" | "subsection";
    const cmdStart = m.index;

    // Skip if this command is on a commented-out line: scan back to the
    // start of the line and look for an unescaped `%` before the command.
    const lineStart = tex.lastIndexOf("\n", cmdStart) + 1;
    const prefix = tex.slice(lineStart, cmdStart);
    if (/(^|[^\\])%/.test(prefix)) continue;

    // Extract a brace-balanced title starting at the opening brace.
    const braceOpen = m.index + m[0].length - 1; // index of "{"
    let depth = 0;
    let i = braceOpen;
    let title = "";
    for (; i < tex.length; i++) {
      const ch = tex[i];
      if (ch === "{") {
        depth++;
        if (depth === 1) continue; // skip the outermost opening brace
      } else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      title += ch;
    }

    markers.push({
      title: title.trim(),
      level: cmd === "chapter" ? 1 : cmd === "section" ? 2 : 3,
      byteOffset: cmdStart,
      cmd,
    });
  }

  const hasChapters = markers.some((mk) => mk.cmd === "chapter");
  return markers.map((mk) => {
    let level: 1 | 2 | 3 = mk.level;
    if (!hasChapters) {
      // Promote: section → 1, subsection → 2 when no chapters present.
      if (mk.cmd === "section") level = 1;
      else if (mk.cmd === "subsection") level = 2;
    }
    return { title: mk.title, level, byteOffset: mk.byteOffset };
  });
}

/**
 * Load the best-available source for a paper.
 * Priority: arxiv tex → arxiv pdf → existing abstract.
 * Failure-isolated: never throws; falls back to {kind: "abstract-only", text: <abstract>}.
 */
export async function loadPaperSource(
  paper: PaperNode,
  deps: SourceLoaderDeps,
): Promise<LoadedSource> {
  const abstractFallback = (): LoadedSource => {
    const text = paper.abstract ?? "";
    return {
      paperId: paper.id,
      kind: "abstract-only",
      bytes: Buffer.byteLength(text, "utf-8"),
      text,
    };
  };

  // Non-arxiv papers: no PDF fetch path in mathran today.
  if (!paper.arxivId) {
    return abstractFallback();
  }

  const fetchArxivSource = deps.fetchArxivSource ?? realFetchArxivSource;
  const runPdfToText = deps.runPdfToText ?? defaultRunPdfToText;

  try {
    if (deps.rateDelayMs && deps.rateDelayMs > 0) {
      await new Promise((r) => setTimeout(r, deps.rateDelayMs));
    }

    const src = await fetchArxivSource(paper.arxivId, { workspace: deps.workspace });

    if (src.status === "ok" && src.mainTexFile) {
      const text = await fs.readFile(src.mainTexFile, "utf-8"); // full file, no truncation
      const sectionMarkers = extractSectionMarkers(text);
      return {
        paperId: paper.id,
        kind: "tex",
        bytes: Buffer.byteLength(text, "utf-8"),
        text,
        path: src.mainTexFile,
        sectionMarkers,
      };
    }

    // No .tex available — try the PDF path. arxiv source bundles don't
    // ship a compiled PDF, so look for one only when the bundle exposes
    // a figure/pdf path; otherwise fall through to abstract-only.
    const pdfPath = pickPdfPath(src);
    if (pdfPath) {
      let extracted: string | null = null;
      try {
        extracted = await runPdfToText(pdfPath);
      } catch {
        extracted = null;
      }
      if (extracted && extracted.trim().length > 0) {
        return {
          paperId: paper.id,
          kind: "pdf-text",
          bytes: Buffer.byteLength(extracted, "utf-8"),
          text: extracted,
          path: pdfPath,
        };
      }
    }
  } catch {
    // ignore — falling back to abstract-only is safe
  }

  return abstractFallback();
}

/** Best-guess a PDF path from an arxiv fetch result, if any. */
function pickPdfPath(
  src: Awaited<ReturnType<typeof realFetchArxivSource>>,
): string | undefined {
  if (src.status !== "ok") return undefined;
  const pdf = src.figureFiles.find((f) => f.toLowerCase().endsWith(".pdf"));
  return pdf;
}

/**
 * Pick a reading regime:
 *   A = whole-paper read (LLM sees full text in one call)        — bytes ≤ 30,000
 *   B = section-by-section (split, read each, merge)             — bytes > 30,000 with discernible sections
 *   C = OCR / pdf-text mode (formula extraction unreliable)      — kind in {"pdf-text", "abstract-only"}
 *
 * If kind === "abstract-only", returns A with the abstract as the entire content.
 */
export function pickReadingRegime(source: LoadedSource): ReadingRegime {
  if (source.kind === "pdf-text" || source.kind === "abstract-only") {
    return "C";
  }
  if (source.bytes <= REGIME_A_MAX_BYTES) {
    return "A";
  }
  const markerCount = source.sectionMarkers?.length ?? 0;
  if (markerCount >= 2) {
    return "B";
  }
  return "A";
}
