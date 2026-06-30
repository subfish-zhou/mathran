/**
 * Build a `bwrap` argv for a given sandbox profile.
 *
 * The argv pattern mirrors Codex' `linux-sandbox/src/bwrap.rs` but lives
 * here in TypeScript so we don't carry the Rust helper across hosts.
 *
 * Layout for every profile (always present):
 *   bwrap                                       (executable)
 *     --new-session                             new session (no terminal CTL)
 *     --die-with-parent                         die with us
 *     --unshare-user                            fresh user namespace
 *     --unshare-pid                             fresh PID namespace
 *     --unshare-ipc                             fresh IPC namespace
 *     --unshare-uts                             fresh UTS namespace
 *     --unshare-cgroup-try                      try fresh cgroup ns (best-effort)
 *     --proc /proc                              fresh /proc
 *     --dev /dev                                minimal /dev
 *     --tmpfs /tmp                              fresh /tmp tmpfs
 *     --setenv HOME /tmp                        sane HOME inside sandbox
 *     --setenv TMPDIR /tmp                      sane TMPDIR
 *
 * Then per-profile fs binds (added in dependency order to keep bwrap happy:
 * binds resolve in argv order; nested binds need the parent to be there
 * already):
 *
 *   workspace-write:
 *     --ro-bind /usr /usr
 *     --ro-bind /etc /etc
 *     --ro-bind /bin /bin                       (if exists, may be a symlink)
 *     --ro-bind /lib /lib
 *     --ro-bind /lib64 /lib64                   (if exists)
 *     --ro-bind /opt /opt                       (if exists — Lean elan etc.)
 *     --ro-bind <extraRO> <extraRO>             (each)
 *     --bind <workspace> <workspace>
 *     --bind <extraRW> <extraRW>                (each)
 *     --unshare-net                             ❌ no network
 *
 *   workspace-read:
 *     same as workspace-write except --bind <workspace> becomes --ro-bind
 *     --unshare-net                             ❌ no network
 *
 *   network:
 *     same as workspace-write — but **no** --unshare-net (network stays)
 *     /etc/resolv.conf etc. come along via the /etc RO bind.
 *
 *   disabled: throws — callers must check `sandbox.enabled` first.
 *
 * The final argv ends with `-- <cmd> <args...>`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  SandboxCapabilities,
  SandboxKind,
  SandboxRequest,
} from "./types.js";

/**
 * Base system paths bind-mounted RO in every "workspace-*" / "network"
 * profile. Each path is bind-mounted only if it exists on the host so
 * minimal containers still work (e.g. `/lib64` doesn't exist on every
 * distro).
 */
