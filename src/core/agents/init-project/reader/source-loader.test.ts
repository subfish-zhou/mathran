import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { PaperNode } from "../../../paper-graph/types.js";
import {
  extractSectionMarkers,
  loadPaperSource,
  pickReadingRegime,
  type LoadedSource,
  type SourceLoaderDeps,
} from "./source-loader.js";

function makePaper(overrides: Partial<PaperNode> = {}): PaperNode {
  return {
    id: "paper-1",
    title: "A Paper",
    authors: ["A. Author"],
    year: 2024,
    abstract: "We prove a thing about things.",
    isSurvey: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type FetchFn = NonNullable<SourceLoaderDeps["fetchArxivSource"]>;

describe("loadPaperSource", () => {
  it('returns kind:"tex" with sectionMarkers when arxiv source available', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "srcload-"));
    const texPath = path.join(dir, "main.tex");
    const texContent =
      "\\documentclass{article}\n\\begin{document}\n" +
      "\\section{Foo}\nFoo body here.\n" +
      "\\section{Bar}\nBar body here.\n" +
      "\\end{document}\n";
    await fs.writeFile(texPath, texContent, "utf-8");

    const fetchArxivSource: FetchFn = async () =>
      ({
        status: "ok",
        arxivId: "2401.00001",
        rootDir: dir,
        mainTexFile: texPath,
        texFiles: [texPath],
        bibFiles: [],
        figureFiles: [],
        fromCache: true,
        byteSize: texContent.length,
        fetchedAt: "2026-01-01T00:00:00.000Z",
      }) as Awaited<ReturnType<FetchFn>>;

    const paper = makePaper({ arxivId: "2401.00001" });
    const src = await loadPaperSource(paper, { workspace: dir, fetchArxivSource });

    expect(src.kind).toBe("tex");
    expect(src.bytes).toBe(Buffer.byteLength(texContent, "utf-8"));
    expect(src.path).toBe(texPath);
    expect(src.sectionMarkers && src.sectionMarkers.length).toBeGreaterThanOrEqual(2);
    expect(src.sectionMarkers!.map((m) => m.title)).toEqual(["Foo", "Bar"]);
  });

  it("falls back to abstract-only when no arxivId", async () => {
    const paper = makePaper({ arxivId: undefined, abstract: "The abstract text." });
    const src = await loadPaperSource(paper, { workspace: "/tmp" });
    expect(src.kind).toBe("abstract-only");
    expect(src.text).toBe("The abstract text.");
    expect(src.bytes).toBe(Buffer.byteLength("The abstract text.", "utf-8"));
  });

  it("falls back to abstract-only when pdftotext unavailable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "srcload-"));
    const pdfPath = path.join(dir, "paper.pdf");
    await fs.writeFile(pdfPath, "%PDF-1.4 fake", "utf-8");

    const fetchArxivSource: FetchFn = async () =>
      ({
        status: "ok",
        arxivId: "2401.00002",
        rootDir: dir,
        mainTexFile: null,
        texFiles: [],
        bibFiles: [],
        figureFiles: [pdfPath],
        fromCache: true,
        byteSize: 13,
        fetchedAt: "2026-01-01T00:00:00.000Z",
      }) as Awaited<ReturnType<FetchFn>>;

    const paper = makePaper({ arxivId: "2401.00002", abstract: "Fallback abstract." });

    // runPdfToText throws → abstract-only fallback.
    const src = await loadPaperSource(paper, {
      workspace: dir,
      fetchArxivSource,
      runPdfToText: async () => {
        throw new Error("ENOENT: pdftotext not found");
      },
    });
    expect(src.kind).toBe("abstract-only");
    expect(src.text).toBe("Fallback abstract.");

    // runPdfToText returns null → abstract-only fallback.
    const src2 = await loadPaperSource(paper, {
      workspace: dir,
      fetchArxivSource,
      runPdfToText: async () => null,
    });
    expect(src2.kind).toBe("abstract-only");
    expect(src2.text).toBe("Fallback abstract.");
  });

  it('returns kind:"pdf-text" when pdftotext yields text', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "srcload-"));
    const pdfPath = path.join(dir, "paper.pdf");
    await fs.writeFile(pdfPath, "%PDF-1.4 fake", "utf-8");

    const fetchArxivSource: FetchFn = async () =>
      ({
        status: "ok",
        arxivId: "2401.00003",
        rootDir: dir,
        mainTexFile: null,
        texFiles: [],
        bibFiles: [],
        figureFiles: [pdfPath],
        fromCache: true,
        byteSize: 13,
        fetchedAt: "2026-01-01T00:00:00.000Z",
      }) as Awaited<ReturnType<FetchFn>>;

    const paper = makePaper({ arxivId: "2401.00003" });
    const src = await loadPaperSource(paper, {
      workspace: dir,
      fetchArxivSource,
      runPdfToText: async () => "Extracted PDF body text.",
    });
    expect(src.kind).toBe("pdf-text");
    expect(src.text).toBe("Extracted PDF body text.");
    expect(src.path).toBe(pdfPath);
  });

  it("never throws on fetch failure; falls back to abstract-only", async () => {
    const paper = makePaper({ arxivId: "2401.00004", abstract: "Safe abstract." });
    const src = await loadPaperSource(paper, {
      workspace: "/tmp",
      fetchArxivSource: async () => {
        throw new Error("network exploded");
      },
    });
    expect(src.kind).toBe("abstract-only");
    expect(src.text).toBe("Safe abstract.");
  });
});

