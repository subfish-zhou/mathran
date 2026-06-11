/**
 * Full-text extraction for academic papers.
 *
 * Strategy (ordered by preference):
 *   1. arXiv HTML (lightweight, structured)
 *   2. PDF download + pdf-parse (heavier, universal fallback)
 *   3. User-uploaded PDF buffer (same pdf-parse path)
 *
 * All functions return plain text truncated to a configurable limit.
 */

// FIX [audit-2 M8] lazy-load pdf-parse to keep cold-start fast and avoid
// breaking edge runtimes that don't support `require`. We resolve the
// module on first use only.
type PdfParseFn = (buf: Buffer, opts?: { max?: number }) => Promise<{ text: string; numpages: number }>;
let pdfParseCache: PdfParseFn | null = null;
async function getPdfParse(): Promise<PdfParseFn> {
  if (pdfParseCache) return pdfParseCache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("pdf-parse") as PdfParseFn | { default: PdfParseFn };
  pdfParseCache = (typeof mod === "function" ? mod : mod.default);
  return pdfParseCache;
}

// ========== Configuration ==========

/** Max characters to extract from a paper's full text */
const MAX_CHARS = 40_000;

/** Max characters for survey papers (surveys are typically longer and more valuable) */
export const SURVEY_MAX_CHARS = 60_000;

/** Timeout for fetching remote resources */
const FETCH_TIMEOUT_MS = 60_000;

// ========== Public API ==========

export interface FullTextResult {
  text: string;
  source: "arxiv-html" | "arxiv-pdf" | "pdf-url" | "pdf-buffer";
  chars: number;
}

/**
 * Fetch full text for an arXiv paper. Tries HTML first, falls back to PDF.
 */
export async function fetchArxivFullText(
  arxivId: string,
  maxChars = MAX_CHARS
): Promise<FullTextResult | null> {
  // 1. Try arXiv HTML
  const html = await fetchArxivHtml(arxivId, maxChars);
  if (html) return html;

  // 2. Fall back to arXiv PDF
  const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
  return fetchPdfFromUrl(pdfUrl, maxChars, "arxiv-pdf");
}

/**
 * Extract text from a PDF at a given URL.
 */
export async function fetchPdfFromUrl(
  url: string,
  maxChars = MAX_CHARS,
  source: FullTextResult["source"] = "pdf-url"
): Promise<FullTextResult | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Mathub/1.0 (research-agent)" },
    });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    return extractTextFromPdfBuffer(buffer, maxChars, source);
  } catch {
    return null;
  }
}

/**
 * Extract text from an in-memory PDF buffer (e.g. user upload).
 */
export async function extractTextFromPdfBuffer(
  buffer: Buffer,
  maxChars = MAX_CHARS,
  source: FullTextResult["source"] = "pdf-buffer"
): Promise<FullTextResult | null> {
  try {
    const pdfParse = await getPdfParse();
    const data = await pdfParse(buffer, { max: 50 }); // max 50 pages
    const text = cleanText(data.text, maxChars);
    if (text.length < 100) return null; // too short, probably extraction failure
    return { text, source, chars: text.length };
  } catch {
    return null;
  }
}

// ========== Internal ==========

async function fetchArxivHtml(
  arxivId: string,
  maxChars: number
): Promise<FullTextResult | null> {
  try {
    const url = `https://arxiv.org/html/${arxivId}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Mathub/1.0 (research-agent)" },
    });
    if (!res.ok) return null;

    const html = await res.text();

    // Extract text from the article body, stripping HTML tags
    // arXiv HTML uses <article> or <div class="ltx_page_content">
    const bodyMatch =
      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
      html.match(/<div[^>]*class="ltx_page_content"[^>]*>([\s\S]*?)<\/div>\s*<\/body>/i);

    if (!bodyMatch) return null;

    const rawText = stripHtmlTags(bodyMatch[1]!);
    const text = cleanText(rawText, maxChars);
    if (text.length < 200) return null;

    return { text, source: "arxiv-html", chars: text.length };
  } catch {
    return null;
  }
}

function stripHtmlTags(html: string): string {
  let result = html;

  // Remove non-content elements
  result = result.replace(/<script[\s\S]*?<\/script>/gi, "");
  result = result.replace(/<style[\s\S]*?<\/style>/gi, "");
  result = result.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  result = result.replace(/<footer[\s\S]*?<\/footer>/gi, "");

  // Preserve LaTeX from MathJax/KaTeX math elements:
  // <math> tags with alttext attribute → extract alttext as LaTeX
  result = result.replace(/<math[^>]*alttext="([^"]*)"[^>]*>[\s\S]*?<\/math>/gi, (_match, alt) => {
    return ` $${decodeHtmlEntities(alt)}$ `;
  });
  // <math> tags without alttext → remove (can't recover LaTeX)
  result = result.replace(/<math[^>]*>[\s\S]*?<\/math>/gi, " [math] ");

  // arXiv HTML uses <span class="ltx_Math"> with alt containing LaTeX
  result = result.replace(/<span[^>]*class="[^"]*ltx_Math[^"]*"[^>]*alt="([^"]*)"[^>]*>[\s\S]*?<\/span>/gi, (_match, alt) => {
    return ` $${decodeHtmlEntities(alt)}$ `;
  });

  // Generic math spans with alt attribute (KaTeX, MathJax output)
  result = result.replace(/<span[^>]*class="[^"]*(?:katex|mathjax|MathJax)[^"]*"[^>]*alt="([^"]*)"[^>]*>[\s\S]*?<\/span>/gi, (_match, alt) => {
    return ` $${decodeHtmlEntities(alt)}$ `;
  });

  // MathJax script tags with type="math/tex"
  result = result.replace(/<script[^>]*type="math\/tex(?:\;[^"]*)?">([^<]*)<\/script>/gi, (_match, tex) => {
    return ` $${tex}$ `;
  });

  // Annotation tags with encoding="application/x-tex" (inside MathML)
  result = result.replace(/<annotation[^>]*encoding="application\/x-tex"[^>]*>([^<]*)<\/annotation>/gi, (_match, tex) => {
    return ` $${tex}$ `;
  });

  // Now strip remaining HTML tags
  result = result.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  result = result
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&\w+;/g, " ");

  return result;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)));
}

function cleanText(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.slice(0, maxChars);
}
