/**
 * Layered `settings.json` HTTP surface for the SPA `/settings` page.
 *
 * The three cascade layers (PROJECT > WORKSPACE > USER) each own a
 * `settings.json`; this module exposes them over HTTP so the web UI can edit
 * every {@link MathranSettingsSchema} field without hand-editing JSON:
 *
 *   GET  /api/settings/effective?projectSlug=foo
 *        → merged effective config + raw per-layer settings + per-field source
 *          layer + on-disk paths.
 *   GET  /api/settings/:layer?projectSlug=foo   (layer ∈ user|workspace|project)
 *        → that layer's raw settings.json (un-merged). Missing file → {}.
 *   PUT  /api/settings/:layer?projectSlug=foo
 *        body: a partial MathranSettings JSON.
 *        → deep-merges into the existing file (never a whole-file overwrite, so
 *          hand-edited passthrough fields survive) and atomically writes it.
 *
 * Guards (also enforced server-side because the frontend can be bypassed):
 *   - USER layer is whitelisted to `ui.theme`, `editor`, `modelPreference`.
 *     A PUT touching anything else → 400.
 *   - PROJECT layer requires `projectSlug` → 400 when missing.
 *   - The merged result must pass {@link MathranSettingsSchema} → 400 on failure
 *     with per-field issue details.
 *
 * Writes go through {@link atomicWriteFile} (tmp + rename) so a crash mid-write
 * never corrupts the file or leaves a stray `.tmp` behind.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Hono } from "hono";

import {
  MathranSettingsSchema,
  SETTINGS_SCHEMA_VERSION,
  type MathranSettings,
} from "../core/config/schemas.js";
import { MATHRAN_DIR, SETTINGS_FILE } from "../core/config/mathran-root.js";
import { loadLayeredSettings } from "../core/config/layered-settings.js";
import { atomicWriteFile } from "../core/chat/atomic-write.js";
import { withFileLock } from "../core/chat/store.js";

export type SettingsLayerName = "user" | "workspace" | "project";

const LAYER_NAMES: ReadonlySet<string> = new Set([
  "user",
  "workspace",
  "project",
]);

/**
 * Top-level keys the USER layer may write. `ui` is further restricted to the
 * `theme` sub-key (see {@link validateUserWhitelist}). This deliberately
 * excludes `skills`, `hooks`, `agent` and `approval` — those are
 * team/workspace-owned policy fields.
 */
export const USER_WRITABLE_KEYS: ReadonlyArray<string> = [
  "ui",
  "editor",
  "modelPreference",
];

export const USER_WHITELIST_MESSAGE =
  "USER layer can only set ui.theme, editor, modelPreference";

export interface SettingsRoutesOpts {
  /** Override `$HOME` for the USER layer (tests). */
  home?: string;
}

// ──────────────────────────────────────────────────────────────────────
// path helpers
// ──────────────────────────────────────────────────────────────────────

function userSettingsPath(home: string): string {
  return path.join(home, MATHRAN_DIR, SETTINGS_FILE);
}

function workspaceSettingsPath(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR, SETTINGS_FILE);
}

function projectSettingsPath(workspace: string, slug: string): string {
  return path.join(workspace, "projects", slug, MATHRAN_DIR, SETTINGS_FILE);
}

/**
 * Resolve the on-disk settings.json path for a layer. Returns `null` for the
 * `project` layer when no slug is supplied (caller turns this into a 400).
 */
export function settingsPathForLayer(
  layer: SettingsLayerName,
  workspace: string,
  home: string,
  projectSlug?: string,
): string | null {
  switch (layer) {
    case "user":
      return userSettingsPath(home);
    case "workspace":
      return workspaceSettingsPath(workspace);
    case "project":
      if (!projectSlug) return null;
      return projectSettingsPath(workspace, projectSlug);
  }
}

