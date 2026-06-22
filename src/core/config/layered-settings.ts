/**
 * Layered `settings.json` loader (C 方案 cascade).
 *
 * Cascade precedence (high → low): PROJECT > WORKSPACE > USER.
 *
 *   ~/.mathran/settings.json                       Layer 3: USER
 *   <workspace>/.mathran/settings.json             Layer 2: WORKSPACE
 *   <workspace>/projects/<slug>/.mathran/settings.json  Layer 1: PROJECT
 *
 * Merge is field-level (deep for known nested objects, "higher wins" for
 * scalars + arrays), with a *whitelist* on the USER layer: a user may only
 * contribute `ui.theme`, `editor` and `modelPreference`. Anything else in the
 * USER layer (notably `skills.disabled` / `hooks.allowed`) is dropped and a
 * warning is recorded — those are团队/workspace-owned policy fields.
 *
 * Reads are best-effort: a missing file is "empty"; a malformed file is
 * skipped with a warning (never throws — settings must not crash startup).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MathranSettingsSchema, type MathranSettings } from "./schemas.js";
import { MATHRAN_DIR, SETTINGS_FILE } from "./mathran-root.js";

/** Fields the USER layer is permitted to override. */
export const USER_OVERRIDE_WHITELIST: ReadonlyArray<string> = [
  "ui.theme",
  "editor",
  "modelPreference",
  "approval",
];

export type SettingsLayerName = "user" | "workspace" | "project";

export interface SettingsLayer {
  layer: SettingsLayerName;
  /** Absolute path of the settings.json, or null when the layer is absent. */
  path: string | null;
  /** Parsed (validated) settings, or null when absent/invalid. */
  settings: MathranSettings | null;
}

export interface LoadLayeredSettingsOpts {
  /** Workspace root (contains `.mathran/`). */
  workspace: string;
  /** Optional project slug → adds the `projects/<slug>/.mathran` layer. */
  projectSlug?: string;
  /** Override `$HOME` for the USER layer (tests). */
  home?: string;
  /** Skip the USER layer (`~/.mathran`) — tests. */
  skipUser?: boolean;
}

export interface LayeredSettingsResult {
  /** The merged, whitelist-filtered effective settings. */
  settings: MathranSettings;
  /** Non-fatal warnings (malformed files, dropped user overrides). */
  warnings: string[];
  /** Per-layer detail (lowest → highest precedence: user, workspace, project). */
  layers: SettingsLayer[];
}

function settingsPathFor(dir: string): string {
  return path.join(dir, SETTINGS_FILE);
}

function userMathranDir(home?: string): string {
  return path.join(home ?? os.homedir(), MATHRAN_DIR);
}

function workspaceMathranDir(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR);
}

function projectMathranDir(workspace: string, slug: string): string {
  return path.join(workspace, "projects", slug, MATHRAN_DIR);
}

function readLayer(
  layer: SettingsLayerName,
  dir: string,
  warnings: string[],
): SettingsLayer {
  const p = settingsPathFor(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    return { layer, path: null, settings: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    warnings.push(`settings: ${p} is not valid JSON (${err?.message ?? err}); ignored.`);
    return { layer, path: p, settings: null };
  }
  const result = MathranSettingsSchema.safeParse(parsed);
  if (!result.success) {
    warnings.push(
      `settings: ${p} failed schema validation (${result.error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; ")}); ignored.`,
    );
    return { layer, path: p, settings: null };
  }
  return { layer, path: p, settings: result.data };
}

/**
 * Reduce the USER layer to its whitelisted fields. Anything outside the
 * whitelist is dropped and recorded as a warning.
 */
export function applyUserWhitelist(
  user: MathranSettings,
  warnings: string[],
): MathranSettings {
  const allowed: MathranSettings = {};
  const dropped: string[] = [];

  for (const key of Object.keys(user)) {
    if (key === "schemaVersion") continue;
    if (key === "editor") {
      if (user.editor !== undefined) allowed.editor = user.editor;
      continue;
    }
    if (key === "modelPreference") {
      if (user.modelPreference !== undefined) allowed.modelPreference = user.modelPreference;
      continue;
    }
    if (key === "approval") {
      // Approval is a personal/security preference: a user may set their own
      // policy on their own machine.
      if ((user as any).approval !== undefined)
        (allowed as any).approval = (user as any).approval;
      continue;
    }
    if (key === "ui") {
      // Only ui.theme is user-overridable.
      const theme = user.ui?.theme;
      const extraUiKeys = Object.keys(user.ui ?? {}).filter((k) => k !== "theme");
      if (theme !== undefined) allowed.ui = { theme };
      for (const k of extraUiKeys) dropped.push(`ui.${k}`);
      continue;
    }
    // Any other top-level key (skills, hooks, agent, ...) is not user-overridable.
    dropped.push(key);
  }

  if (dropped.length > 0) {
    warnings.push(
      `settings: USER layer (~/.mathran/settings.json) may only override ` +
        `${USER_OVERRIDE_WHITELIST.join(", ")}; ignored: ${dropped.join(", ")}.`,
    );
  }
  return allowed;
}

/** Deep-merge `b` over `a`. Known nested objects merge key-by-key; arrays + scalars are replaced. */
function mergeSettings(a: MathranSettings, b: MathranSettings): MathranSettings {
  const out: MathranSettings = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    const prev = (out as any)[key];
    if (
      prev &&
      typeof prev === "object" &&
      !Array.isArray(prev) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      (out as any)[key] = { ...prev, ...value };
    } else {
      (out as any)[key] = value;
    }
  }
  return out;
}

/**
 * Load and merge the three settings layers. Lowest precedence first; the USER
 * layer is whitelist-filtered before merging.
 */
export function loadLayeredSettings(
  opts: LoadLayeredSettingsOpts,
): LayeredSettingsResult {
  const warnings: string[] = [];
  const layers: SettingsLayer[] = [];

  // USER (lowest precedence).
  let userLayer: SettingsLayer = { layer: "user", path: null, settings: null };
  if (!opts.skipUser) {
    userLayer = readLayer("user", userMathranDir(opts.home), warnings);
  }
  layers.push(userLayer);

  // WORKSPACE.
  const workspaceLayer = readLayer(
    "workspace",
    workspaceMathranDir(opts.workspace),
    warnings,
  );
  layers.push(workspaceLayer);

  // PROJECT (highest precedence) — only when a slug is given.
  let projectLayer: SettingsLayer = { layer: "project", path: null, settings: null };
  if (opts.projectSlug) {
    projectLayer = readLayer(
      "project",
      projectMathranDir(opts.workspace, opts.projectSlug),
      warnings,
    );
  }
  layers.push(projectLayer);

  // Merge low → high.
  let merged: MathranSettings = {};
  if (userLayer.settings) {
    merged = mergeSettings(merged, applyUserWhitelist(userLayer.settings, warnings));
  }
  if (workspaceLayer.settings) {
    merged = mergeSettings(merged, workspaceLayer.settings);
  }
  if (projectLayer.settings) {
    merged = mergeSettings(merged, projectLayer.settings);
  }

  return { settings: merged, warnings, layers };
}
