/**
 * Linux Sandbox v1 — public types.
 *
 * Mathran's sandbox is an OS-level isolation layer around mutating tools
 * (`bash`, `run_python`, `run_latex`, `lean_check`) and net-class tools
 * (`search_web` / `search_arxiv` / `web_fetch`).
 *
 * Two layers on Linux:
 *   1. **Bubblewrap** (mandatory) — fs / pid / net namespace isolation via
 *      `bwrap`. Workspace is bind-mounted (RW or RO depending on profile),
 *      a fresh `/tmp` tmpfs is mounted, `/proc` is fresh, and the network
 *      namespace is unshared for non-`network` profiles.
 *   2. **Landlock** (optional) — kernel-level path-deny LSM. Layered on top
 *      of bwrap when the kernel supports LSM v3 (Linux 6.7+, full v3 at 6.14).
 *      v1 only wires bwrap; Landlock detection is plumbed for v2 follow-ups.
 *
 * On macOS / Windows / Linux without bwrap, every profile transparently
 * falls back to a raw `child_process.spawn` (with `console.warn` once) so
 * existing users see zero behaviour change when `sandbox.enabled !== true`.
 *
 * Profiles (parity with Codex `SandboxPolicy`):
 *   - `workspace-write`  RW workspace, RO `/usr /etc /home/$U/.cache/uv …`,
 *                        tmpfs `/tmp`, **no network**. The default for
 *                        write-class tools (`bash`, `run_python`,
 *                        `run_latex`, `lean_check`).
 *   - `workspace-read`   RO whole fs, no network. For pure read-only tools
 *                        that still benefit from blast-radius reduction.
 *   - `network`          RW workspace + **network kept**. For `search_web`,
 *                        `search_arxiv`, `web_fetch` which legitimately
 *                        need to hit the internet.
 *   - `disabled`         Escape hatch + non-Linux fallback. spawnSandboxed
 *                        degrades to plain `spawn`.
 */

import type { Readable, Writable } from "node:stream";

/** A sandbox profile name — matches `SandboxConfig.defaultProfile`. */
export type SandboxKind =
  | "workspace-write"
  | "workspace-read"
  | "network"
  | "disabled";

/**
 * Per-call sandbox parameters. Only `kind` is required at the call site;
 * everything else is filled from `SandboxConfig` defaults.
 */
export interface SandboxRequest {
  /** Which profile to apply. */
  kind: SandboxKind;
  /** Workspace root — bind-mounted RW (workspace-write/network) or RO. */
  workspace: string;
  /** Per-call extra RO bind paths (merged with `SandboxConfig.extraReadOnlyPaths`). */
  extraReadOnlyPaths?: string[];
  /** Per-call extra RW bind paths (merged with `SandboxConfig.extraReadWritePaths`). */
  extraReadWritePaths?: string[];
  /** Working directory inside the sandbox (must resolve under a bound path). */
  cwd?: string;
}

/**
 * Static configuration loaded from `settings.json#sandbox` (see
 * `src/core/sandbox/settings.ts`). All fields are optional in JSON; this
 * shape is the post-load (defaults-applied) form.
 */
export interface SandboxConfig {
  /** Master switch. Default `false` — v1 ships opt-in for zero-risk rollout. */
  enabled: boolean;
  /**
   * Profile used when a tool calls `spawnSandboxed` with `kind` omitted.
   * Default `"workspace-write"`. Note: per-tool wiring already passes an
   * explicit `kind`, so this only affects ad-hoc callers.
   */
  defaultProfile: SandboxKind;
  /**
   * Extra RO bind paths applied to every profile. Tilde (`~`) is expanded
   * at load time. Missing paths are silently skipped (a warning is
   * collected in `loadSandboxConfig`).
   */
  extraReadOnlyPaths: string[];
  /** Extra RW bind paths applied to every profile (defaults `[]`). */
  extraReadWritePaths: string[];
}

/** Sensible defaults — used when `settings.json` has no `sandbox` block. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: false,
  defaultProfile: "workspace-write",
  extraReadOnlyPaths: ["~/.cache/uv", "~/.elan", "~/.cache/pip"],
  extraReadWritePaths: [],
};

/**
 * Detected host capabilities — fills in once at startup, then cached.
 */
export interface SandboxCapabilities {
  /** True on Linux. macOS / Windows always false. */
  linux: boolean;
  /** Path to `bwrap` if found on PATH (else null). */
  bwrapPath: string | null;
  /** Whether `bwrap --version` actually executes. */
  bwrapWorks: boolean;
  /**
   * 2026-06-30 — whether `bwrap --unshare-user` actually creates a user
   * namespace. **This is the field tools should check before claiming
   * sandbox is engaged**: on Ubuntu 24.04 the binary works (bwrapWorks)
   * but `sysctl kernel.apparmor_restrict_unprivileged_userns=1` blocks
   * the actual unshare with "setting up uid map: Permission denied". A
   * `bwrapPath !== null && bwrapWorks && !bwrapUserns` host needs the
   * user to run `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`
   * (or use a setuid bwrap, or a distro without the AppArmor patch).
   */
  bwrapUserns: boolean;
  /**
   * Whether the kernel exposes Landlock LSM v3 (`/proc/sys/kernel/...`
   * heuristic, and Linux ≥ 6.14 considered "full v3"). Reserved for v2 —
   * v1 does not apply landlock_restrict_self yet.
   */
  landlockSupported: boolean;
  /**
   * Cached probe results: when set, fallbacks should not warn again about
   * the same missing capability. Used by `spawnSandboxed` so the user sees
   * one console.warn per process, not one per tool call.
   */
  warnedFallback: boolean;
}

/**
 * The result handed back to callers. Mirrors `child_process.spawn`'s output
 * shape used by `bash.ts` / `python-venv.ts` so wrapping is mechanical.
 */
export interface SandboxResult {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: Error | null;
  /**
   * Reflects what actually happened — `"bwrap"` when the sandbox engaged,
   * `"raw"` when we fell back (sandbox disabled / non-Linux / bwrap
   * missing). Tests + audit logs use this to verify the sandbox engaged.
   */
  mode: "bwrap" | "raw";
}

/** Per-spawn options shared with `runProc` callers. */
export interface SandboxSpawnOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  /** Working directory for the child (workspace-relative or absolute). */
  cwd?: string;
  /** Optional env injection (defaults to inheriting `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload — forwarded to the child via `child.stdin.write`. */
  stdin?: string | Buffer;
  /** Optional pre-spawn hook for tests (receives the final argv before spawn). */
  onArgv?: (cmd: string, argv: string[]) => void;
}

/** Stream-yielding spawn helpers — not used in v1 but reserved. */
export interface SandboxStreamHandles {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
}
