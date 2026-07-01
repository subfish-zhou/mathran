/**
 * TikZ / tikzcd server-side renderer.
 *
 * Wraps `node-tikzjax` (a pure Node + WebAssembly port of TikZJax) to
 * convert `\begin{tikzcd}…\end{tikzcd}` (and other TikZ envs) into inline
 * SVG. KaTeX in the browser can't render tikzcd, but LLMs love emitting
 * it for commutative diagrams — this closes the gap.
 *
 * Design:
 *   - Content-addressed disk cache under `<workspace>/.mathran/tikz-cache/`
 *     keyed by sha256 of the normalized source. Cache hits are microseconds;
 *     cold render is ~800ms (WASM engine boot) + ~200ms per diagram after.
 *
 *   - Per-process mutex around `tex2svg()`. Upstream README warns:
 *       "Don't run multiple instances of node-tikzjax at the same time.
 *        This may cause unexpected results."
 *     A single in-flight promise queues concurrent callers.
 *
 *   - The renderer wraps whatever source the caller passes in the standard
 *     `\begin{document}...\end{document}` scaffold the library requires
 *     (README: "Remember to include \begin{document} and \end{document}").
 *     Callers pass just the env body (e.g. `\begin{tikzcd}...\end{tikzcd}`).
 *
 *   - Hard 30s timeout per render — a runaway TikZ source (recursive macro,
 *     infinite loop) shouldn't stall the whole mathran serve.
 *
 *   - Never throws. Failures return { ok: false, error }. Callers pick
 *     between rendering the SVG and showing an "unrenderable" placeholder.
 *
 * The `tikz-cd` package + `cd` TikZ library are loaded by default because
 * that's the overwhelmingly common LLM output (commutative diagrams);
 * callers can opt into more via `TikzRenderOptions`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// node-tikzjax exports `default` as CommonJS default; grab it via
// module-namespace shim so both `import x from` and `import {default}`
// work under our NodeNext module resolution.
import tex2svgModule from "node-tikzjax";
const tex2svg: (source: string, opts?: unknown) => Promise<string> =
  (tex2svgModule as unknown as { default?: (s: string, o?: unknown) => Promise<string> }).default ??
  (tex2svgModule as unknown as (s: string, o?: unknown) => Promise<string>);

// Default TeX + TikZ packages loaded on every render. tikz-cd is what LLMs
// use for commutative diagrams; the other three are the most common
// LLM-emitted TikZ envs we've seen in real math chats.
const DEFAULT_TEX_PACKAGES = { "tikz-cd": "" };
const DEFAULT_TIKZ_LIBRARIES = "cd,arrows.meta,calc,positioning";

// Hard render deadline. TikZ compilation on a runaway macro can hang;
// upstream doesn't expose a signal, so this is a wall-clock guard.
const RENDER_TIMEOUT_MS = 30_000;

export interface TikzRenderOptions {
  /** Extra TeX packages to load. Merged with `tikz-cd` default. */
  texPackages?: Record<string, string>;
  /** Extra TikZ libraries. Comma-separated. Appended to defaults. */
  tikzLibraries?: string;
}

export interface TikzRenderSuccess {
  ok: true;
  svg: string;
  /** Content hash the SVG is keyed by (sha256 of normalized source). */
  hash: string;
  /** True when the SVG came from disk cache instead of a fresh render. */
  fromCache: boolean;
}

export interface TikzRenderFailure {
  ok: false;
  /** Content hash (still computed so callers can dedupe error UI). */
  hash: string;
  /** Human-readable error message; may be shown to the user. */
  error: string;
}

export type TikzRenderResult = TikzRenderSuccess | TikzRenderFailure;

/**
 * Compute the cache key for a piece of TikZ source. Normalizes whitespace
 * so semantically-identical source (LLMs sometimes vary indentation across
 * regens) shares a cache entry.
 */
export function tikzHash(source: string, opts: TikzRenderOptions = {}): string {
  const normalized = source.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
  const optsBlob = JSON.stringify({
    packages: opts.texPackages ?? {},
    libraries: opts.tikzLibraries ?? "",
  });
  return createHash("sha256").update(normalized).update("\n").update(optsBlob).digest("hex").slice(0, 40);
}

// ── Concurrency guard ────────────────────────────────────────────────────────
// A single in-flight render promise. Concurrent callers await this promise
// (whether it succeeds or fails) then proceed with their own render. This
// isn't a full queue — it just serializes to satisfy the upstream warning
// about interleaved WASM state.
let inFlight: Promise<unknown> | null = null;

async function serializeRender<T>(fn: () => Promise<T>): Promise<T> {
  while (inFlight) {
    try {
      await inFlight;
    } catch {
      /* previous render failed; that's fine, we're next */
    }
  }
  const p = fn();
  inFlight = p;
  try {
    return await p;
  } finally {
    if (inFlight === p) inFlight = null;
  }
}

// ── Cache paths ──────────────────────────────────────────────────────────────

function cacheDir(workspace: string): string {
  return path.join(workspace, ".mathran", "tikz-cache");
}

function cachePath(workspace: string, hash: string): string {
  return path.join(cacheDir(workspace), `${hash}.svg`);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface RenderTikzInput {
  /**
   * The TikZ env body — typically `\begin{tikzcd}...\end{tikzcd}` or
   * `\begin{tikzpicture}...\end{tikzpicture}`. Do NOT include
   * `\documentclass` or `\begin{document}`; the renderer wraps them.
   */
  source: string;
  /** Workspace root — where the disk cache lives. */
  workspace: string;
  options?: TikzRenderOptions;
}

/**
 * Render TikZ source to SVG, with disk caching + concurrency serialization.
 * Never throws.
 */
export async function renderTikz(input: RenderTikzInput): Promise<TikzRenderResult> {
  const opts = input.options ?? {};
  const hash = tikzHash(input.source, opts);
  const dir = cacheDir(input.workspace);
  const filePath = cachePath(input.workspace, hash);

  // Cache hit?
  try {
    const cached = await fs.readFile(filePath, "utf8");
    if (cached.length > 0 && cached.startsWith("<svg")) {
      return { ok: true, svg: cached, hash, fromCache: true };
    }
  } catch {
    /* cache miss */
  }

  // Wrap in standalone doc scaffold. `\usetikzlibrary{cd,…}` MUST come
  // after `\documentclass` but the library injects it via texPackages
  // / tikzLibraries options — we don't need to write it into the source.
  const wrapped = `\\begin{document}\n${input.source.trim()}\n\\end{document}`;
  const texPackages = { ...DEFAULT_TEX_PACKAGES, ...(opts.texPackages ?? {}) };
  const tikzLibraries = opts.tikzLibraries
    ? `${DEFAULT_TIKZ_LIBRARIES},${opts.tikzLibraries}`
    : DEFAULT_TIKZ_LIBRARIES;

  return serializeRender(async (): Promise<TikzRenderResult> => {
    let svg: string;
    try {
      const renderP = tex2svg(wrapped, { texPackages, tikzLibraries });
      const timeoutP = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`tikz render timeout ${RENDER_TIMEOUT_MS}ms`)), RENDER_TIMEOUT_MS),
      );
      svg = await Promise.race([renderP, timeoutP]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, hash, error: msg };
    }
    if (typeof svg !== "string" || !svg.startsWith("<svg")) {
      return { ok: false, hash, error: "renderer returned non-svg output" };
    }
    // Persist cache — non-fatal if it fails (disk full etc.).
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, svg, "utf8");
    } catch {
      /* cache write failure isn't fatal */
    }
    return { ok: true, svg, hash, fromCache: false };
  });
}