// ──────────────────────────────────────────────────────────────────────
// read / merge / write
// ──────────────────────────────────────────────────────────────────────

/** Read + JSON-parse a settings.json. Missing or unreadable → `{}`. */
export async function readRawSettings(
  filePath: string,
): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Deep-merge `patch` over `base`. Plain nested objects merge key-by-key; arrays
 * and scalars are replaced wholesale (so editing `approval.rules` replaces the
 * list rather than concatenating). A patch value of `null` deletes the key.
 */
export function deepMergeSettings(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    if (value === undefined) continue;
    const prev = out[key];
    if (
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = deepMergeSettings(
        prev as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface WhitelistResult {
  ok: boolean;
  /** The offending dotted field path when `ok` is false. */
  field?: string;
}

/**
 * Validate that a USER-layer PUT body only touches whitelisted fields. The
 * `ui` object may only carry `theme`. `schemaVersion` is always allowed.
 */
export function validateUserWhitelist(
  body: Record<string, unknown>,
): WhitelistResult {
  for (const key of Object.keys(body)) {
    if (key === "schemaVersion") continue;
    if (key === "editor" || key === "modelPreference") continue;
    if (key === "ui") {
      const ui = body.ui;
      if (ui && typeof ui === "object" && !Array.isArray(ui)) {
        for (const uk of Object.keys(ui as Record<string, unknown>)) {
          if (uk !== "theme") return { ok: false, field: `ui.${uk}` };
        }
      }
      continue;
    }
    return { ok: false, field: key };
  }
  return { ok: true };
}

/**
 * Atomically merge `patch` into the settings.json at `filePath` and write it.
 * Returns the merged object that was written. Creates the parent `.mathran/`
 * directory if needed.
 */
export async function mergeAndWriteSettings(
  filePath: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 2026-06-25 audit K2 — RMW: read existing → merge → write. Two concurrent
  // PUT /api/settings/<layer> for the same layer would otherwise lose one
  // patch's modifications. Per-file lock serialises them.
  return await withFileLock(filePath, async () => {
    const existing = await readRawSettings(filePath);
    const merged = deepMergeSettings(existing, patch);
    if (merged.schemaVersion === undefined) {
      merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, JSON.stringify(merged, null, 2) + "\n");
    return merged;
  });
}

// ──────────────────────────────────────────────────────────────────────
// sources (per-field origin layer)
// ──────────────────────────────────────────────────────────────────────

/** Flatten a settings object to dotted leaf paths (arrays are leaves). */
export function flattenLeafPaths(
  obj: Record<string, unknown>,
  prefix = "",
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenLeafPaths(value as Record<string, unknown>, dotted));
    } else {
      out.push(dotted);
    }
  }
  return out;
}

