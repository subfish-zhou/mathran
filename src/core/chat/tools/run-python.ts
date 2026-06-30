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
import {
  spawnSandboxed,
  type SandboxConfig,
  type SandboxKind,
} from "../../sandbox/index.js";

export interface RunPythonToolOptions {
  workspace?: string;
  /** Conversation id this tool is bound to (injected by the session). */
  conversationId?: string;
  /** Output cap per stream in bytes (default 32 KiB). */
  maxOutputBytes?: number;
  /**
   * 2026-06-30 — sandbox config (Bubblewrap). When `sandbox.enabled` is
   * `false` (default) the tool falls through to a raw spawn — back-compat
   * byte-for-byte. When enabled:
   *   - pip install runs with the `network` profile (must reach PyPI)
   *   - the actual `python -c <code>` runs with the configured default
   *     profile (typically `workspace-write` — no network, workspace RW,
   *     system RO). The venv lives under `<workspace>/.mathran/python-envs/`
   *     so the workspace-write bind covers it automatically.
   */
  sandbox?: SandboxConfig;
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
  const sandboxCfg = opts.sandbox;
  const useSandbox = sandboxCfg !== undefined && sandboxCfg.enabled === true;

  /**
   * 2026-06-30 — sandbox-aware spawn helper. When `useSandbox` is true,
   * route through `spawnSandboxed` with the requested profile; otherwise
   * fall through to the existing `runProc` (raw spawn). The two
   * SandboxResult / ProcResult shapes are compatible at the fields we
   * read (`exit`, `stdout`, `stderr`, `timedOut`, `spawnError`), so the
   * call sites stay unchanged.
   */
  async function runSandboxedOrRaw(
    cmd: string,
    args: string[],
    timeoutMs: number,
    kind: SandboxKind,
    workspace: string,
  ): Promise<{
    exit: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnError: Error | null;
  }> {
    if (!useSandbox) {
      return runProc(cmd, args, { timeoutMs, maxOutputBytes });
    }
    const r = await spawnSandboxed({
      config: sandboxCfg!,
      kind,
      workspace,
      toolName: "run_python",
      command: cmd,
      args,
      spawnOpts: { timeoutMs, maxOutputBytes, env: process.env },
    });
    return {
      exit: r.exit,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      spawnError: r.spawnError,
    };
  }

  return {
    name: "run_python",
    riskClass: "exec",
    readOnly: false,
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
          // pip MUST have network — use the `network` profile regardless of
          // the user's defaultProfile. The user can disable sandboxing
          // entirely (`enabled: false`) but cannot ask pip to install
          // packages without network.
          const pip = await runSandboxedOrRaw(
            venv.pipBin,
            ["install", ...missing],
            300_000,
            "network",
            workspace,
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

      // python -c <code> runs under the **default profile** (typically
      // workspace-write — no network). When the user explicitly wants the
      // python code itself to have network (e.g. fetching arxiv abstracts
      // mid-script), they can set sandbox.defaultProfile to "network", but
      // that's an explicit opt-in; the safe default is no network.
      const res = await runSandboxedOrRaw(
        venv.pythonBin,
        ["-c", code],
        timeoutMs,
        (sandboxCfg?.defaultProfile ?? "workspace-write") as SandboxKind,
        workspace,
      );
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
