/**
 * Sandbox capability detection.
 *
 * Probes the host for:
 *   - platform === "linux"
 *   - `bwrap` on PATH and minimally executable
 *   - Landlock LSM (v3) support (best-effort heuristic, parked for v2)
 *
 * Cached at module scope — `detectSandboxCapabilities()` runs once, returns
 * the same object thereafter so tools don't pay process-fork cost on every
 * call. Tests can reset via `_resetSandboxDetectionCache`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SandboxCapabilities } from "./types.js";

let cached: SandboxCapabilities | null = null;

/** Find an executable on `PATH` — pure Node, no shell, no extra deps. */
export function whichSync(bin: string, envPath?: string): string | null {
  const PATH = envPath ?? process.env.PATH ?? "";
  if (!PATH) return null;
  const dirs = PATH.split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const candidate = path.join(d, bin);
    try {
      const st = fs.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* skip */
    }
  }
  return null;
}

/** Probe `bwrap --version` to make sure the binary actually runs. */
function probeBwrap(bwrapPath: string | null): boolean {
  if (!bwrapPath) return false;
  try {
    const res = spawnSync(bwrapPath, ["--version"], {
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Probe whether bwrap can actually create a user namespace on this host.
 *
 * Ubuntu 24.04 ships `kernel.apparmor_restrict_unprivileged_userns=1`
 * which makes `bwrap --unshare-user` fail with "setting up uid map:
 * Permission denied" unless bwrap has its own AppArmor profile. There's
 * no way to detect this from `--version` alone, so we issue a trivial
 * `bwrap --unshare-user true` and check the exit code.
 *
 * Runs once at startup as part of detectSandboxCapabilities so we know,
 * BEFORE the first tool call, whether sandboxing will actually work.
 */
function probeBwrapUserns(bwrapPath: string | null): boolean {
  if (!bwrapPath) return false;
  try {
    // 2026-06-30 — capture stderr so we can distinguish two failure modes:
    //   1. "setting up uid map: Permission denied" → AppArmor / userns
    //      restriction → userns DOES NOT work.
    //   2. "execvp /bin/true: No such file or directory" → bwrap got
    //      far enough to enter the empty jail and *try* to exec — i.e.
    //      userns DOES work; we just didn't bind /bin.
    // The bare exit code is ambiguous (both fail = exit 1).
    const res = spawnSync(
      bwrapPath,
      ["--unshare-user", "--die-with-parent", "--", "/bin/true"],
      { timeout: 5_000, stdio: ["ignore", "ignore", "pipe"] },
    );
    if (res.status === 0) return true;
    const stderr = res.stderr?.toString("utf-8") ?? "";
    // Userns was created but the inner exec missed (expected on a probe
    // without `--bind`). That's enough to know we'd succeed once we
    // bind paths in for real.
    if (/execvp.*No such file or directory/i.test(stderr)) return true;
    // Any other failure (notably "setting up uid map: Permission denied")
    // means the kernel rejected the unshare.
    return false;
  } catch {
    return false;
  }
}

/**
 * Probe Landlock LSM availability. v1 only reports the result; actual
 * `landlock_restrict_self` plumbing lands in v2 (would need an N-API
 * binding or a syscall via `process.binding("os")`).
 *
 * Heuristic:
 *   1. Kernel version ≥ 6.7 — Landlock v3 introduced.
 *   2. `/sys/kernel/security/lsm` contains `landlock`.
 *
 * Either condition met → return true.
 */
function probeLandlock(): boolean {
  if (process.platform !== "linux") return false;

  // Kernel version check
  try {
    const release = os.release(); // e.g. "6.14.0-1017-azure"
    const m = /^(\d+)\.(\d+)/.exec(release);
    if (m) {
      const major = parseInt(m[1]!, 10);
      const minor = parseInt(m[2]!, 10);
      if (major > 6 || (major === 6 && minor >= 7)) return true;
    }
  } catch {
    /* fall through */
  }

  // LSM list check (Ubuntu 24.04 exposes /sys/kernel/security/lsm)
  try {
    const lsm = fs.readFileSync("/sys/kernel/security/lsm", "utf-8");
    if (lsm.includes("landlock")) return true;
  } catch {
    /* missing /sys/kernel/security/lsm — fine */
  }

  return false;
}

/**
 * Detect sandbox capabilities. Idempotent: first call probes, subsequent
 * calls return the cached object.
 *
 * Options:
 *   - `force` re-runs the probe (used by tests).
 */
export function detectSandboxCapabilities(opts?: {
  force?: boolean;
}): SandboxCapabilities {
  if (cached && !opts?.force) return cached;

  const linux = process.platform === "linux";
  const bwrapPath = linux ? whichSync("bwrap") : null;
  const bwrapWorks = probeBwrap(bwrapPath);
  // 2026-06-30 — separate binary-works from userns-works probe.
  // Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1`
  // makes `bwrap --version` succeed but `bwrap --unshare-user …` fail
  // with EPERM. Without this probe the sandbox would happily think
  // it's engaged and every spawn would 0-exit with no useful work
  // done. Probing once at startup keeps the hot path branch-free.
  const bwrapUserns = bwrapWorks ? probeBwrapUserns(bwrapPath) : false;
  const landlockSupported = probeLandlock();

  cached = {
    linux,
    bwrapPath,
    bwrapWorks,
    bwrapUserns,
    landlockSupported,
    warnedFallback: false,
  };
  return cached;
}

/**
 * Mark that the fallback warning has fired so subsequent spawns don't
 * spam stderr.
 */
export function markFallbackWarned(): void {
  const caps = detectSandboxCapabilities();
  caps.warnedFallback = true;
}

/** Test helper — flush the cached detection result. */
export function _resetSandboxDetectionCache(): void {
  cached = null;
}