function hasLeaf(obj: Record<string, unknown>, dotted: string): boolean {
  const parts = dotted.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return false;
    if (!(p in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur !== undefined;
}

/**
 * For every leaf path in `effective`, record the highest-precedence layer
 * (project > workspace > user) whose raw settings define that leaf.
 */
export function computeSources(
  effective: Record<string, unknown>,
  layers: {
    user: Record<string, unknown>;
    workspace: Record<string, unknown>;
    project: Record<string, unknown>;
  },
): Record<string, SettingsLayerName> {
  const sources: Record<string, SettingsLayerName> = {};
  for (const leaf of flattenLeafPaths(effective)) {
    if (leaf === "schemaVersion") continue;
    if (hasLeaf(layers.project, leaf)) sources[leaf] = "project";
    else if (hasLeaf(layers.workspace, leaf)) sources[leaf] = "workspace";
    else if (hasLeaf(layers.user, leaf)) sources[leaf] = "user";
  }
  return sources;
}

// ──────────────────────────────────────────────────────────────────────
// route registration
// ──────────────────────────────────────────────────────────────────────

/**
 * Mount the `/api/settings/*` routes on `app`. `workspace` is the cascade root;
 * `opts.home` overrides `$HOME` for the USER layer (used by tests).
 */
export function registerSettingsRoutes(
  app: Hono,
  workspace: string,
  opts: SettingsRoutesOpts = {},
): void {
  const home = opts.home ?? os.homedir();

  // GET /api/settings/effective — merged config + per-layer raw + sources.
  app.get("/api/settings/effective", async (c) => {
    const projectSlug = c.req.query("projectSlug") || undefined;
    const result = loadLayeredSettings({ workspace, projectSlug, home });

    const byName = (name: SettingsLayerName): Record<string, unknown> => {
      const layer = result.layers.find((l) => l.layer === name);
      return (layer?.settings as Record<string, unknown> | null) ?? {};
    };
    const layersOut = {
      user: byName("user"),
      workspace: byName("workspace"),
      ...(projectSlug ? { project: byName("project") } : {}),
    };

    const effective = result.settings as Record<string, unknown>;
    const sources = computeSources(effective, {
      user: byName("user"),
      workspace: byName("workspace"),
      project: byName("project"),
    });

    const paths: Record<string, string> = {
      user: userSettingsPath(home),
      workspace: workspaceSettingsPath(workspace),
    };
    if (projectSlug) paths.project = projectSettingsPath(workspace, projectSlug);

    return c.json({
      effective,
      layers: layersOut,
      sources,
      paths,
      warnings: result.warnings,
    });
  });

  // GET /api/settings/:layer — that layer's raw settings.json (un-merged).
  app.get("/api/settings/:layer", async (c) => {
    const layer = c.req.param("layer");
    if (!LAYER_NAMES.has(layer)) {
      return c.json({ error: `unknown settings layer "${layer}"` }, 404);
    }
    const projectSlug = c.req.query("projectSlug") || undefined;
    const filePath = settingsPathForLayer(
      layer as SettingsLayerName,
      workspace,
      home,
      projectSlug,
    );
    if (!filePath) {
      return c.json(
        { error: "project layer requires a projectSlug query param" },
        400,
      );
    }
    const raw = await readRawSettings(filePath);
    return c.json({ layer, settings: raw, path: filePath });
  });

  // PUT /api/settings/:layer — partial-merge a settings patch into the layer.
  app.put("/api/settings/:layer", async (c) => {
    const layer = c.req.param("layer");
    if (!LAYER_NAMES.has(layer)) {
      return c.json({ error: `unknown settings layer "${layer}"` }, 404);
    }
    const projectSlug = c.req.query("projectSlug") || undefined;

    if (layer === "project" && !projectSlug) {
      return c.json(
        { error: "project layer requires a projectSlug query param" },
        400,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    const patch = body as Record<string, unknown>;

    // USER whitelist — server-side enforcement (frontend can be bypassed).
    if (layer === "user") {
      const wl = validateUserWhitelist(patch);
      if (!wl.ok) {
        return c.json(
          { error: USER_WHITELIST_MESSAGE, field: wl.field },
          400,
        );
      }
    }

    // Validate the *merged* result against the schema so a bad patch (wrong
    // types, out-of-range numbers, bad enum) is rejected before we touch disk.
    const filePath = settingsPathForLayer(
      layer as SettingsLayerName,
      workspace,
      home,
      projectSlug,
    )!;
    const existing = await readRawSettings(filePath);
    const mergedPreview = deepMergeSettings(existing, patch);
    const parsed = MathranSettingsSchema.safeParse(mergedPreview);
    if (!parsed.success) {
      return c.json(
        {
          error: "settings failed schema validation",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }

    let merged: Record<string, unknown>;
    try {
      merged = await mergeAndWriteSettings(filePath, patch);
    } catch (err: any) {
      return c.json(
        { error: `failed to write settings: ${err?.message ?? err}` },
        500,
      );
    }
    return c.json({ layer, settings: merged, path: filePath });
  });
}
