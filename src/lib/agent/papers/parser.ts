/**
 * Paper parser — uses LLM to extract structured knowledge from papers.
 * For arXiv papers, attempts to download TeX source for richer extraction.
 */

import { callAzureLLM, extractJSON } from "@/lib/agent/azure-llm";
import { PAPER_ANALYSIS_PROMPT } from "./prompts";
import { FETCH_TIMEOUT_MS } from "../constants";

export interface PaperAnalysis {
  theorems: Array<{ name: string; statement: string; significance: string }>;
  methods: Array<{ name: string; description: string; category: string }>;
  domains: string[];
  summary: string;
  key_concepts: Array<{ name: string; description: string; category: string }>;
  difficulty_level: string;
  collaborator_contributions: Array<{ author: string; likely_role: string }>;
}

/**
 * Attempt to download TeX source for an arXiv paper.
 *
 * FIX [audit-2 M5] arXiv `/e-print/` returns gzipped tar archives
 * (`application/x-eprint-tar` or `application/x-eprint`) for the vast
 * majority of papers — the previous "text/tex" content-type branch was
 * effectively dead. We don't ship a tar/gzip dependency for this hot path,
 * so we now log clearly when we skip non-text payloads and return null.
 */
async function fetchArxivTexSource(arxivId: string): Promise<string | null> {
  try {
    const cleanId = arxivId.replace(/^arxiv:/i, "").replace(/v\d+$/, "");
    const url = `https://export.arxiv.org/e-print/${encodeURIComponent(cleanId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    // FIX [audit-2 M5] only the rare "text/plain" arXiv submission yields
    // anything useful here directly.
    // IMPL [unimpl-PAPER-PARSER] Fall back to the arXiv abstract PDF for the
    // common case where /e-print returns a .tar.gz / .pdf. We extract the
    // first ~30 KB of plain text via pdf-parse so the LLM sees abstract +
    // intro + first proofs rather than nothing.
    if (contentType.includes("text") || contentType.includes("tex")) {
      const text = await res.text();
      return text.length > 30_000 ? text.slice(0, 30_000) : text;
    }

    // Try the abstract PDF
    try {
      const pdfUrl = `https://arxiv.org/pdf/${encodeURIComponent(cleanId)}.pdf`;
      const pdfRes = await fetch(pdfUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!pdfRes.ok) return null;
      const buf = Buffer.from(await pdfRes.arrayBuffer());
      // dynamic import keeps pdf-parse out of the edge bundle
      // @ts-expect-error pdf-parse ships no types; treat as any.
      const pdfParseMod = await import("pdf-parse");
      const pdfParse = pdfParseMod.default ?? pdfParseMod;
      const parsed = (await pdfParse(buf)) as { text?: string };
      const text = parsed.text ?? "";
      return text.length > 30_000 ? text.slice(0, 30_000) : text;
    } catch (e) {
      console.warn("[paper-parser] PDF fallback failed:", e instanceof Error ? e.message : e);
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Parse a single paper using the LLM to extract structured analysis.
 */
export async function parsePaper(opts: {
  title: string;
  abstract: string | null;
  authors: string[];
  source: string;
  externalId: string;
}): Promise<PaperAnalysis> {
  // Try to get TeX source for arXiv papers
  let texSource: string | null = null;
  if (opts.source === "arxiv") {
    texSource = await fetchArxivTexSource(opts.externalId);
  }

  const paperContent = [
    `Title: ${opts.title}`,
    `Authors: ${opts.authors.join(", ")}`,
    opts.abstract ? `Abstract: ${opts.abstract}` : null,
    texSource ? `\nTeX Source (truncated):\n${texSource}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callAzureLLM(paperContent, {
    systemPrompt: PAPER_ANALYSIS_PROMPT,
    maxTokens: 4096,
  });

  const jsonStr = extractJSON(raw);
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      theorems: [],
      methods: [],
      domains: [],
      summary: opts.abstract ?? "",
      key_concepts: [],
      difficulty_level: "advanced",
      collaborator_contributions: [],
    };
  }

  return {
    theorems: Array.isArray(parsed.theorems) ? parsed.theorems : [],
    methods: Array.isArray(parsed.methods) ? parsed.methods : [],
    domains: Array.isArray(parsed.domains) ? parsed.domains : [],
    summary: typeof parsed.summary === "string" ? parsed.summary : (opts.abstract ?? ""),
    key_concepts: Array.isArray(parsed.key_concepts) ? parsed.key_concepts : [],
    difficulty_level: typeof parsed.difficulty_level === "string" ? parsed.difficulty_level : "advanced",
    collaborator_contributions: Array.isArray(parsed.collaborator_contributions) ? parsed.collaborator_contributions : [],
  };
}