describe("pickReadingRegime", () => {
  const base = (o: Partial<LoadedSource>): LoadedSource => ({
    paperId: "p",
    kind: "tex",
    bytes: 100,
    text: "x",
    ...o,
  });

  it("returns A for small tex (≤30K)", () => {
    expect(pickReadingRegime(base({ kind: "tex", bytes: 10_000 }))).toBe("A");
    expect(pickReadingRegime(base({ kind: "tex", bytes: 30_000 }))).toBe("A");
  });

  it("returns B for large tex with ≥2 sections", () => {
    expect(
      pickReadingRegime(
        base({
          kind: "tex",
          bytes: 50_000,
          sectionMarkers: [
            { title: "A", level: 1, byteOffset: 0 },
            { title: "B", level: 1, byteOffset: 100 },
          ],
        }),
      ),
    ).toBe("B");
  });

  it("falls back to A for large monolithic tex with <2 sections", () => {
    expect(pickReadingRegime(base({ kind: "tex", bytes: 50_000 }))).toBe("A");
    expect(
      pickReadingRegime(
        base({ kind: "tex", bytes: 50_000, sectionMarkers: [{ title: "A", level: 1, byteOffset: 0 }] }),
      ),
    ).toBe("A");
  });

  it("returns C for pdf-text and abstract-only", () => {
    expect(pickReadingRegime(base({ kind: "pdf-text", bytes: 10_000 }))).toBe("C");
    expect(pickReadingRegime(base({ kind: "abstract-only", bytes: 100 }))).toBe("C");
  });
});

describe("extractSectionMarkers", () => {
  it("skips commented sections", () => {
    const tex = "% \\section{Skipped}\n\\section{Real}\nbody\n";
    const markers = extractSectionMarkers(tex);
    expect(markers.map((m) => m.title)).toEqual(["Real"]);
  });

  it("handles chapters, sections, subsections with levels", () => {
    const tex =
      "\\chapter{Ch}\n\\section{Sec}\n\\subsection{Sub}\n\\section*{Starred}\n";
    const markers = extractSectionMarkers(tex);
    expect(markers).toEqual([
      { title: "Ch", level: 1, byteOffset: tex.indexOf("\\chapter") },
      { title: "Sec", level: 2, byteOffset: tex.indexOf("\\section{Sec}") },
      { title: "Sub", level: 3, byteOffset: tex.indexOf("\\subsection") },
      { title: "Starred", level: 2, byteOffset: tex.indexOf("\\section*") },
    ]);
  });

  it("promotes section to level 1 when no chapters present", () => {
    const tex = "\\section{Top}\n\\subsection{Under}\n";
    const markers = extractSectionMarkers(tex);
    expect(markers).toEqual([
      { title: "Top", level: 1, byteOffset: 0 },
      { title: "Under", level: 2, byteOffset: tex.indexOf("\\subsection") },
    ]);
  });

  it("balances nested braces in titles", () => {
    const tex = "\\section{The $\\mathcal{H}$ space}\nbody\n";
    const markers = extractSectionMarkers(tex);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.title).toBe("The $\\mathcal{H}$ space");
  });
});
