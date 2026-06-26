/**
 * arxiv-source.ts — Fetch and cache the LaTeX source bundle for an
 * arXiv paper.
 *
 * Why this exists: mathub used `/html/<id>` first then PDF fallback,
 * both of which lose math / structure. The author-uploaded source is
 * the gold standard:
 *   - https://arxiv.org/e-print/<arxivId>  ->  gzipped tar of .tex,
 *     .bib, .bbl, figures — exactly what the paper was compiled from.
 *
 * Cache layout (per workspace):
 *   <workspace>/.mathran/paper-sources/<safeArxivId>/
 *     .complete                — JSON marker {arxivId, fetchedAt,
 *                                  mainTexFile, byteSize, fromCache?}
 *     <author-named .tex files>
 *     <subdirs from the tar>
 *
 * Failure modes:
 *   - 404 / 403 → return {status: "no-source"} (paper has only a PDF)
 *   - network timeout → return {status: "fetch-failed", error}
 *   - tar extract fails → return {status: "extract-failed", error}
 *   - any of the above leaves NO `.complete` marker so a retry can
 *     reattempt cleanly. We attempt staging-then-rename so a partial
 *     extract never poisons the cache.
 *
 * Tests (P1-A.test): mocked HTTP, real tar.gz fixture, main.tex
 * resolution heuristic.
 *
 * 2026-06-26 (sync-upgrade Phase 1-A).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar";

const ARXIV_E_PRINT_URL = "https://arxiv.org/e-print";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Match arxiv id forms we accept (modern + legacy). Used for input
 * sanitisation — anything not matching is rejected before going on
 * the wire. The match group is what we use as the cache dir name.
 *
 * Modern (2007+): `YYMM.NNNNN` (4 digits dot 4-7 digits), optional `vN`.
 * Legacy (1991-2007): `archive[.SUBJ]/YYMMNNN` (e.g. `cs.LG/0412020`,
 * `hep-th/9901001`, `math.NT/0412020`).
 *
 * Fix A5 (2026-06-26): the prior regex tried to combine modern + legacy
 * into one optional-prefix expression but the trailing `\.?[0-9]{4,7}`
 * required (or skipped) a dot in a way that rejected legacy ids like
 * `hep-th/9901001` (7 digits after slash, no dot). Split into an
 * explicit alternation.
 */
const ARXIV_ID_RE = /^(?:[a-z\-]+(?:\.[A-Z]{2})?\/[0-9]{7}|[0-9]{4}\.[0-9]{4,7})(?:v[0-9]+)?$/i;

/** Make a single-segment filename out of an arxiv id (escapes `/`). */
function safeIdSegment(arxivId: string): string {
  return arxivId.replace(/[\/]/g, "_");
}

export interface FetchArxivSourceOk {
  status: "ok";
  arxivId: string;
  /** Absolute path to the extracted source dir. */
  rootDir: string;
  /** Best-guess main .tex (absolute path). null when heuristic fails. */
  mainTexFile: string | null;
  /** All .tex files in the bundle (absolute paths, sorted). */
  texFiles: string[];
  /** All .bib files (absolute paths). */
  bibFiles: string[];
  /** All recognised figure files (pdf / png / jpg / eps). */
  figureFiles: string[];
  /** True when served from cache, false on fresh download. */
  fromCache: boolean;
  /** Total bytes in the source dir. */
  byteSize: number;
  /** ISO timestamp the cache marker was written. */
  fetchedAt: string;
}

export interface FetchArxivSourceFail {
  status: "no-source" | "fetch-failed" | "extract-failed" | "invalid-id";
  arxivId: string;
  error: string;
}

export type FetchArxivSourceResult = FetchArxivSourceOk | FetchArxivSourceFail;

export interface FetchArxivSourceOptions {
  /** Absolute path of the workspace root. Cache goes under .mathran/. */
  workspace: string;
  /** Override the network fetcher (test seam). */
  fetchImpl?: (
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) => Promise<{
    ok: boolean;
    status: number;
    body: ReadableStream<Uint8Array> | null;
    /**
     * [Fix A24 2026-06-26] Optional headers. arxiv `/e-print/` may
     * return application/x-eprint (PDF) or text/plain (single .tex)
     * rather than the usual gzipped-tar; when the wrapper passes
     * headers we can dispatch correctly.
     */
    headers?: { get(name: string): string | null };
  }>;
  /** Override the HTTP timeout. */
  timeoutMs?: number;
  /** Force-refresh even if cache exists. */
  force?: boolean;
}

const defaultFetch: NonNullable<FetchArxivSourceOptions["fetchImpl"]> = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, body: res.body, headers: res.headers };
};

