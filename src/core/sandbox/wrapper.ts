/**
 * `spawnSandboxed` — the single entry point mutating tools call.
 *
 * Drop-in for `child_process.spawn` (and the existing `runProc` helper in
 * `python-venv.ts`): the result shape is identical, so wiring is mechanical.
 *
 * Behaviour matrix:
 *
 *   sandbox.enabled === false     → raw spawn, mode: "raw"
 *   non-Linux platform            → raw spawn, mode: "raw" + console.warn(once)
 *   Linux but no bwrap            → raw spawn, mode: "raw" + console.warn(once)
 *   Linux + bwrap + profile≠disabled → bwrap argv, mode: "bwrap"
 *   profile === "disabled" (explicit) → raw spawn, mode: "raw"
 *
 * The "warn once" semantics are tracked via `markFallbackWarned` so users
 * see ONE message per process, not one per call.
 */

import { spawn } from "node:child_process";
import {
  detectSandboxCapabilities,
  markFallbackWarned,
} from "./detect.js";
import { buildBwrapArgv } from "./bwrap.js";
import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
  type SandboxKind,
  type SandboxRequest,
  type SandboxResult,
  type SandboxSpawnOptions,
} from "./types.js";

/**
 * Inputs to a single sandboxed spawn.
 */
export interface SpawnSandboxedInput {
  /** Active sandbox config (from settings.json#sandbox + defaults). */
  config: SandboxConfig;
  /** Per-call profile (or `"disabled"` to skip the sandbox explicitly). */
  kind: SandboxKind;
  /** Workspace root — RW (write/network) or RO (read) bound. */
  workspace: string;
  /** Tool name for log/audit prefixes. */
  toolName?: string;
  /** Command to run. */
  command: string;
  /** Command arguments. */
  args: string[];
  /** Spawn options (timeout, output cap, cwd, env, stdin). */
  spawnOpts: SandboxSpawnOptions;
  /** Extra RO bind paths per-call (merged with config). */
  extraReadOnlyPaths?: string[];
  /** Extra RW bind paths per-call (merged with config). */
  extraReadWritePaths?: string[];
}

/**
 * Run `command args` inside (or around) the configured sandbox.
 *
 * Returns a {@link SandboxResult} with `mode` reflecting which path
 * actually ran. Never throws on sandbox infrastructure failure — falls
 * through to raw spawn with a console.warn.
 */
export function spawnSandboxed(
  input: SpawnSandboxedInput,
): Promise<SandboxResult> {
  const decision = resolveSandboxDecision(input);
  return decision.mode === "raw"
    ? runRaw(input, decision.reason ?? null)
    : runBwrap(input, decision);
}

interface BwrapDecision {
  mode: "bwrap";
  cmd: string;
  argv: string[];
  reason: null;
}
interface RawDecision {
  mode: "raw";
  reason: string | null;
}
type Decision = BwrapDecision | RawDecision;

/**
 * Pure decision function — picks raw vs bwrap based on config + caps.
 * Exported for tests + audit logging.
 */
export function resolveSandboxDecision(
  input: SpawnSandboxedInput,
): Decision {
  const { config, kind } = input;
  // Explicit opt-out
  if (!config.enabled) return { mode: "raw", reason: "sandbox.enabled=false" };
  if (kind === "disabled") {
    return { mode: "raw", reason: "kind=disabled" };
  }

  const caps = detectSandboxCapabilities();
  if (!caps.linux) return { mode: "raw", reason: "platform!=linux" };
  if (!caps.bwrapPath || !caps.bwrapWorks) {
    return { mode: "raw", reason: "bwrap missing or non-functional" };
  }
  // 2026-06-30 — AppArmor / userns-restriction degradation.
  // On Ubuntu 24.04+ the bwrap binary works but the kernel blocks
  // unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`).
  // Without this check spawnSandboxed would run `bwrap --unshare-user …`
  // which returns "setting up uid map: Permission denied" and an
  // unconfined exit — i.e. the sandbox would *appear* engaged but
  // actually do nothing. Falling through to raw with a clear reason
  // string is the only safe option (the alternative is silently lying
  // about isolation).
  if (!caps.bwrapUserns) {
    return {
      mode: "raw",
      reason:
        "bwrap userns blocked (likely AppArmor: try `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`)",
    };
  }

  const request: SandboxRequest = {
    kind,
    workspace: input.workspace,
    ...(input.extraReadOnlyPaths
      ? { extraReadOnlyPaths: [...config.extraReadOnlyPaths, ...input.extraReadOnlyPaths] }
      : { extraReadOnlyPaths: config.extraReadOnlyPaths }),
    ...(input.extraReadWritePaths
      ? { extraReadWritePaths: [...config.extraReadWritePaths, ...input.extraReadWritePaths] }
      : { extraReadWritePaths: config.extraReadWritePaths }),
    ...(input.spawnOpts.cwd ? { cwd: input.spawnOpts.cwd } : {}),
  };

  let built;
  try {
    built = buildBwrapArgv({
      request,
      capabilities: { bwrapPath: caps.bwrapPath },
      command: input.command,
      args: input.args,
    });
  } catch (err) {
    return {
      mode: "raw",
      reason: `bwrap argv build failed: ${(err as Error).message}`,
    };
  }
  return { mode: "bwrap", cmd: built.cmd, argv: built.argv, reason: null };
}

