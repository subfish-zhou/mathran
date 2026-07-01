/**
 * TikZ render HTTP route — POST /api/render/tikz
 *
 * Request:
 *   { source: "<TikZ env body — \\begin{tikzcd}...\\end{tikzcd}>",
 *     options?: { tikzLibraries?: string, texPackages?: Record<string,string> } }
 *
 * Response 200:
 *   { ok: true, svg: "<svg…>", hash: "…", fromCache: boolean }
 *
 * Response 200 (render failure — still 200 so the SPA can surface the
 * error inline without triggering global fetch error handling):
 *   { ok: false, hash: "…", error: "<msg>" }
 *
 * Response 400: malformed request body / missing source.
 * Response 413: source too large (see MAX_SOURCE_CHARS).
 *
 * Rate-limit / auth:
 *   Runs inside mathran serve which is 127.0.0.1-bound + already gated
 *   by the portal auth cookie. No per-request auth added here.
 */

import type { Hono } from "hono";
import { renderTikz } from "../core/tikz-render/index.js";

// Cap source length. Real tikzcd diagrams are <2KB; anything above 32KB
// is almost certainly abuse (or an LLM output loop) and rejecting is
// cheaper than letting node-tikzjax fight a runaway TeX macro.
const MAX_SOURCE_CHARS = 32 * 1024;

export function registerTikzRoutes(app: Hono, workspace: string): void {
  app.post("/api/render/tikz", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    const src = (body as { source?: unknown }).source;
    if (typeof src !== "string" || src.trim().length === 0) {
      return c.json({ error: "missing 'source' string" }, 400);
    }
    if (src.length > MAX_SOURCE_CHARS) {
      return c.json({ error: `source too large (max ${MAX_SOURCE_CHARS} chars)` }, 413);
    }
    const optsRaw = (body as { options?: unknown }).options;
    const options = optsRaw && typeof optsRaw === "object" ? (optsRaw as {
      tikzLibraries?: string;
      texPackages?: Record<string, string>;
    }) : {};

    const result = await renderTikz({ source: src, workspace, options });
    // Always 200 — failures are surfaced in the { ok: false, error }
    // payload so the SPA can render an inline error placeholder rather
    // than treating a valid-but-uncompilable diagram as an HTTP failure.
    return c.json(result, 200);
  });
}
