// IMPL [quick-win-1] read_pdf — extract text + metadata from a PDF (URL or workspace path).
//
// Limits: 5 MB download cap, 200 page cap, 30 s wall-clock.
// Backed by pdf-parse (already a project dependency). No new npm packages.

import type { ToolDefinition } from "./types";
import { promises as fs } from "node:fs";
import path from "node:path";
// TODO(mathran-v0.1): import { safeFetchBuffer } from "@/lib/safe-fetch";
import { z } from "zod";

// pdf-parse has no published @types; declare a minimal local typing.
interface PdfParseResult {
  numpages: number;
  numrender: number;
  info?: Record<string, unknown> & {
    Title?: string;
    Author?: string;
    Subject?: string;
    Keywords?: string;
    Producer?: string;
    Creator?: string;
    CreationDate?: string;
    ModDate?: string;
  };
  metadata?: unknown;
  text: string;
  version?: string;
}

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_PAGES = 200;
const FETCH_TIMEOUT_MS = 30_000;
const TEXT_PREVIEW_CAP = 200_000; // ~200K chars max returned to LLM
const ABSTRACT_LOOKAHEAD_CHARS = 4000;

const readPdfInputSchema = z.object({
  url: z.string().url().max(2_048).optional(),
  path: z.string().min(1).max(1_024).optional(),
  maxChars: z.number().int().min(1_000).max(TEXT_PREVIEW_CAP).optional(),
}).refine((value) => Boolean(value.url) !== Boolean(value.path), {
  message: "Provide exactly one of `url` or `path`.",
});

function extractAbstract(text: string): string | undefined {
  // Look for "Abstract" header followed by content up to "Introduction" / "1." / blank break.
  const window = text.slice(0, ABSTRACT_LOOKAHEAD_CHARS);
  const m = window.match(/\babstract\b[\s.:—-]*([\s\S]{40,2000}?)(?:\n\s*\n|\b(?:1\.\s*introduction|introduction|keywords|i\.\s*introduction)\b)/i);
  if (!m) return undefined;
  return m[1]!.replace(/\s+/g, " ").trim();
}

function extractReferencesCount(text: string): number | undefined {
  // Rough — count "[N]" reference markers in the last quarter of the doc.
  const tail = text.slice(Math.floor(text.length * 0.7));
  const matches = tail.match(/\[(\d{1,3})\]/g);
  if (!matches) return undefined;
  // Use max ref number as a proxy for total references.
  let max = 0;
  for (const m of matches) {
    const n = Number(m.replace(/[^\d]/g, ""));
    if (n > max && n < 1000) max = n;
  }
  return max > 0 ? max : undefined;
}

