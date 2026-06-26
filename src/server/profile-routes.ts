/**
 * REST surface for `~/.mathran/profile/` (user-distillation Phase 1).
 *
 * Layered like the existing settings-routes / memory-routes — separate
 * file, register pattern, no shared state with the chat surface.
 *
 * All writes go through the store's withFileLock + atomicWriteFile,
 * so concurrent SPA edits from two tabs serialise cleanly and a crash
 * mid-write can't corrupt the profile.
 *
 * 2026-06-26.
 */

import type { Hono } from "hono";
import { ZodError } from "zod";

import {
  addCitedPaper,
  addOwnPaper,
  defaultProfileDir,
  readCitedPapers,
  readOwnPapers,
  readProjects,
  readSnapshot,
  removeCitedPaper,
  removeOwnPaper,
  removeProject,
  upsertProject,
} from "../core/profile/index.js";

function zodErrorBody(err: ZodError): { error: string; issues: any[] } {
  return {
    error: "profile entry failed validation",
    issues: err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

export function registerProfileRoutes(app: Hono): void {
  const profileDir = defaultProfileDir();

  /** Full snapshot (used by SPA profile page header). */
  app.get("/api/profile", async (c) => {
    try {
      const snapshot = await readSnapshot(profileDir);
      return c.json(snapshot);
    } catch (err: any) {
      return c.json(
        { error: `failed to read profile: ${err?.message ?? String(err)}` },
        500,
      );
    }
  });

  // ── papers-own ────────────────────────────────────────────────────

  app.get("/api/profile/papers-own", async (c) => {
    return c.json({ papers: await readOwnPapers(profileDir) });
  });

  app.post("/api/profile/papers-own", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const r = await addOwnPaper(body as any, profileDir);
      return c.json(r, r.added ? 201 : 200);
    } catch (err) {
      if (err instanceof ZodError) return c.json(zodErrorBody(err), 400);
      return c.json(
        { error: `failed to add: ${(err as Error)?.message ?? err}` },
        500,
      );
    }
  });

  /**
   * DELETE by id (arxivId or doi). Encoded as path segment because
   * arxiv ids contain `.` and slashes; the SPA must `encodeURIComponent`.
   */
  app.delete("/api/profile/papers-own/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing id" }, 400);
    const removed = await removeOwnPaper(id, profileDir);
    return c.json({ removed });
  });

  // ── papers-cited ──────────────────────────────────────────────────

  app.get("/api/profile/papers-cited", async (c) => {
    return c.json({ papers: await readCitedPapers(profileDir) });
  });

  app.post("/api/profile/papers-cited", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const r = await addCitedPaper(body as any, profileDir);
      return c.json(r, r.added ? 201 : 200);
    } catch (err) {
      if (err instanceof ZodError) return c.json(zodErrorBody(err), 400);
      return c.json(
        { error: `failed to add: ${(err as Error)?.message ?? err}` },
        500,
      );
    }
  });

  app.delete("/api/profile/papers-cited/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing id" }, 400);
    const removed = await removeCitedPaper(id, profileDir);
    return c.json({ removed });
  });

  // ── projects ──────────────────────────────────────────────────────

  app.get("/api/profile/projects", async (c) => {
    return c.json({ projects: await readProjects(profileDir) });
  });

  /**
   * Upsert (create or update) by slug. Returns `{ created, entry }`.
   * Single endpoint for create + update mirrors the wiki-store pattern
   * (writeWikiPage upserts by page) and saves the SPA the trouble of
   * caring which one it is.
   */
  app.put("/api/profile/projects/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug) return c.json({ error: "missing slug" }, 400);
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    // Path slug wins over body — prevent the SPA from accidentally
    // sending the wrong one and ending up with two entries.
    const merged = { ...(body ?? {}), slug };
    try {
      const r = await upsertProject(merged, profileDir);
      return c.json(r, r.created ? 201 : 200);
    } catch (err) {
      if (err instanceof ZodError) return c.json(zodErrorBody(err), 400);
      return c.json(
        { error: `failed to upsert: ${(err as Error)?.message ?? err}` },
        500,
      );
    }
  });

  app.delete("/api/profile/projects/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!slug) return c.json({ error: "missing slug" }, 400);
    const removed = await removeProject(slug, profileDir);
    return c.json({ removed });
  });
}