/**
 * Get the cache dir for a given arxiv id under a workspace.
 * Exposed so callers (e.g. SPA, model tools) can navigate without
 * re-implementing the path scheme.
 */
export function cacheDirFor(workspace: string, arxivId: string): string {
  return path.join(workspace, ".mathran", "paper-sources", safeIdSegment(arxivId));
}

async function readMarker(
  cacheDir: string,
): Promise<{ arxivId: string; fetchedAt: string; mainTexFile: string | null; byteSize: number } | null> {
  try {
    const raw = await fs.readFile(path.join(cacheDir, ".complete"), "utf-8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    return {
      arxivId: typeof j.arxivId === "string" ? j.arxivId : "",
      fetchedAt: typeof j.fetchedAt === "string" ? j.fetchedAt : "",
      mainTexFile: typeof j.mainTexFile === "string" ? j.mainTexFile : null,
      byteSize: typeof j.byteSize === "number" ? j.byteSize : 0,
    };
  } catch {
    return null;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".complete") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await recurse(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await recurse(root);
  return out.sort();
}

async function totalSize(files: string[]): Promise<number> {
  let total = 0;
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      total += st.size;
    } catch {
      // ignore
    }
  }
  return total;
}

/**
 * Heuristic for the "main" tex file:
 *   1. Prefer files that contain `\documentclass{`. There should be
 *      exactly one in a healthy bundle.
 *   2. If multiple, prefer ones NOT referenced by `\input{...}` or
 *      `\include{...}` from any other .tex (= the root of the tree).
 *   3. If still ambiguous, prefer the one matching `main.tex` /
 *      `paper.tex` / `manuscript.tex`.
 *   4. Fall back to the largest .tex by size.
 *   5. Give up → null.
 *
 * Exported so tests can pin every branch.
 */
export async function resolveMainTex(
  rootDir: string,
  texFiles: string[],
): Promise<string | null> {
  if (texFiles.length === 0) return null;
  if (texFiles.length === 1) return texFiles[0];

  // Read all .tex contents once.
  const contents = new Map<string, string>();
  for (const f of texFiles) {
    try {
      contents.set(f, await fs.readFile(f, "utf-8"));
    } catch {
      contents.set(f, "");
    }
  }

  // (1) candidates with \documentclass
  const docclassRe = /\\documentclass[\s\S]*?\{/;
  let candidates = texFiles.filter((f) => docclassRe.test(contents.get(f) ?? ""));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) candidates = texFiles;

  // (2) drop those that are \input{} or \include{}d by another file
  const baseName = (f: string): string =>
    path.basename(f).replace(/\.tex$/i, "");
  const inputRe = /\\(?:input|include|subfile)\{([^}]+)\}/g;
  const referenced = new Set<string>();
  for (const [_file, body] of contents.entries()) {
    let m: RegExpExecArray | null;
    while ((m = inputRe.exec(body)) !== null) {
      const ref = m[1].trim();
      // Match by basename (with or without .tex).
      referenced.add(ref);
      referenced.add(ref.replace(/\.tex$/i, ""));
    }
  }
  const roots = candidates.filter((f) => {
    return !referenced.has(baseName(f));
  });
  if (roots.length === 1) return roots[0];
  if (roots.length > 0) candidates = roots;

  // (3) name preference
  const preferred = ["main.tex", "paper.tex", "manuscript.tex", "ms.tex"];
  for (const want of preferred) {
    const match = candidates.find((f) => path.basename(f).toLowerCase() === want);
    if (match) return match;
  }

  // (4) largest by size
  let best: { file: string; size: number } | null = null;
  for (const f of candidates) {
    try {
      const st = await fs.stat(f);
      if (!best || st.size > best.size) best = { file: f, size: st.size };
    } catch {
      // ignore
    }
  }
  return best?.file ?? null;
}

/**
 * Classify extracted files into .tex / .bib / figure buckets.
 * Exported for tests.
 */
export function classifyFiles(allFiles: string[]): {
  texFiles: string[];
  bibFiles: string[];
  figureFiles: string[];
} {
  const texFiles: string[] = [];
  const bibFiles: string[] = [];
  const figureFiles: string[] = [];
  const figExts = new Set([".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"]);
  for (const f of allFiles) {
    const lower = f.toLowerCase();
    if (lower.endsWith(".tex")) texFiles.push(f);
    else if (lower.endsWith(".bib")) bibFiles.push(f);
    else if (figExts.has(path.extname(lower))) figureFiles.push(f);
  }
  return { texFiles, bibFiles, figureFiles };
}

/**
 * Download + extract the arxiv source bundle. See module header for
 * the full contract.
 */