async function loadFromUrl(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("PDF URL must use https://");
  }

  // P1-8: stream remote PDFs through a byte/time-capped SSRF-safe fetch.
  const { response: res, buffer } = await safeFetchBuffer(url, {
    maxBytes: MAX_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { "User-Agent": "Mathub-PDF-Reader/1.0" },
  });
    if (!res.ok) {
      throw new Error(`Fetch failed: HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    // Accept application/pdf or octet-stream (arXiv often serves the latter).
    if (
      !ct.includes("pdf") &&
      !ct.includes("octet-stream") &&
      !ct.includes("application/x-pdf")
    ) {
      // Don't hard-fail — some servers lie. Just warn via thrown msg if header is text/html.
      if (ct.includes("text/html")) {
        throw new Error(`URL returned HTML, not a PDF (content-type: ${ct})`);
      }
    }
    return buffer;
}

async function loadFromPath(p: string): Promise<Buffer> {
  // Restrict to workspace paths; we don't expose arbitrary FS reads.
  // Allow:  /tmp/..., ./..., relative paths inside cwd.
  // Reject:  /etc/, /root/, /home/<other>/, /proc/, /sys/, /var/, ..
  const resolved = path.resolve(p);
  const cwd = process.cwd();
  const allowedRoots = [cwd, "/tmp"];
  const ok = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw new Error(
      `Path not allowed: ${resolved}. Only files under cwd (${cwd}) or /tmp are readable.`,
    );
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
  if (stat.size > MAX_BYTES) {
    throw new Error(`PDF exceeds ${MAX_BYTES} bytes (file size ${stat.size}).`);
  }
  return await fs.readFile(resolved);
}

export const readPdfTool: ToolDefinition = {
  name: "read_pdf",
  description:
    "Extract text and metadata from a PDF file. Accepts a URL (e.g. arXiv PDF link) or an absolute/relative path to a file in the workspace or /tmp. " +
    `Limits: max ${MAX_BYTES / 1024 / 1024} MB, ${MAX_PAGES} pages, ${FETCH_TIMEOUT_MS / 1000}s. ` +
    "Returns: { text, pageCount, title?, author?, abstract?, referencesCount?, sourceBytes }.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTP/HTTPS URL of a PDF (e.g. https://arxiv.org/pdf/2410.12345.pdf).",
      },
      path: {
        type: "string",
        description: "Local path to a PDF (under cwd or /tmp). Mutually exclusive with `url`.",
      },
      maxChars: {
        type: "number",
        description: `Cap returned text length (default ${TEXT_PREVIEW_CAP}, max ${TEXT_PREVIEW_CAP}).`,
      },
    },
  },
  inputSchema: readPdfInputSchema,
  // PDF parsing can be slow; bump timeout above the default 10s.
  timeoutMs: 45_000,
  async execute(args) {
    const url = typeof args.url === "string" ? args.url : undefined;
    const localPath = typeof args.path === "string" ? args.path : undefined;
    const maxChars = Math.min(
      Math.max(Number(args.maxChars) || TEXT_PREVIEW_CAP, 1_000),
      TEXT_PREVIEW_CAP,
    );

    if (!url && !localPath) {
      return { success: false, data: null, displayText: "Provide either `url` or `path`." };
    }
    if (url && localPath) {
      return { success: false, data: null, displayText: "Provide only one of `url` or `path`." };
    }

    let buf: Buffer;
    try {
      buf = url ? await loadFromUrl(url) : await loadFromPath(localPath!);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load PDF";
      return { success: false, data: null, displayText: msg };
    }

    let parsed: PdfParseResult;
    try {
      // Lazy require to avoid top-level side effects from pdf-parse's init.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse") as (
        data: Buffer,
        opts?: { max?: number },
      ) => Promise<PdfParseResult>;
      parsed = await pdfParse(buf, { max: MAX_PAGES });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "PDF parse failed";
      return { success: false, data: null, displayText: `Failed to parse PDF: ${msg}` };
    }

    if (parsed.numpages > MAX_PAGES) {
      return {
        success: false,
        data: null,
        displayText: `PDF has ${parsed.numpages} pages, exceeds ${MAX_PAGES}.`,
      };
    }

    const text = parsed.text ?? "";
    const truncated = text.length > maxChars;
    const previewText = truncated ? text.slice(0, maxChars) : text;

    const info = parsed.info ?? {};
    const title = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : undefined;
    const author = typeof info.Author === "string" && info.Author.trim() ? info.Author.trim() : undefined;
    const abstract = extractAbstract(text);
    const referencesCount = extractReferencesCount(text);

    return {
      success: true,
      data: {
        source: url ? { url } : { path: localPath },
        sourceBytes: buf.byteLength,
        pageCount: parsed.numpages,
        renderedPages: parsed.numrender,
        title,
        author,
        abstract,
        referencesCount,
        truncated,
        textLength: text.length,
        text: previewText,
      },
      displayText: `Extracted ${parsed.numpages} pages, ${text.length} chars${truncated ? ` (truncated to ${maxChars})` : ""}.`,
    };
  },
};