/**
 * Raw spawn fallback. Behaviour is identical to the existing `runProc`
 * helper in `python-venv.ts` (cap output, SIGTERM→SIGKILL on timeout).
 */
function runRaw(
  input: SpawnSandboxedInput,
  reason: string | null,
): Promise<SandboxResult> {
  maybeWarnFallback(input, reason);
  if (input.spawnOpts.onArgv) {
    input.spawnOpts.onArgv(input.command, input.args);
  }
  return runWithCaps(input.command, input.args, input.spawnOpts, "raw");
}

function runBwrap(
  input: SpawnSandboxedInput,
  decision: BwrapDecision,
): Promise<SandboxResult> {
  if (input.spawnOpts.onArgv) {
    input.spawnOpts.onArgv(decision.cmd, decision.argv);
  }
  return runWithCaps(decision.cmd, decision.argv, input.spawnOpts, "bwrap");
}

/**
 * Decide whether to emit the "sandbox requested but not engaged" warning.
 * Only warns when sandbox.enabled = true AND we still ended up in raw mode.
 */
function maybeWarnFallback(
  input: SpawnSandboxedInput,
  reason: string | null,
): void {
  if (!input.config.enabled) return; // user explicitly disabled — silent
  if (input.kind === "disabled") return; // caller explicitly disabled — silent
  if (!reason) return;
  const caps = detectSandboxCapabilities();
  if (caps.warnedFallback) return;
  markFallbackWarned();
  // eslint-disable-next-line no-console
  console.warn(
    `[sandbox] requested but falling back to raw spawn: ${reason}` +
      (input.toolName ? ` (tool=${input.toolName})` : "") +
      ` — install bwrap and re-enable sandbox to harden this call.`,
  );
}

/**
 * Common spawn+timeout+output-cap loop. Mirrors `runProc` in
 * `python-venv.ts`, but returns a `SandboxResult` with `mode`.
 */
function runWithCaps(
  cmd: string,
  args: string[],
  opts: SandboxSpawnOptions,
  mode: SandboxResult["mode"],
): Promise<SandboxResult> {
  return new Promise<SandboxResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTrunc = false;
    let stderrTrunc = false;
    let timedOut = false;
    let spawnError: Error | null = null;
    const cap = opts.maxOutputBytes;
    const env = opts.env ?? process.env;

    const append = (which: "out" | "err", chunk: Buffer) => {
      if (which === "out") {
        stdoutBytes += chunk.length;
        if (stdoutTrunc) return;
        if (stdout.length + chunk.length > cap) {
          stdout += chunk
            .subarray(0, Math.max(0, cap - stdout.length))
            .toString("utf-8");
          stdoutTrunc = true;
        } else {
          stdout += chunk.toString("utf-8");
        }
      } else {
        stderrBytes += chunk.length;
        if (stderrTrunc) return;
        if (stderr.length + chunk.length > cap) {
          stderr += chunk
            .subarray(0, Math.max(0, cap - stderr.length))
            .toString("utf-8");
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
        env,
      });
    } catch (err) {
      resolve({
        exit: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: err instanceof Error ? err : new Error(String(err)),
        mode,
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

    if (opts.stdin !== undefined && child.stdin) {
      try {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      } catch {
        /* best-effort — child may have died before stdin write */
      }
    }
    child.stdout?.on("data", (c: Buffer) => append("out", c));
    child.stderr?.on("data", (c: Buffer) => append("err", c));
    child.on("error", (err) => {
      spawnError = err;
      clearTimeout(timer);
      resolve({
        exit: -1,
        stdout: stdoutTrunc
          ? `${stdout}\n[...truncated (${stdoutBytes} bytes)]`
          : stdout,
        stderr: stderrTrunc
          ? `${stderr}\n[...truncated (${stderrBytes} bytes)]`
          : stderr,
        timedOut,
        spawnError,
        mode,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exit: typeof code === "number" ? code : -1,
        stdout: stdoutTrunc
          ? `${stdout}\n[...truncated (${stdoutBytes} bytes)]`
          : stdout,
        stderr: stderrTrunc
          ? `${stderr}\n[...truncated (${stderrBytes} bytes)]`
          : stderr,
        timedOut,
        spawnError,
        mode,
      });
    });
  });
}

/** Re-export the default config so callers don't have to import two files. */
export { DEFAULT_SANDBOX_CONFIG };