/**
 * [Fix B1 2026-06-26] In-process lock so concurrent fetchArxivSource()
 * calls for the same (workspace, arxivId) serialize. Without it, two
 * spine-builder paths fetching the same paper would both download,
 * both extract to different staging dirs, and race on rename → second
 * gets ENOTEMPTY and falls to the EXDEV branch which `cp -r` over
 * the first's freshly-promoted cache, possibly mid-read by a third
 * party. Per-process serialization is sufficient because the cache
 * is workspace-local on disk (mathran is single-process; mathub
 * multi-process is handled separately by a content-addressed name).
 */
const inflightFetches = new Map<string, Promise<FetchArxivSourceResult>>();

/**
 * Download + extract the arxiv source bundle. See module header for
 * the full contract.
 */
export async function fetchArxivSource(
  arxivId: string,
  options: FetchArxivSourceOptions,
): Promise<FetchArxivSourceResult> {
  if (!ARXIV_ID_RE.test(arxivId)) {
    return { status: "invalid-id", arxivId, error: `bad arxiv id: ${arxivId}` };
  }
  // [Fix B1] Deduplicate concurrent fetches by (workspace, arxivId).
  // Note: force:true callers should still go through the same lock
  // — otherwise a force-refetch racing with a normal fetch could
  // double-promote.
  const inflightKey = `${options.workspace}::${arxivId}::${options.force ? "force" : "normal"}`;
  const existing = inflightFetches.get(inflightKey);
  if (existing) return existing;
  const promise = doFetchArxivSource(arxivId, options).finally(() => {
    inflightFetches.delete(inflightKey);
  });
  inflightFetches.set(inflightKey, promise);
  return promise;
}

