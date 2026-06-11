import { describe, it, expect, vi } from "vitest";
import { parseReferenceFile } from "./reference-file-parser";

// Mock PDF extraction
vi.mock("./full-text", () => ({
  extractTextFromPdfBuffer: vi.fn(async () => "First Line Title\nSecond line content\nMore content here"),
}));

describe("parseReferenceFile", () => {
  describe("TeX files", () => {
    it("extracts title from \\title{}", async () => {
      const tex = `\\documentclass{article}\n\\title{On the Kakeya Conjecture}\n\\begin{document}`;
      const result = await parseReferenceFile(Buffer.from(tex), "paper.tex");
      expect(result.format).toBe("tex");
      expect(result.title).toBe("On the Kakeya Conjecture");
    });

    it("extracts authors from \\author{}", async () => {
      const tex = `\\title{T}\\author{Alice \\and Bob \\and Charlie}`;
      const result = await parseReferenceFile(Buffer.from(tex), "paper.tex");
      expect(result.authors).toEqual(["Alice", "Bob", "Charlie"]);
    });

    it("extracts abstract", async () => {
      const tex = `\\begin{abstract}This is the abstract.\\end{abstract}`;
      const result = await parseReferenceFile(Buffer.from(tex), "paper.tex");
      expect(result.abstract).toBe("This is the abstract.");
    });

    it("handles missing title", async () => {
      const tex = `\\begin{document}No title here\\end{document}`;
      const result = await parseReferenceFile(Buffer.from(tex), "paper.tex");
      expect(result.title).toBeUndefined();
    });

    it("handles .latex extension", async () => {
      const tex = `\\title{Test}`;
      const result = await parseReferenceFile(Buffer.from(tex), "paper.latex");
      expect(result.format).toBe("tex");
    });
  });

  describe("Markdown files", () => {
    it("extracts title from H1", async () => {
      const md = `# My Paper Title\n\nContent here`;
      const result = await parseReferenceFile(Buffer.from(md), "notes.md");
      expect(result.format).toBe("markdown");
      expect(result.title).toBe("My Paper Title");
    });

    it("handles no H1", async () => {
      const md = `Just some text without headers`;
      const result = await parseReferenceFile(Buffer.from(md), "notes.md");
      expect(result.title).toBeUndefined();
    });

    it("handles .markdown extension", async () => {
      const md = `# Title`;
      const result = await parseReferenceFile(Buffer.from(md), "file.markdown");
      expect(result.format).toBe("markdown");
    });
  });

  describe("PDF files", () => {
    it("extracts text and title from first line", async () => {
      const result = await parseReferenceFile(Buffer.from("fake pdf"), "paper.pdf");
      expect(result.format).toBe("pdf");
      expect(result.title).toBe("First Line Title");
    });
  });

  describe("Unknown format", () => {
    it("returns plain text for unknown extensions", async () => {
      const result = await parseReferenceFile(Buffer.from("plain text content"), "file.txt");
      expect(result.format).toBe("unknown");
      expect(result.text).toBe("plain text content");
    });
  });
});
