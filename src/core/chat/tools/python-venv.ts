/**
 * Shared helpers for the per-conversation Python tooling (gap #4).
 *
 * `run_python`, `install_python_package` all need to resolve — and lazily
 * create — a per-conversation virtualenv living under
 * `<workspace>/.mathran/python-envs/<convId>/`. Centralising it here keeps the
 * three tools in sync (one place computes the path, one place runs
 * `python3 -m venv`, one place tracks the installed-package manifest).
 *
 * mathran runs on a bare host (no docker sandbox like mathub), so the venv is
 * a normal CPython venv created with the host `python3`. Each conversation gets
 * its own venv so package installs don't leak across conversations.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Resolved venv layout for a conversation. */
export interface VenvPaths {
  /** `<workspace>/.mathran/python-envs/<convId>/` */
  venvDir: string;
  /** `<venvDir>/bin/python` */
  pythonBin: string;
  /** `<venvDir>/bin/pip` */
  pipBin: string;
  /** `<venvDir>/.mathran-manifest.json` — installed package bookkeeping. */
  manifestPath: string;
}

/** Compute the venv layout for `workspace` + `convId` (no I/O). */
export function venvPaths(workspace: string, convId: string): VenvPaths {
  const venvDir = path.join(
    workspace,
    ".mathran",
    "python-envs",
    convId,
  );
  return {
    venvDir,
    pythonBin: path.join(venvDir, "bin", "python"),
    pipBin: path.join(venvDir, "bin", "pip"),
    manifestPath: path.join(venvDir, ".mathran-manifest.json"),
  };
}

/** Minimal result for a spawned helper process. */
export interface ProcResult {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: Error | null;
}

/**
 * Run a command (no shell — array args) with a timeout + output cap. Shared by
 * the python tools so they all behave identically around kill/cap/timeout. The
 * SIGTERM→SIGKILL escalation mirrors `bash.ts`.
 */
export function runProc(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; maxOutputBytes: number; cwd?: string },
): Promise<ProcResult> {
  return new Promise<ProcResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTrunc = false;
    let stderrTrunc = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    const cap = opts.maxOutputBytes;

    const append = (which: "out" | "err", chunk: Buffer) => {
      if (which === "out") {
        stdoutBytes += chunk.length;
        if (stdoutTrunc) return;
        if (stdout.length + chunk.length > cap) {
          stdout += chunk.subarray(0, Math.max(0, cap - stdout.length)).toString("utf-8");
          stdoutTrunc = true;
        } else {
          stdout += chunk.toString("utf-8");
        }
      } else {
        stderrBytes += chunk.length;
        if (stderrTrunc) return;
        if (stderr.length + chunk.length > cap) {
          stderr += chunk.subarray(0, Math.max(0, cap - stderr.length)).toString("utf-8");
          stderrTrunc = true;
        } else {
          stderr += chunk.toString("utf-8");
        }
      }
    };

    let child;
    try {
      child = spawn(cmd, args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: process.env,
      });
    } catch (err) {
      resolve({
        exit: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best-effort */
        }
      }, 500).unref();
    }, opts.timeoutMs);
    timer.unref();

    child.stdout?.on("data", (c: Buffer) => append("out", c));
    child.stderr?.on("data", (c: Buffer) => append("err", c));
    child.on("error", (err) => {
      spawnError = err;
      clearTimeout(timer);
      resolve({
        exit: -1,
        stdout: stdoutTrunc ? `${stdout}\n[...truncated (${stdoutBytes} bytes)]` : stdout,
        stderr: stderrTrunc ? `${stderr}\n[...truncated (${stderrBytes} bytes)]` : stderr,
        timedOut,
        spawnError,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit: typeof code === "number" ? code : -1,
        stdout: stdoutTrunc ? `${stdout}\n[...truncated (${stdoutBytes} bytes)]` : stdout,
        stderr: stderrTrunc ? `${stderr}\n[...truncated (${stderrBytes} bytes)]` : stderr,
        timedOut,
        spawnError,
      });
    });
  });
}

/** Whether `python3` resolves on the host PATH. */
export async function python3OnPath(): Promise<boolean> {
  const res = await runProc("python3", ["--version"], {
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
  });
  return res.spawnError === null && res.exit === 0;
}

export interface EnsureVenvResult extends VenvPaths {
  /** True when this call created the venv (vs. reusing an existing one). */
  created: boolean;
}

/**
 * Ensure the per-conversation venv exists, creating it lazily with
 * `python3 -m venv`. Idempotent — an existing venv (detected by the presence of
 * its `python` binary) is reused untouched. Throws on failure with a friendly
 * message (no `python3` on PATH, or venv creation failed).
 */
export async function ensureVenv(
  workspace: string,
  convId: string,
): Promise<EnsureVenvResult> {
  const paths = venvPaths(workspace, convId);

  let exists = false;
  try {
    await fs.access(paths.pythonBin);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    return { ...paths, created: false };
  }

  if (!(await python3OnPath())) {
    throw new Error(
      "python3 not found on PATH — cannot create a virtualenv",
    );
  }

  await fs.mkdir(path.dirname(paths.venvDir), { recursive: true });
  const res = await runProc("python3", ["-m", "venv", paths.venvDir], {
    timeoutMs: 120_000,
    maxOutputBytes: 32 * 1024,
  });
  if (res.spawnError) {
    throw new Error(`failed to spawn python3: ${res.spawnError.message}`);
  }
  if (res.exit !== 0) {
    throw new Error(
      `python3 -m venv failed (exit ${res.exit}):\n${res.stderr || res.stdout}`,
    );
  }
  return { ...paths, created: true };
}

/** Read the installed-package manifest (best-effort; missing → empty). */
export async function readManifest(
  manifestPath: string,
): Promise<Record<string, true>> {
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, true>;
  } catch {
    /* missing or corrupt → treat as empty */
  }
  return {};
}

/** Persist the installed-package manifest. */
export async function writeManifest(
  manifestPath: string,
  manifest: Record<string, true>,
): Promise<void> {
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
}
