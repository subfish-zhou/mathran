/**
 * Hooks v1 loader: read + merge `hooks.json` from the user + workspace layers.
 *
 *   - user:      ~/.mathran/hooks.json
 *   - workspace: <workspace>/.mathran/hooks.json
 *
 * Merge order is **user first, then workspace** — within an event matcher
 * group the workspace's entries run AFTER the user's. (Trivially extended to
 * a third "project" layer later if we want it.)
 *
 * SECURITY:
 *
 *   - `command` is resolved to an absolute path relative to the hooks.json
 *     directory (so config can use `./scripts/lint.sh`).
 *   - The resolved path MUST live inside the **workspace** (workspace hooks)
 *     or the **user mathran dir** (user hooks). Anything else is rejected
 *     with a warning so a workspace `hooks.json` can't ask us to run
 *     `/etc/something`.
 *   - We do NOT accept inline shell strings (`bash -c "..."`). v1 is "shell
 *     hook only" with the script path + arg-array model — never a shell
 *     string. This is what makes `execFile` (no shell) safe.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MATHRAN_DIR } from "../../config/mathran-root.js";
import { HOOK_V1_EVENTS, type HookV1Entry, type HookV1Event } from "./schema.js";

export interface LoadHookV1Opts {
  workspace: string;
  /** Override `$HOME` for tests. */
  home?: string;
  /** Skip the user layer entirely (tests). */
  skipUser?: boolean;
}

export interface LoadHookV1Result {
  entries: HookV1Entry[];
  warnings: string[];
}

function userHooksJson(home?: string): string {
  return path.join(home ?? os.homedir(), MATHRAN_DIR, "hooks.json");
}
function workspaceHooksJson(workspace: string): string {
  return path.join(workspace, MATHRAN_DIR, "hooks.json");
}

/** Bounded read so a 1 GB hooks.json can't OOM us. */
const HOOKS_JSON_CAP_BYTES = 256 * 1024;

interface ReadFileLayer {
  /** Absolute path of the hooks.json. */
  filePath: string;
  /** Absolute directory the script paths resolve relative to. */
  baseDir: string;
  /** Absolute directory the script paths MUST live under. */
  containmentRoot: string;
  source: HookV1Entry["source"];
}

/**
 * Read + parse a single layer's hooks.json. Soft failures (missing file,
 * malformed JSON, malformed shape) yield warnings, never throws.
 */
function readLayer(
  layer: ReadFileLayer,
  warnings: string[],
): HookV1Entry[] {
  let raw: string;
  try {
    const st = fs.statSync(layer.filePath);
    if (st.size > HOOKS_JSON_CAP_BYTES) {
      warnings.push(
        `hooks.json at ${layer.filePath} exceeds ${HOOKS_JSON_CAP_BYTES} bytes — skipped`,
      );
      return [];
    }
    raw = fs.readFileSync(layer.filePath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    warnings.push(`failed to read ${layer.filePath}: ${err?.message ?? err}`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    warnings.push(`failed to parse ${layer.filePath}: ${err?.message ?? err}`);
    return [];
  }
  if (!parsed || typeof parsed !== "object") {
    warnings.push(`${layer.filePath} is not a JSON object`);
    return [];
  }
  const hooks = (parsed as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== "object") {
    return [];
  }

  const out: HookV1Entry[] = [];
  for (const event of HOOK_V1_EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const groupRaw of groups) {
      if (!groupRaw || typeof groupRaw !== "object") continue;
      const group = groupRaw as { matcher?: unknown; hooks?: unknown };
      const matcher =
        typeof group.matcher === "string" ? group.matcher : undefined;
      const handlerList = Array.isArray(group.hooks) ? group.hooks : [];
      for (const handlerRaw of handlerList) {
        if (!handlerRaw || typeof handlerRaw !== "object") continue;
        const handler = handlerRaw as {
          type?: unknown;
          command?: unknown;
          timeout?: unknown;
        };
        // v1 supports `type: "command"` only (or omitted — defaults to command).
        if (
          handler.type !== undefined &&
          handler.type !== "command"
        ) {
          warnings.push(
            `${layer.filePath}: ${event} hook with type=${String(
              handler.type,
            )} skipped — v1 supports "command" only`,
          );
          continue;
        }
        if (typeof handler.command !== "string" || !handler.command.trim()) {
          warnings.push(
            `${layer.filePath}: ${event} hook with missing/empty command skipped`,
          );
          continue;
        }
        const rawCmd = handler.command.trim();
        // Reject inline shell strings (`bash -c "..."` etc.) — v1 only runs a
        // single absolute script path through `execFile`, no shell.
        if (/\s/.test(rawCmd) || rawCmd.includes("'") || rawCmd.includes('"')) {
          warnings.push(
            `${layer.filePath}: ${event} command "${rawCmd}" contains whitespace or quotes — ` +
              `v1 only accepts a single script path (no inline shell). Skipped.`,
          );
          continue;
        }
        const resolved = path.isAbsolute(rawCmd)
          ? path.resolve(rawCmd)
          : path.resolve(layer.baseDir, rawCmd);
        // Containment: must live under the layer's containment root.
        const rel = path.relative(layer.containmentRoot, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          warnings.push(
            `${layer.filePath}: ${event} command "${rawCmd}" resolves outside ` +
              `${layer.containmentRoot} — rejected (path traversal).`,
          );
          continue;
        }
        // Existence: warn (not fatal) if the script is missing — the user
        // may be editing in flight. Execution will fail loudly anyway.
        try {
          const st = fs.statSync(resolved);
          if (!st.isFile()) {
            warnings.push(
              `${layer.filePath}: ${event} command "${rawCmd}" is not a regular file — skipped`,
            );
            continue;
          }
        } catch {
          warnings.push(
            `${layer.filePath}: ${event} command "${rawCmd}" does not exist (will fail at runtime)`,
          );
        }
        const timeoutSec =
          typeof handler.timeout === "number" && handler.timeout > 0
            ? handler.timeout
            : undefined;
        const entry: HookV1Entry = {
          event: event as HookV1Event,
          command: resolved,
          source: layer.source,
          sourcePath: layer.filePath,
        };
        if (matcher !== undefined) entry.matcher = matcher;
        if (timeoutSec !== undefined) entry.timeoutSec = timeoutSec;
        out.push(entry);
      }
    }
  }
  return out;
}

/**
 * Load + merge user + workspace hook configs. Returns flattened entries in
 * configured order (user first, then workspace; within a layer, configured
 * order is preserved).
 */
export function loadHookV1Config(
  opts: LoadHookV1Opts,
): LoadHookV1Result {
  const warnings: string[] = [];
  const entries: HookV1Entry[] = [];

  if (!opts.skipUser) {
    const home = opts.home ?? os.homedir();
    const userBase = path.join(home, MATHRAN_DIR);
    entries.push(
      ...readLayer(
        {
          filePath: userHooksJson(home),
          baseDir: userBase,
          containmentRoot: userBase,
          source: "user",
        },
        warnings,
      ),
    );
  }
  const wsBase = path.join(opts.workspace, MATHRAN_DIR);
  entries.push(
    ...readLayer(
      {
        filePath: workspaceHooksJson(opts.workspace),
        baseDir: wsBase,
        // Workspace hooks may invoke any script anywhere inside the workspace
        // (not just under .mathran/) — but never escape it.
        containmentRoot: opts.workspace,
        source: "workspace",
      },
      warnings,
    ),
  );

  return { entries, warnings };
}