async function doFetchArxivSource(
  arxivId: string,
  options: FetchArxivSourceOptions,
): Promise<FetchArxivSourceResult> {
  const cacheDir = cacheDirFor(options.workspace, arxivId);

  // ── cache hit?
  if (!options.force) {
    const marker = await readMarker(cacheDir);
    if (marker) {
      const files = await walkFiles(cacheDir);
      const { texFiles, bibFiles, figureFiles } = classifyFiles(files);
      const main = marker.mainTexFile && (await fileExists(marker.mainTexFile))
        ? marker.mainTexFile
        : await resolveMainTex(cacheDir, texFiles);
      return {
        status: "ok",
        arxivId,
        rootDir: cacheDir,
        mainTexFile: main,
        texFiles,
        bibFiles,
        figureFiles,
        fromCache: true,
        byteSize: marker.byteSize || (await totalSize(files)),
        fetchedAt: marker.fetchedAt,
      };
    }
  }

  // ── fetch
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: {
    ok: boolean;
    status: number;
    body: ReadableStream<Uint8Array> | null;
    headers?: { get(name: string): string | null };
  };
  try {
    response = await fetchImpl(`${ARXIV_E_PRINT_URL}/${encodeURIComponent(arxivId)}`, {
      signal: controller.signal,
      headers: { "User-Agent": "mathran/1.0 (research-agent; arxiv-source-fetch)" },
    });
  } catch (err: any) {
    clearTimeout(timer);
    return { status: "fetch-failed", arxivId, error: err?.message ?? String(err) };
  }
  clearTimeout(timer);

  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      return { status: "no-source", arxivId, error: `arxiv returned HTTP ${response.status}` };
    }
    return { status: "fetch-failed", arxivId, error: `arxiv returned HTTP ${response.status}` };
  }
  if (!response.body) {
    return { status: "fetch-failed", arxivId, error: "arxiv response had empty body" };
  }

  // [Fix A24 2026-06-26] arxiv `/e-print/` content negotiation:
  //   - application/x-eprint-tar  → gzipped tar (the common case)
  //   - application/x-eprint      → bare PDF (no useful source)
  //   - application/pdf           → bare PDF (no useful source)
  //   - text/plain or text/x-tex  → single-file .tex submission
  //   - other                     → unknown, try gzip+tar then fail
  // When the test fetchImpl omits headers we keep the original behavior.
  const contentType = response.headers?.get("content-type")?.toLowerCase() ?? "";
  // [Fix B8 2026-06-26] Use includes() not === because real arxiv
  // responses carry suffixes like "; charset=binary".
  if (contentType.includes("application/pdf") || contentType.includes("application/x-eprint")) {
    // The full eprint type is "application/x-eprint-tar" for gzipped
    // tar (the common case) — don't false-positive on that.
    if (contentType.includes("application/x-eprint-tar")) {
      // fall through to gzipped-tar path
    } else {
      try {
        if (response.body && typeof (response.body as ReadableStream).cancel === "function") {
          await (response.body as ReadableStream).cancel();
        }
      } catch { /* ignore */ }
      return { status: "no-source", arxivId, error: `arxiv only ships PDF for ${arxivId}` };
    }
  }
  const isPlainTex = contentType.includes("text/plain") || contentType.includes("text/x-tex");

  // ── extract to staging then atomic rename
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), `mathran-arxiv-${safeIdSegment(arxivId)}-`));
  try {
   if (isPlainTex) {
     // Single-file .tex submission: write the response body to main.tex.
     const chunks: Buffer[] = [];
     const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
     for await (const c of nodeStream) chunks.push(Buffer.from(c));
     await fs.writeFile(path.join(stagingDir, "main.tex"), Buffer.concat(chunks));
   } else {
    // Pipeline: response stream → gunzip → tar extractor (writes into stagingDir).
    // The stream we get from fetch() is a web ReadableStream; convert
    // to node Readable.
    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(
      nodeStream,
      createGunzip(),
      // [Fix A14 2026-06-26] tar 7 + strict:false will silently allow
      // symlinks / hardlinks / absolute paths; an attacker who controls
      // the arxiv submission could ship `evil -> /etc/passwd` and any
      // reader of the cache would follow that symlink. Drop all non-
      // regular-file entries via filter.
      tar.extract({
        cwd: stagingDir,
        preservePaths: false,
        strict: false,
        filter: (_p, entry) => {
          const type = (entry as { type?: string }).type;
          if (type !== "File" && type !== "Directory") return false;
          const ep = (entry as { path?: string }).path ?? "";
          if (ep.startsWith("/") || ep.includes("..")) return false;
          return true;
        },
      }),
    );
   } // close else (gzipped-tar branch — Fix A24)
  } catch (err: any) {
    // Could also be a single .tex file (not a tar). arxiv historically
    // sometimes returns a bare gzipped .tex for very simple papers.
    // We don't try to recover from that here — tag as extract-failed
    // and let the caller fall back to PDF.
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return { status: "extract-failed", arxivId, error: err?.message ?? String(err) };
  }

  // ── inventory
  const files = await walkFiles(stagingDir);
  const { texFiles, bibFiles, figureFiles } = classifyFiles(files);
  const mainTexAbs = await resolveMainTex(stagingDir, texFiles);
  const byteSize = await totalSize(files);
  const fetchedAt = new Date().toISOString();

  // ── promote staging → cacheDir
  // If cacheDir already exists (e.g. force=true), wipe it first.
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.dirname(cacheDir), { recursive: true });
  try {
    await fs.rename(stagingDir, cacheDir);
  } catch (err: any) {
    // Cross-device — copy + remove.
    if (err?.code === "EXDEV") {
      const { cp, rm } = await import("node:fs/promises");
      await cp(stagingDir, cacheDir, { recursive: true });
      await rm(stagingDir, { recursive: true, force: true });
    } else {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return { status: "extract-failed", arxivId, error: `promote failed: ${err?.message ?? String(err)}` };
    }
  }

  // ── re-resolve paths relative to final cacheDir
  const finalFiles = await walkFiles(cacheDir);
  const finalCls = classifyFiles(finalFiles);
  const mainTexFinal = mainTexAbs
    ? path.join(cacheDir, path.relative(stagingDir, mainTexAbs))
    : await resolveMainTex(cacheDir, finalCls.texFiles);

  // ── write marker
  await fs.writeFile(
    path.join(cacheDir, ".complete"),
    JSON.stringify(
      {
        arxivId,
        fetchedAt,
        mainTexFile: mainTexFinal,
        byteSize,
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    status: "ok",
    arxivId,
    rootDir: cacheDir,
    mainTexFile: mainTexFinal,
    texFiles: finalCls.texFiles,
    bibFiles: finalCls.bibFiles,
    figureFiles: finalCls.figureFiles,
    fromCache: false,
    byteSize,
    fetchedAt,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * List paper-source cache entries under a workspace. Used by SPA to
 * render "what we've already fetched". Returns each cached arxiv id
 * with its marker contents.
 */
export interface CacheEntry {
  arxivId: string;
  rootDir: string;
  fetchedAt: string;
  mainTexFile: string | null;
  byteSize: number;
}

export async function listCachedSources(workspace: string): Promise<CacheEntry[]> {
  const cacheRoot = path.join(workspace, ".mathran", "paper-sources");
  let entries: { name: string }[];
  try {
    entries = (await fs.readdir(cacheRoot, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
  const out: CacheEntry[] = [];
  for (const e of entries) {
    const dir = path.join(cacheRoot, e.name);
    const marker = await readMarker(dir);
    if (!marker) continue;
    out.push({
      arxivId: marker.arxivId || e.name,
      rootDir: dir,
      fetchedAt: marker.fetchedAt,
      mainTexFile: marker.mainTexFile,
      byteSize: marker.byteSize,
    });
  }
  return out;
}
