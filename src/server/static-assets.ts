/**
 * src/server/static-assets.ts
 *
 * Runtime side of the embedded-SPA story for the single-binary build (W10,
 * v0.15 §3).
 *
 * The Vite build drops the SPA into `dist/web/`; in the normal
 * `node dist/cli/index.js serve` path that's still hosted via `serveStatic`
 * from `@hono/node-server`. But under `bun build --compile` there IS no
 * `dist/web/` next to the executable — it's the binary, no surrounding
 * directory. So we also keep an in-memory Map of the same files, populated
 * at compile time by `scripts/build-static-assets.ts` (which emits
 * `./static-assets.generated.ts`).
 *
 * The order of preference in `serve.ts`:
 *   1. embedded map (when populated)               — works in single-binary
 *      AND also in `node` when the generator ran during the build.
 *   2. on-disk `dist/web/` via `serveStatic`        — dev / npm-installed
 *      use-case, when the generator has not run.
 *   3. small placeholder HTML page                  — neither is available.
 *
 * The embedded map is deliberately tiny (a Hono handler, no global state)
 * so cost in the compiled binary is just the asset bytes themselves.
 */

import type { Context } from "hono";

import { EMBEDDED_ASSETS } from "./static-assets.generated.js";

/** The shape the generator emits — base64-encoded so the source file is text. */
export interface EmbeddedAssetRaw {
  /** URL path, leading slash (`/index.html`, `/assets/index-xxx.js`). */
  path: string;
  /** Content-Type to serve. */
  contentType: string;
  /** Base64-encoded file bytes. */
  base64: string;
}

/** What the runtime actually serves: bytes already decoded once. */
export interface EmbeddedAsset {
  contentType: string;
  body: Uint8Array;
}

/**
 * Decode the generator's base64 payload into a Map<URL path, asset>.
 *
 * `Buffer.from(..., "base64")` works under both Node (which is what
 * `npx vitest run` and `node dist/cli/index.js` use) and Bun (`bun build
 * --compile` runtime). The result is sliced into a plain Uint8Array so
 * Hono's `c.body(...)` is happy in both worlds.
 */
function buildEmbeddedMap(): Map<string, EmbeddedAsset> {
  const map = new Map<string, EmbeddedAsset>();
  for (const e of EMBEDDED_ASSETS) {
    const buf = Buffer.from(e.base64, "base64");
    map.set(e.path, {
      contentType: e.contentType,
      // Strip the surrounding ArrayBuffer offset so we hand Hono exactly the
      // file bytes and nothing else.
      body: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    });
  }
  return map;
}

/** Lazily-built so the decode cost is paid once per process at first lookup. */
let _assetMap: Map<string, EmbeddedAsset> | null = null;
function assets(): Map<string, EmbeddedAsset> {
  if (_assetMap === null) _assetMap = buildEmbeddedMap();
  return _assetMap;
}

/** `true` when the compile-time generator populated the manifest. */
export function hasEmbeddedAssets(): boolean {
  return EMBEDDED_ASSETS.length > 0;
}

/** Number of embedded files (for diagnostics). */
export function embeddedAssetCount(): number {
  return EMBEDDED_ASSETS.length;
}

/** Lookup a single asset by URL path (e.g. `/index.html`). */
export function getEmbeddedAsset(urlPath: string): EmbeddedAsset | undefined {
  return assets().get(urlPath);
}

/** Lookup `index.html` (used as the SPA fallback). */
export function getEmbeddedIndex(): EmbeddedAsset | undefined {
  return assets().get("/index.html");
}

/**
 * Hono handler factory that serves the embedded SPA.
 *
 * `c.req.path` is matched verbatim; `/` is mapped to `/index.html`. If the
 * incoming path is missing AND it doesn't start with `/api/`, we fall back
 * to `/index.html` so client-side routing survives hard refreshes (SPA
 * fallback — same behavior as the on-disk hosting path).
 */
export function makeEmbeddedAssetHandler() {
  return async (c: Context) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: "not found" }, 404);
    }
    let p = c.req.path;
    if (p === "/" || p === "") p = "/index.html";

    let asset = getEmbeddedAsset(p);

    // SPA fallback for client-side routes (anything not /api/ and not a real
    // asset file) → serve index.html.
    if (!asset && !p.startsWith("/api/")) {
      asset = getEmbeddedIndex();
    }

    if (!asset) return c.json({ error: "not found" }, 404);

    return new Response(asset.body as BodyInit, {
      status: 200,
      headers: {
        "content-type": asset.contentType,
        "content-length": String(asset.body.byteLength),
        // SPA bundles already carry content hashes in filenames; this is the
        // conservative cache policy for the document shell.
        "cache-control": p === "/index.html" ? "no-cache" : "public, max-age=3600",
      },
    });
  };
}
