/**
 * Built-in `run_python` tool (gap #4).
 *
 * Execute a Python snippet inside the conversation's own virtualenv
 * (`<workspace>/.mathran/python-envs/<convId>/`, created lazily). Optional
 * `needs` declares pip packages that are installed (diffed against a per-venv
 * manifest so repeat calls are fast) before the code runs.
 *
 * mathran runs on a bare host (unlike mathub's docker sandbox), so this is a
 * direct host execution: `<venv>/bin/python -c <code>` with no shell, an
 * Abortable timeout, and capped output — same safety posture as `bash.ts`.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import {
  ensureVenv,
  runProc,
  readManifest,
  writeManifest,
} from "./python-venv.js";

export interface RunPythonToolOptions {
  workspace?: string;
  /** Conversation id this tool is bound to (injected by the session). */
  conversationId?: string;
  /** Output cap per stream in bytes (default 32 KiB). */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 600;
const DEFAULT_MAX_OUTPUT = 32 * 1024;

export function createRunPythonTool(
  opts: RunPythonToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  const conversationId = opts.conversationId;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return {
    name: "run_python",
    riskClass: "exec",
    description:
      "Run a Python snippet inside this conversation's isolated virtualenv " +
      "(created lazily on first use and reused across turns). Optionally declare " +
      "pip packages via `needs` — they are installed before the code runs. " +
      "Captures stdout + stderr (each capped at ~32 KiB). Default timeout 60 s.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python source to execute via `python -c`.",
        },
        timeoutSec: {
          type: "number",
          description: `Per-call timeout in seconds (max ${MAX_TIMEOUT_SEC}). Defaults to ${DEFAULT_TIMEOUT_SEC}.`,
        },
        needs: {
          type: "array",
          items: { type: "string" },
          description:
            "pip packages required by the code. Installed (and cached) into the venv before running.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const code = typeof args.code === "string" ? args.code : "";
      if (!code.trim()) {
        return { ok: false, content: "error: run_python requires 'code'" };
      }
      if (!conversationId) {
        return {
          ok: false,
          content: "error: run_python has no conversationId set",
        };
      }
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return { ok: false, content: "error: run_python has no workspace" };
      }
      const needs = Array.isArray(args.needs)
        ? args.needs.filter((n): n is string => typeof n === "string" && n.trim() !== "")
        : [];
      const rawTimeout =
        typeof args.timeoutSec === "number" && Number.isFinite(args.timeoutSec)
          ? args.timeoutSec
          : DEFAULT_TIMEOUT_SEC;
      const timeoutMs =
        Math.max(1, Math.min(rawTimeout, MAX_TIMEOUT_SEC)) * 1000;

      let venv;
      try {
        venv = await ensureVenv(workspace, conversationId);
      } catch (err: any) {
        return {
          ok: false,
          content: `run_python error: ${err?.message ?? String(err)}`,
        };
      }

      // Install any not-yet-recorded `needs` (diffed against the manifest so
      // repeat invocations skip pip entirely).
      if (needs.length > 0) {
        const manifest = await readManifest(venv.manifestPath);
        const missing = needs.filter((n) => !manifest[n]);
        if (missing.length > 0) {
          const pip = await runProc(
            venv.pipBin,
            ["install", ...missing],
            { timeoutMs: 300_000, maxOutputBytes },
          );
          if (pip.spawnError) {
            return {
              ok: false,
              content: `run_python error: pip failed to spawn: ${pip.spawnError.message}`,
            };
          }
          if (pip.exit !== 0) {
            return {
              ok: false,
              content:
                `run_python error: pip install ${missing.join(" ")} failed (exit ${pip.exit})\n` +
                `${pip.stdout}\n${pip.stderr}`,
            };
          }
          for (const m of missing) manifest[m] = true;
          await writeManifest(venv.manifestPath, manifest);
        }
      }

      const res = await runProc(venv.pythonBin, ["-c", code], {
        timeoutMs,
        maxOutputBytes,
      });
      if (res.spawnError) {
        return {
          ok: false,
          content: `run_python error: failed to spawn python: ${res.spawnError.message}`,
        };
      }

      const header = res.timedOut
        ? `run_python: timed out after ${timeoutMs}ms (exit ${res.exit})`
        : `exit: ${res.exit}`;
      const body = [
        header,
        "stdout:",
        res.stdout,
        "stderr:",
        res.stderr,
      ].join("\n");
      const ok = !res.timedOut && res.exit === 0;
      return { ok, content: body };
    },
  };
}
