/**
 * Reference file parsing — Extract metadata from uploaded reference files
 *
 * Supports: PDF, TeX/LaTeX, Markdown
 */

import { extractTextFromPdfBuffer } from "./full-text";

export interface ParsedFileResult {
  title?: string;
  authors?: string[];
  abstract?: string;
  text: string;
  format: "pdf" | "tex" | "markdown" | "unknown";
}

/**
 * Parse a reference file and extract metadata + text content.
 */
export async function parseReferenceFile(
  buffer: Buffer,
  filename: string
): Promise<ParsedFileResult> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  if (ext === "pdf") {
    return parsePdf(buffer);
  }
  if (ext === "tex" || ext === "latex") {
    return parseTex(buffer.toString("utf-8"));
  }
  if (ext === "md" || ext === "markdown") {
    return parseMarkdown(buffer.toString("utf-8"));
  }

  // Attempt as plain text
  const text = buffer.toString("utf-8");
  return { text, format: "unknown" };
}

async function parsePdf(buffer: Buffer): Promise<ParsedFileResult> {
  const result = await extractTextFromPdfBuffer(buffer);
  if (!result) {
    return { text: "", format: "pdf" };
  }
  const text = typeof result === "string" ? result : result.text;

  // Attempt to extract title from first non-empty line
  const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
  const title = lines[0]?.trim();

  return {
    title: title && title.length < 300 ? title : undefined,
    text,
    format: "pdf",
  };
}

function parseTex(content: string): ParsedFileResult {
  // Extract \title{...}
  const titleMatch = content.match(/\\title\s*(?:\[.*?\])?\s*\{([\s\S]*?)\}/);
  const title = titleMatch
    ? titleMatch[1]!.replace(/\s+/g, " ").replace(/\\[a-zA-Z]+/g, "").trim()
    : undefined;

  // Extract \author{...}
  const authorMatch = content.match(/\\author\s*\{([\s\S]*?)\}/);
  const authors = authorMatch
    ? authorMatch[1]!
        .replace(/\\and/g, ",")
        .replace(/\\[a-zA-Z]+\{[^}]*\}/g, "")
        .replace(/\\[a-zA-Z]+/g, "")
        .split(/[,&]/)
        .map((a) => a.replace(/\s+/g, " ").trim())
        .filter((a) => a.length > 0)
    : undefined;

  // Extract \begin{abstract}...\end{abstract}
  const abstractMatch = content.match(
    /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/
  );
  const abstract = abstractMatch
    ? abstractMatch[1]!.replace(/\s+/g, " ").trim()
    : undefined;

  return {
    title,
    authors,
    abstract,
    text: content,
    format: "tex",
  };
}

function parseMarkdown(content: string): ParsedFileResult {
  // Title from first H1
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : undefined;

  return {
    title,
    text: content,
    format: "markdown",
  };
}
