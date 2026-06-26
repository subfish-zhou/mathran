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
  appendInferenceRun,
  approveCandidate,
  defaultProfileDir,
  readActiveInferred,
  readCitedPapers,
  readDisagreed,
  readInferenceRuns,
  readInferred,
  readOwnPapers,
  readPendingCandidates,
  readProjects,
  readSnapshot,
  rejectCandidate,
  removeCitedPaper,
  removeInferred,
  removeOwnPaper,
  removeProject,
  upsertProject,
} from "../core/profile/index.js";
import { runInference } from "../core/profile/inference.js";
import type { LLMProvider } from "../core/providers/llm.js";

function zodErrorBody(err: ZodError): { error: string; issues: any[] } {
  return {
    error: "profile entry failed validation",
    issues: err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

export interface ProfileRoutesDeps {
  /**
   * Factory for the LLM used by the inference pipeline. Called per
   * request so the route picks up provider config changes without a
   * server restart. Returns null when no provider is configured —
   * the route then 503s.
   */
  inferenceLlmFactory?: () => { llm: LLMProvider; model: string } | null;
}

export function registerProfileRoutes(
  app: Hono,
  deps: ProfileRoutesDeps = {},
): void {
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

  // ── inferred / inference (LAYER 3) ────────────────────────────────

  /**
   * Active (non-expired) inferred entries. The SPA shows these on
   * the Inferred tab; the model reads them via user_profile_read
   * (which slice="inferred-active" returns the same set).
   */
  app.get("/api/profile/inferred", async (c) => {
    const includeExpired = c.req.query("includeExpired") === "1";
    const entries = includeExpired
      ? await readInferred(profileDir)
      : await readActiveInferred(profileDir);
    return c.json({ inferred: entries });
  });

  app.delete("/api/profile/inferred/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing id" }, 400);
    const removed = await removeInferred(id, profileDir);
    return c.json({ removed });
  });

  /** Disagreed-with claims (blacklist). User-visible audit only. */
  app.get("/api/profile/disagreed", async (c) => {
    return c.json({ disagreed: await readDisagreed(profileDir) });
  });

  /** Pending candidates awaiting approval / rejection. */
  app.get("/api/profile/inference/pending", async (c) => {
    return c.json({ pending: await readPendingCandidates(profileDir) });
  });

  /** Append-only run log — for the SPA to show "last ran X minutes ago". */
  app.get("/api/profile/inference/runs", async (c) => {
    const all = await readInferenceRuns(profileDir);
    // Newest first; cap to 50 — anything older is auditing-only.
    const tail = all.slice(-50).reverse();
    return c.json({ runs: tail });
  });

  /**
   * Trigger one inference pass. Synchronous (returns when the LLM call
   * finishes) — keeps the surface dead simple. If the user wants to
   * cancel mid-flight they reload the page; the AbortSignal here only
   * fires when the SPA explicitly disconnects (rare for a fetch).
   *
   * 503s when no LLM factory is wired.
   * 400s on bad body (just for forward-compat — currently no body args).
   */
  app.post("/api/profile/inference/run", async (c) => {
    const factory = deps.inferenceLlmFactory;
    if (!factory) {
      return c.json(
        { error: "no LLM provider wired for inference" },
        503,
      );
    }
    const built = factory();
    if (!built) {
      return c.json(
        { error: "LLM factory returned null (provider not configured)" },
        503,
      );
    }
    try {
      const result = await runInference(built.llm, {
        profileDir,
        model: built.model,
        signal: (c.req.raw as any).signal,
      });
      return c.json(result);
    } catch (err: any) {
      // runInference is supposed to catch everything internally, but
      // belt-and-suspenders — emit a failed run row too so the SPA
      // can show it.
      const runId = "uncaught-" + Date.now();
      await appendInferenceRun(
        {
          runId,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: "failed",
          error: err?.message ?? String(err),
          model: built.model,
        },
        profileDir,
      );
      return c.json(
        { error: err?.message ?? String(err), runId },
        500,
      );
    }
  });

  /**
   * Approve one candidate. Body: { userNote?: string } (the user can
   * attach an optional edit explaining their take).
   * Returns the persisted InferredEntry on success, 404 when the
   * candidate id doesn't exist.
   */
  app.post("/api/profile/inference/approve/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing id" }, 400);
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine — userNote is optional.
    }
    const userNote =
      typeof body?.userNote === "string" ? body.userNote : undefined;
    const entry = await approveCandidate(id, { userNote }, profileDir);
    if (!entry) return c.json({ error: "candidate not found" }, 404);
    return c.json({ entry });
  });

  /**
   * Reject one candidate. Same body shape as approve — the userNote
   * gets attached to the resulting disagreed entry so future runs see
   * not just "user said no" but also why.
   */
  app.post("/api/profile/inference/reject/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ error: "missing id" }, 400);
    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // optional
    }
    const userNote =
      typeof body?.userNote === "string" ? body.userNote : undefined;
    const entry = await rejectCandidate(id, { userNote }, profileDir);
    if (!entry) return c.json({ error: "candidate not found" }, 404);
    return c.json({ entry });
  });
}
