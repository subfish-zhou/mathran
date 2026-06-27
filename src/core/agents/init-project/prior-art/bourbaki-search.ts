/**
 * Task 15 — Bourbaki seminar discovery.
 *
 * Part of Prior-Art Discovery (DESIGN-REFERENCE Part 3). The Bourbaki seminar
 * publishes a public index of expository "exposés"; these are dense, expert
 * surveys of active research. We scrape the index (cached 24h), then keyword-
 * match each entry against the problem title + tags.
 *
 * Failure-isolated: returns `[]` if Bourbaki is unreachable or its HTML
 * structure has changed (the agent must still work without Bourbaki context).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "../../../chat/atomic-write.js";

export interface BourbakiHit {
  url: string; // direct PDF or HTML link to the seminar
  title: string;
  speaker: string;
  number?: string; // "Exposé 1234"
  year?: number;
  source: "bourbaki";
  matchConfidence: number; // 0-1, naive keyword match
  matchedKeywords: string[];
}

export interface BourbakiDeps {
  /** Inject for tests; default fetches https://www.bourbaki.fr/seminaires/ */
  fetchBourbakiIndex?: () => Promise<string>; // returns HTML
  /** Inject for tests; default caches under <cacheDir>/bourbaki-index.html (24h TTL). */
  cacheDir?: string;
  emitLog?: (message: string) => void;
}

export const BOURBAKI_INDEX_URL = "https://www.bourbaki.fr/seminaires/";
export const BOURBAKI_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface BourbakiEntry {
  url: string;
  title: string;
  speaker: string;
  number?: string;
  year?: number;
}

async function defaultFetchBourbakiIndex(): Promise<string> {
  const res = await fetch(BOURBAKI_INDEX_URL, { signal: AbortSignal.timeout(15_000) });
  return res.text();
}

/**
 * Fetch the Bourbaki index HTML, using a 24h on-disk cache when `cacheDir` is
 * provided. Exported for testing.
 */
export async function loadBourbakiHtml(deps: BourbakiDeps): Promise<string> {
  const fetchIndex = deps.fetchBourbakiIndex ?? defaultFetchBourbakiIndex;
  if (!deps.cacheDir) return fetchIndex();

  const cacheFile = path.join(deps.cacheDir, "bourbaki-index.html");
  try {
    const stat = await fs.stat(cacheFile);
    if (Date.now() - stat.mtimeMs < BOURBAKI_CACHE_TTL_MS) {
      return await fs.readFile(cacheFile, "utf8");
    }
  } catch {
    // cache miss → fall through to fetch
  }

  const html = await fetchIndex();
  try {
    await fs.mkdir(deps.cacheDir, { recursive: true });
    await atomicWriteFile(cacheFile, html);
  } catch (err) {
    (deps.emitLog ?? (() => {}))(`[bourbaki] cache write failed: ${String(err)}`);
  }
  return html;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Defensive regex parse of the Bourbaki index page into entries. The site is
 * static; we look for anchor tags whose surrounding text mentions an exposé.
 * Exported for testing. Returns `[]` if nothing parseable is found.
 */
export function parseBourbakiIndex(html: string, baseUrl = BOURBAKI_INDEX_URL): BourbakiEntry[] {
  const entries: BourbakiEntry[] = [];
  const anchorRe = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1]!;
    const inner = stripTags(m[2]!);
    if (!inner) continue;

    // an exposé entry typically reads "1234. Speaker — Title" or "Exposé 1234 ..."
    const numMatch = inner.match(/(?:Exp(?:os[ée])?\.?\s*)?(\d{2,4})\b/i);
    const speakerTitle = inner.replace(/^(?:Exp(?:os[ée])?\.?\s*)?\d{2,4}[.\s—-]*/i, "");
    const sep = speakerTitle.match(/^(.*?)\s*[—–-]\s*(.+)$/);
    let speaker = "";
    let title = speakerTitle;
    if (sep) {
      speaker = sep[1]!.trim();
      title = sep[2]!.trim();
    }
    if (!title) continue;

    let url = href;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      // keep raw href
    }
    const yearMatch = inner.match(/\b(19|20)\d{2}\b/);
    entries.push({
      url,
      title,
      speaker,
      number: numMatch ? `Exposé ${numMatch[1]}` : undefined,
      year: yearMatch ? parseInt(yearMatch[0], 10) : undefined,
    });
  }
  return entries;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "on", "in", "to", "and", "or", "for", "with", "is",
  "are", "by", "from", "as", "at", "conjecture", "theorem", "problem", "über",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9àâäéèêëïîôöùûüç]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Scrape the Bourbaki seminar index, cache it 24h, and match entries by
 * keywords from the problem title + tags. Returns hits sorted by
 * `matchConfidence` descending. Failure-isolated: returns `[]` on any error.
 */
export async function searchBourbakiSeminars(
  problem: { title: string; tags: string[] },
  deps: BourbakiDeps,
  options?: { maxHits?: number; minConfidence?: number },
): Promise<BourbakiHit[]> {
  const log = deps.emitLog ?? (() => {});
  const maxHits = options?.maxHits ?? 20;
  const minConfidence = options?.minConfidence ?? 0.0001;

  try {
    const html = await loadBourbakiHtml(deps);
    const entries = parseBourbakiIndex(html);
    if (entries.length === 0) {
      log("[bourbaki] no parseable entries (HTML structure may have changed)");
      return [];
    }

    const keywords = [...new Set([...tokenize(problem.title), ...problem.tags.flatMap(tokenize)])];
    if (keywords.length === 0) return [];

    const hits: BourbakiHit[] = [];
    for (const e of entries) {
      const titleTokens = new Set(tokenize(e.title));
      const matched = keywords.filter((k) => titleTokens.has(k));
      if (matched.length === 0) continue;
      const matchConfidence = Math.min(1, matched.length / keywords.length);
      if (matchConfidence < minConfidence) continue;
      hits.push({
        url: e.url,
        title: e.title,
        speaker: e.speaker,
        number: e.number,
        year: e.year,
        source: "bourbaki",
        matchConfidence,
        matchedKeywords: matched,
      });
    }

    hits.sort((a, b) => b.matchConfidence - a.matchConfidence);
    log(`[bourbaki] ${hits.length} matching exposés from ${entries.length} entries`);
    return hits.slice(0, maxHits);
  } catch (err) {
    log(`[bourbaki] failed: ${String(err)}`);
    return [];
  }
}
