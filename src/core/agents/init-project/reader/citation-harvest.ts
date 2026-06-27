/**
 * Citation harvest — extract a paper's outgoing citations from three signals,
 * deduplicated by arXiv id (or normalized title):
 *
 *   1. Direct arXiv ids in the raw source text (\arXiv{…}, arxiv.org/abs/…,
 *      loose "arXiv:…" mentions, and legacy archive ids like math.NT/0509123).
 *   2. \bibitem entries inside a \begin{thebibliography} block.
 *   3. The agent's distilled `PaperReadBody.technicalDependencies`.
 *
 * `importanceToThisPaper` is inferred from WHERE a citation showed up:
 *   - in technicalDependencies AND named in a mainResults proof  → "essential"
 *   - in technicalDependencies but only seen in the bibliography  → "supporting"
 *   - bibliography-only / no other mention                        → "passing"
 *
 * Pure — no LLM call. Failure-isolated: any per-signal error is swallowed.
 */

import type {
  PaperNode,
  PaperReadBody,
  PaperReadOutgoingCitation,
} from "../../../paper-graph/types.js";
import type { LoadedSource } from "./source-loader.js";

export interface HarvestDeps {
  emitLog?: (message: string) => void;
}

// ── arXiv id extraction ──────────────────────────────────────────────────────

// Modern ids: NNNN.NNNNN (4 digits, dot, 4-5 digits) with optional vN.
const MODERN_ID = "\\d{4}\\.\\d{4,5}(?:v\\d+)?";
// Legacy ids: archive[.subclass]/NNNNNNN  (7 digits), e.g. math.NT/0509123.
const LEGACY_ID = "[a-z][a-z\\-]+(?:\\.[A-Z]{2})?/\\d{7}";

const ARXIV_PATTERNS: RegExp[] = [
  // arXiv:NNNN.NNNNN  /  arXiv: NNNN.NNNNN
  new RegExp(`arxiv:\\s*(${MODERN_ID})`, "gi"),
  // arxiv.org/abs/NNNN.NNNNN and arxiv.org/pdf/NNNN.NNNNN
  new RegExp(`arxiv\\.org/(?:abs|pdf|e-print)/(${MODERN_ID})`, "gi"),
  // \arXiv{NNNN.NNNNN}
  new RegExp(`\\\\arxiv\\s*\\{\\s*(${MODERN_ID})\\s*\\}`, "gi"),
  // Legacy: arXiv:math.NT/0509123  or bare math.NT/0509123
  new RegExp(`(?:arxiv:\\s*)?(${LEGACY_ID})`, "gi"),
];

/** Strip a trailing version suffix (`v3`) from an arXiv id. */
function normalizeArxivId(id: string): string {
  return id.replace(/^arxiv:/i, "").replace(/v\d+$/i, "").trim();
}

export function extractArxivIdsFromText(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of ARXIV_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const id = normalizeArxivId(m[1]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ── bibitem extraction ───────────────────────────────────────────────────────

export interface BibEntry {
  author?: string;
  title?: string;
  year?: number;
  arxivId?: string;
  /** Raw entry text (used for context snippets). */
  raw: string;
}

const BIBITEM_RE = /\\bibitem(?:\[[^\]]*\])?\{[^}]*\}\s*([\s\S]*?)(?=\\bibitem|\\end\{thebibliography\}|$)/g;

function stripTexNoise(s: string): string {
  return s
    .replace(/\\newblock/g, " ")
    .replace(/~/g, " ")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Heuristic title extraction: prefer quoted / italicised / emphasised text. */
function extractTitle(raw: string): string | undefined {
  const candidates: Array<RegExp> = [
    /``([^']{4,}?)''/, // TeX double quotes ``...''
    /\\(?:textit|emph|textsl)\{([^}]{4,}?)\}/, // italic / emphasised
    /"([^"]{4,}?)"/, // straight quotes
    /[“”]([^“”]{4,}?)[“”]/, // smart quotes
  ];
  for (const re of candidates) {
    const m = raw.match(re);
    if (m?.[1]) {
      const t = stripTexNoise(m[1]);
      if (t) return t;
    }
  }
  return undefined;
}

function extractYear(raw: string): number | undefined {
  const m = raw.match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/);
  if (!m) return undefined;
  const y = Number(m[1]);
  return y >= 1900 && y <= 2099 ? y : undefined;
}

/** Heuristic author extraction: the chunk before the first period/quote/year. */
function extractAuthor(raw: string): string | undefined {
  const cleaned = stripTexNoise(raw);
  if (!cleaned) return undefined;
  const cut = cleaned.search(/,|``|"|[“”]|(?:19|20)\d{2}/);
  const head = (cut > 0 ? cleaned.slice(0, cut) : cleaned).trim();
  if (!head || head.length > 80) return undefined;
  return head;
}

export function extractBibitemEntries(tex: string): BibEntry[] {
  if (!tex) return [];
  const entries: BibEntry[] = [];
  BIBITEM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BIBITEM_RE.exec(tex)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    const arxivIds = extractArxivIdsFromText(raw);
    entries.push({
      author: extractAuthor(raw),
      title: extractTitle(raw),
      year: extractYear(raw),
      arxivId: arxivIds[0],
      raw,
    });
  }
  return entries;
}

// ── harvest orchestration ────────────────────────────────────────────────────

type Importance = PaperReadOutgoingCitation["importanceToThisPaper"];

