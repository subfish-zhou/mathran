/**
 * Sandbox settings loader.
 *
 * Reads `settings.json#sandbox` from the host caller (the layered settings
 * loader already merged USER → WORKSPACE → PROJECT) and produces a
 * `SandboxConfig` with defaults filled in.
 *
 * Shape:
 *   {
 *     "sandbox": {
 *       "enabled": true,
 *       "defaultProfile": "workspace-write",
 *       "extraReadOnlyPaths": ["~/.cache/uv", "~/.elan"],
 *       "extraReadWritePaths": []
 *     }
 *   }
 *
 * The loader is *lenient*: unknown / malformed values fall back to the
 * default, with a string warning surfaced to the caller (mathran's settings
 * subsystem treats warnings as non-fatal).
 *
 * Defaults: `enabled = false`. v1 ships opt-in so existing users see zero
 * change.
 */

import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
  type SandboxKind,
} from "./types.js";
import { expandHome } from "./bwrap.js";
import * as fs from "node:fs";

const VALID_PROFILES: ReadonlyArray<SandboxKind> = [
  "workspace-write",
  "workspace-read",
  "network",
  "disabled",
];

export interface LoadSandboxConfigResult {
  config: SandboxConfig;
  warnings: string[];
}

/**
 * Coerce a raw `settings.json#sandbox` blob into a typed config.
 *
 * Any unknown / malformed field falls back to the default with a warning
 * appended to `warnings`. Returns the defaults verbatim when the blob is
 * `undefined` / `null`.
 */
export function loadSandboxConfig(
  raw: unknown,
): LoadSandboxConfigResult {
  const warnings: string[] = [];
  const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG };

  if (raw === undefined || raw === null) {
    return { config, warnings };
  }
  if (typeof raw !== "object") {
    warnings.push(
      `sandbox: settings.json#sandbox must be an object, got ${typeof raw}; using defaults.`,
    );
    return { config, warnings };
  }
  const r = raw as Record<string, unknown>;

  // enabled
  if (r.enabled !== undefined) {
    if (typeof r.enabled === "boolean") {
      config.enabled = r.enabled;
    } else {
      warnings.push(
        `sandbox: 'enabled' must be a boolean (got ${typeof r.enabled}); keeping default ${config.enabled}.`,
      );
    }
  }

  // defaultProfile
  if (r.defaultProfile !== undefined) {
    if (
      typeof r.defaultProfile === "string" &&
      (VALID_PROFILES as readonly string[]).includes(r.defaultProfile)
    ) {
      config.defaultProfile = r.defaultProfile as SandboxKind;
    } else {
      warnings.push(
        `sandbox: 'defaultProfile' must be one of ${VALID_PROFILES.join(", ")} (got ${JSON.stringify(r.defaultProfile)}); keeping default ${config.defaultProfile}.`,
      );
    }
  }

  // extraReadOnlyPaths / extraReadWritePaths — expand ~, drop non-strings
  // with a warning each.
  if (r.extraReadOnlyPaths !== undefined) {
    const arr = parseStringArray(
      r.extraReadOnlyPaths,
      "extraReadOnlyPaths",
      warnings,
    );
    if (arr) config.extraReadOnlyPaths = arr.map(expandHome);
  }
  if (r.extraReadWritePaths !== undefined) {
    const arr = parseStringArray(
      r.extraReadWritePaths,
      "extraReadWritePaths",
      warnings,
    );
    if (arr) config.extraReadWritePaths = arr.map(expandHome);
  }

  // Filesystem-existence warnings (best-effort — paths may legitimately
  // be created later, so we warn but keep them in config).
  for (const p of config.extraReadOnlyPaths) {
    if (!safeExists(p)) {
      warnings.push(
        `sandbox: extraReadOnlyPaths entry '${p}' does not exist — it will be silently skipped at sandbox time.`,
      );
    }
  }
  for (const p of config.extraReadWritePaths) {
    if (!safeExists(p)) {
      warnings.push(
        `sandbox: extraReadWritePaths entry '${p}' does not exist — it will be silently skipped at sandbox time.`,
      );
    }
  }

  return { config, warnings };
}

function parseStringArray(
  v: unknown,
  field: string,
  warnings: string[],
): string[] | null {
  if (!Array.isArray(v)) {
    warnings.push(
      `sandbox: '${field}' must be an array of strings (got ${typeof v}); ignoring.`,
    );
    return null;
  }
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === "string" && entry.trim()) {
      out.push(entry);
    } else {
      warnings.push(
        `sandbox: '${field}' contains non-string entry ${JSON.stringify(entry)} — dropped.`,
      );
    }
  }
  return out;
}

function safeExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