const SYSTEM_RO_BINDS: ReadonlyArray<string> = [
  "/usr",
  "/etc",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/opt", // Lean / elan / texlive
  "/var/lib", // texlive font caches etc.
  // 2026-06-30 — DNS resolution. On systemd-resolved hosts (Ubuntu 18+)
  // `/etc/resolv.conf` is a symlink into `/run/systemd/resolve/stub-resolv.conf`.
  // Without `/run` bound the symlink dangles inside the jail and every
  // `curl https://…` returns http=000 (DNS lookup fails). With `network`
  // profile we want curl to actually work, so bind `/run` RO. We bind the
  // whole `/run` rather than the specific subpath because some distros
  // park the stub elsewhere (e.g. `/run/NetworkManager/resolv.conf`) and
  // `/run` is small (mostly pid files + tiny daemon sockets).
  "/run",
];

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Whether a path exists on the host. */
function existsSync(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface BwrapArgvOpts {
  /** Sandbox request (kind + workspace + extras). */
  request: SandboxRequest;
  /** Detected capabilities (used for bwrap path). */
  capabilities: Pick<SandboxCapabilities, "bwrapPath">;
  /** Command to run inside the sandbox. */
  command: string;
  /** Arguments to that command. */
  args: string[];
  /**
   * When true, skip the "path exists" check (used by unit tests so argv
   * shape is deterministic across hosts).
   */
  skipExistsCheck?: boolean;
}

export interface BwrapArgvResult {
  /** Final executable: `bwrap` path. */
  cmd: string;
  /** Full argv (excluding `cmd`). */
  argv: string[];
  /** Profile applied — sanity-check field. */
  kind: Exclude<SandboxKind, "disabled">;
  /** Whether network was unshared. */
  networkUnshared: boolean;
}

/**
 * Build the argv for a non-`disabled` profile. Callers must already have
 * resolved `disabled` → raw spawn before invoking this.
 */
export function buildBwrapArgv(opts: BwrapArgvOpts): BwrapArgvResult {
  const { request, capabilities, command, args } = opts;
  if (request.kind === "disabled") {
    throw new Error(
      "buildBwrapArgv called with kind='disabled' — caller should fall through to raw spawn",
    );
  }
  if (!capabilities.bwrapPath) {
    throw new Error("buildBwrapArgv requires capabilities.bwrapPath");
  }
  const skipExists = opts.skipExistsCheck === true;
  const exists = (p: string): boolean => (skipExists ? true : existsSync(p));

  const argv: string[] = [];

  // Namespace + lifecycle skeleton.
  argv.push("--new-session");
  argv.push("--die-with-parent");
  argv.push("--unshare-user");
  argv.push("--unshare-pid");
  argv.push("--unshare-ipc");
  argv.push("--unshare-uts");
  argv.push("--unshare-cgroup-try");

  // /proc, /dev, /tmp — synthetic mounts that don't depend on host binds.
  argv.push("--proc", "/proc");
  argv.push("--dev", "/dev");
  argv.push("--tmpfs", "/tmp");

  // Env defaults — keep HOME inside /tmp so caches don't leak to the host.
  argv.push("--setenv", "HOME", "/tmp");
  argv.push("--setenv", "TMPDIR", "/tmp");
  argv.push("--setenv", "USER", "sandbox");

  // System RO binds (skip non-existent paths so containers etc. still work).
  for (const p of SYSTEM_RO_BINDS) {
    if (exists(p)) argv.push("--ro-bind", p, p);
  }

  // Extra RO binds from settings + per-request, with `~` expansion and
  // dedup. Missing paths get silently skipped — `loadSandboxConfig` already
  // warned about them at load time.
  const extraRO = new Set<string>();
  for (const p of request.extraReadOnlyPaths ?? []) {
    const ex = expandHome(p);
    if (exists(ex)) extraRO.add(ex);
  }
  for (const p of extraRO) argv.push("--ro-bind", p, p);

  // Workspace bind — RW for write/network profiles, RO for read profile.
  const workspace = path.resolve(request.workspace);
  const workspaceFlag =
    request.kind === "workspace-read" ? "--ro-bind" : "--bind";
  argv.push(workspaceFlag, workspace, workspace);

  // Extra RW binds — only meaningful for non-read profiles. (We still
  // allow them on `workspace-read` because the caller asked for them
  // explicitly; bwrap will happily oblige.)
  const extraRW = new Set<string>();
  for (const p of request.extraReadWritePaths ?? []) {
    const ex = expandHome(p);
    if (exists(ex)) extraRW.add(ex);
  }
  for (const p of extraRW) argv.push("--bind", p, p);

  // Network — share for `network`, unshare for the other two.
  const networkUnshared = request.kind !== "network";
  if (networkUnshared) {
    argv.push("--unshare-net");
  }

  // Optional chdir inside the sandbox. If unset, bwrap inherits cwd which
  // works fine for our case (the helper process runs with cwd already
  // inside the workspace).
  if (request.cwd) {
    const cwdAbs = path.isAbsolute(request.cwd)
      ? request.cwd
      : path.resolve(workspace, request.cwd);
    argv.push("--chdir", cwdAbs);
  }

  // End of bwrap flags; everything after `--` is the actual command.
  argv.push("--");
  argv.push(command);
  for (const a of args) argv.push(a);

  return {
    cmd: capabilities.bwrapPath,
    argv,
    kind: request.kind,
    networkUnshared,
  };
}

/**
 * Convenience — return the system RO bind list (for tests / docs).
 */
export function systemReadOnlyBinds(): ReadonlyArray<string> {
  return SYSTEM_RO_BINDS;
}