function normalizeTitle(title?: string): string {
  return (title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function rawSourceText(source: LoadedSource | undefined): string {
  if (!source) return "";
  const s = source as unknown as Record<string, unknown>;
  for (const k of ["text", "content", "tex", "raw", "body", "sourceText"]) {
    const v = s[k];
    if (typeof v === "string" && v.length) return v;
  }
  return "";
}

function snippet(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max).trim()}…`;
}

interface Acc {
  citation: PaperReadOutgoingCitation;
  inDeps: boolean;
  inProof: boolean;
  inBib: boolean;
}

function keyFor(arxivId?: string, title?: string): string | null {
  if (arxivId) return `arxiv:${arxivId}`;
  const t = normalizeTitle(title);
  return t ? `title:${t}` : null;
}

function inferImportance(a: Acc): Importance {
  if (a.inDeps && a.inProof) return "essential";
  if (a.inDeps) return "supporting";
  return "passing";
}

export function harvestCitations(
  paper: PaperNode,
  source: LoadedSource,
  read: PaperReadBody,
  deps: HarvestDeps,
): PaperReadOutgoingCitation[] {
  const { emitLog } = deps;
  const byKey = new Map<string, Acc>();

  const upsert = (
    fields: Partial<PaperReadOutgoingCitation> & { arxivId?: string },
    context: string,
    mark: Partial<Pick<Acc, "inDeps" | "inProof" | "inBib">>,
  ): void => {
    const arxivId = fields.arxivId ?? fields.citedArxivId;
    const key = keyFor(arxivId, fields.citedTitle);
    if (!key) return;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        citation: {
          citedTitle: fields.citedTitle,
          citedAuthors: fields.citedAuthors,
          citedYear: fields.citedYear,
          citedArxivId: arxivId,
          citedDoi: fields.citedDoi,
          contextInThisPaper: context,
          importanceToThisPaper: "passing",
        },
        inDeps: false,
        inProof: false,
        inBib: false,
      };
      byKey.set(key, acc);
    } else {
      // Enrich missing fields from later signals.
      const c = acc.citation;
      if (!c.citedArxivId && arxivId) c.citedArxivId = arxivId;
      if (!c.citedTitle && fields.citedTitle) c.citedTitle = fields.citedTitle;
      if (!c.citedAuthors && fields.citedAuthors) c.citedAuthors = fields.citedAuthors;
      if (!c.citedYear && fields.citedYear) c.citedYear = fields.citedYear;
      if (!c.citedDoi && fields.citedDoi) c.citedDoi = fields.citedDoi;
      if (!c.contextInThisPaper && context) c.contextInThisPaper = context;
    }
    if (mark.inDeps) acc.inDeps = true;
    if (mark.inProof) acc.inProof = true;
    if (mark.inBib) acc.inBib = true;
  };

  const text = rawSourceText(source);

  // Signal 2: bibliography entries (richest metadata) — process first so later
  // signals enrich rather than overwrite.
  try {
    for (const e of extractBibitemEntries(text)) {
      if (!e.arxivId && !e.title) continue;
      upsert(
        {
          arxivId: e.arxivId,
          citedTitle: e.title,
          citedAuthors: e.author ? [e.author] : undefined,
          citedYear: e.year,
        },
        snippet(e.raw),
        { inBib: true },
      );
    }
  } catch (err) {
    emitLog?.(`[harvest] bibitem parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Signal 1: loose arXiv ids in the body (not necessarily in the bib block).
  try {
    for (const id of extractArxivIdsFromText(text)) {
      upsert({ arxivId: id }, `arXiv:${id} referenced in source`, { inBib: true });
    }
  } catch (err) {
    emitLog?.(`[harvest] arxiv-id scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Signal 3: the agent's distilled technical dependencies.
  const proofText = normalizeTitle(
    [read.proofStrategy, ...read.mainResults.map((r) => `${r.statement} ${r.noveltyVsPrior}`)].join(" "),
  );
  try {
    for (const d of read.technicalDependencies) {
      const arxivIds = extractArxivIdsFromText(`${d.source} ${d.claim}`);
      const title = d.claim;
      const normSource = normalizeTitle(d.source);
      const inProof =
        (normSource.length > 0 && proofText.includes(normSource)) ||
        proofText.includes(normalizeTitle(title).slice(0, 40));
      upsert(
        {
          arxivId: arxivIds[0],
          citedTitle: title,
          citedDoi: /^10\.\d{4,}/.test(d.source.trim()) ? d.source.trim() : undefined,
        },
        snippet(d.whereUsed || d.claim),
        { inDeps: true, inProof },
      );
    }
  } catch (err) {
    emitLog?.(
      `[harvest] dependency scan failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Don't cite ourselves.
  const selfKeys = new Set<string>();
  if (paper.arxivId) selfKeys.add(`arxiv:${normalizeArxivId(paper.arxivId)}`);
  const selfTitleKey = keyFor(undefined, paper.title);
  if (selfTitleKey) selfKeys.add(selfTitleKey);

  const out: PaperReadOutgoingCitation[] = [];
  for (const [key, acc] of byKey) {
    if (selfKeys.has(key)) continue;
    acc.citation.importanceToThisPaper = inferImportance(acc);
    out.push(acc.citation);
  }

  emitLog?.(`[harvest] ${out.length} outgoing citation(s) for "${paper.title}"`);
  return out;
}
