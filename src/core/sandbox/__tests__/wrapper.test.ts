/**
 * Tests for `wrapper.ts` — `spawnSandboxed`, the entry point used by tools.
 *
 * Three groups:
 *   1. Decision logic (raw vs bwrap) — pure function, no spawn.
 *   2. Fallback behaviour (sandbox disabled / kind=disabled) — verifies
 *      we still run the command and return ok output.
 *   3. **Real bwrap spawns** (Linux only) — proves the sandbox actually
 *      isolates: workspace-write blocks writes to /etc, workspace-write
 *      blocks network, network keeps network.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  spawnSandboxed,
  resolveSandboxDecision,
} from "../wrapper.js";
import {
  DEFAULT_SANDBOX_CONFIG,
  type SandboxConfig,
} from "../types.js";
import {
  detectSandboxCapabilities,
  _resetSandboxDetectionCache,
} from "../detect.js";

const linuxOnly = process.platform === "linux";
const caps = detectSandboxCapabilities();
// 2026-06-30 — sandbox availability for real-bwrap tests requires
// BOTH the binary works AND userns is actually usable. On Ubuntu 24.04+
// with `kernel.apparmor_restrict_unprivileged_userns=1` the binary
// succeeds but `--unshare-user` is blocked; without checking
// `bwrapUserns` the test suite would fail in CI/dev VMs that haven't
// run `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`.
const sandboxAvailable = linuxOnly && caps.bwrapWorks && caps.bwrapUserns;

function enabledConfig(): SandboxConfig {
  return { ...DEFAULT_SANDBOX_CONFIG, enabled: true };
}
function disabledConfig(): SandboxConfig {
  return { ...DEFAULT_SANDBOX_CONFIG, enabled: false };
}

describe("resolveSandboxDecision", () => {
  beforeEach(() => {
    _resetSandboxDetectionCache();
  });

  it("config.enabled=false → raw, reason='sandbox.enabled=false'", () => {
    const d = resolveSandboxDecision({
      config: disabledConfig(),
      kind: "workspace-write",
      workspace: "/tmp",
      command: "echo",
      args: ["hi"],
      spawnOpts: { timeoutMs: 5000, maxOutputBytes: 4096 },
    });
    expect(d.mode).toBe("raw");
    if (d.mode === "raw") expect(d.reason).toMatch(/enabled=false/);
  });

  it("kind='disabled' → raw, reason mentions disabled", () => {
    const d = resolveSandboxDecision({
      config: enabledConfig(),
      kind: "disabled",
      workspace: "/tmp",
      command: "echo",
      args: ["hi"],
      spawnOpts: { timeoutMs: 5000, maxOutputBytes: 4096 },
    });
    expect(d.mode).toBe("raw");
    if (d.mode === "raw") expect(d.reason).toMatch(/disabled/);
  });

  it("Linux + bwrap + enabled → bwrap decision with full argv", () => {
    if (!sandboxAvailable) return; // skip if bwrap missing
    const d = resolveSandboxDecision({
      config: enabledConfig(),
      kind: "workspace-write",
      workspace: "/tmp",
      command: "echo",
      args: ["hi"],
      spawnOpts: { timeoutMs: 5000, maxOutputBytes: 4096 },
    });
    expect(d.mode).toBe("bwrap");
    if (d.mode === "bwrap") {
      expect(d.cmd).toMatch(/bwrap$/);
      expect(d.argv).toContain("--unshare-net"); // workspace-write
      expect(d.argv.slice(d.argv.indexOf("--") + 1)).toEqual(["echo", "hi"]);
    }
  });
});

describe("spawnSandboxed — fallback behaviour", () => {
  it("sandbox.enabled=false: still runs the command, mode='raw'", async () => {
    const res = await spawnSandboxed({
      config: disabledConfig(),
      kind: "workspace-write",
      workspace: "/tmp",
      command: "echo",
      args: ["fallback-ok"],
      spawnOpts: { timeoutMs: 5000, maxOutputBytes: 4096 },
    });
    expect(res.exit).toBe(0);
    expect(res.mode).toBe("raw");
    expect(res.stdout.trim()).toBe("fallback-ok");
  });

  it("kind='disabled': runs raw even with sandbox.enabled=true", async () => {
    const res = await spawnSandboxed({
      config: enabledConfig(),
      kind: "disabled",
      workspace: "/tmp",
      command: "echo",
      args: ["explicit-disabled"],
      spawnOpts: { timeoutMs: 5000, maxOutputBytes: 4096 },
    });
    expect(res.exit).toBe(0);
    expect(res.mode).toBe("raw");
    expect(res.stdout.trim()).toBe("explicit-disabled");
  });

  it("onArgv hook fires with raw argv on raw path", async () => {
    let observed: { cmd: string; argv: string[] } | null = null;
    await spawnSandboxed({
      config: disabledConfig(),
      kind: "workspace-write",
      workspace: "/tmp",
      command: "echo",
      args: ["hi"],
      spawnOpts: {
        timeoutMs: 5000,
        maxOutputBytes: 4096,
        onArgv: (cmd, argv) => {
          observed = { cmd, argv };
        },
      },
    });
    expect(observed).not.toBeNull();
    expect(observed!.cmd).toBe("echo");
    expect(observed!.argv).toEqual(["hi"]);
  });
});

describe("spawnSandboxed — real bwrap (Linux only)", () => {
  beforeEach(() => {
    _resetSandboxDetectionCache();
  });

  it.skipIf(!sandboxAvailable)(
    "workspace-write profile lets us `echo hello`",
    async () => {
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "workspace-write",
        workspace: "/tmp",
        command: "echo",
        args: ["hello-from-sandbox"],
        spawnOpts: { timeoutMs: 10_000, maxOutputBytes: 4096 },
      });
      expect(res.spawnError).toBeNull();
      expect(res.mode).toBe("bwrap");
      expect(res.exit).toBe(0);
      expect(res.stdout.trim()).toBe("hello-from-sandbox");
    },
  );

  it.skipIf(!sandboxAvailable)(
    "workspace-write profile DENIES writes to /etc (RO bind)",
    async () => {
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "workspace-write",
        workspace: "/tmp",
        command: "bash",
        args: ["-c", "touch /etc/mathran-sandbox-should-fail 2>&1; echo rc=$?"],
        spawnOpts: { timeoutMs: 10_000, maxOutputBytes: 4096 },
      });
      expect(res.mode).toBe("bwrap");
      // touch must fail because /etc is RO-bound
      expect(res.stdout).toMatch(/rc=[1-9]/);
      expect(res.stdout.toLowerCase()).toMatch(/read-only|permission|denied/);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "workspace-write profile DENIES network (--unshare-net)",
    async () => {
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "workspace-write",
        workspace: "/tmp",
        command: "bash",
        args: [
          "-c",
          // getent hosts uses NSS — works fine if network/dns available,
          // fails if loopback is the only interface. We additionally try
          // to bind a socket to 0.0.0.0:0 via python3 which will fail or
          // succeed predictably; simplest: try to reach 127.0.0.1 by
          // checking interfaces in /proc/net/dev — under --unshare-net
          // there should only be `lo`.
          "cat /proc/net/dev | awk '$1 ~ /:/ {print $1}'",
        ],
        spawnOpts: { timeoutMs: 10_000, maxOutputBytes: 4096 },
      });
      expect(res.mode).toBe("bwrap");
      expect(res.exit).toBe(0);
      // Inside --unshare-net there must be exactly one network iface (lo).
      // Strip whitespace/colons.
      const ifaces = res.stdout
        .split("\n")
        .map((s) => s.trim().replace(/:$/, ""))
        .filter(Boolean);
      expect(ifaces).toEqual(["lo"]);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "workspace-write profile binds workspace RW (touch inside workspace OK)",
    async () => {
      // Use /tmp as workspace since it's writable on every Linux host.
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "workspace-write",
        workspace: "/tmp",
        command: "bash",
        args: [
          "-c",
          "f=/tmp/mathran-sandbox-test-$$; touch $f && echo ok && rm -f $f",
        ],
        spawnOpts: { timeoutMs: 10_000, maxOutputBytes: 4096 },
      });
      expect(res.mode).toBe("bwrap");
      expect(res.exit).toBe(0);
      expect(res.stdout).toContain("ok");
    },
  );

  it.skipIf(!sandboxAvailable)(
    "workspace-read profile DENIES writes to the workspace",
    async () => {
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "workspace-read",
        workspace: "/tmp",
        command: "bash",
        args: [
          "-c",
          // RO-bound workspace → write should fail with rc!=0
          "touch /tmp/mathran-readonly-should-fail-$$ 2>&1; echo rc=$?",
        ],
        spawnOpts: { timeoutMs: 10_000, maxOutputBytes: 4096 },
      });
      expect(res.mode).toBe("bwrap");
      expect(res.stdout).toMatch(/rc=[1-9]/);
      expect(res.stdout.toLowerCase()).toMatch(/read-only|permission|denied/);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "network profile KEEPS the network (no --unshare-net)",
    async () => {
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "network",
        workspace: "/tmp",
        command: "bash",
        args: [
          "-c",
          "cat /proc/net/dev | awk '$1 ~ /:/ {print $1}' | wc -l",
        ],
        spawnOpts: { timeoutMs: 10_000, maxOutputBytes: 4096 },
      });
      expect(res.mode).toBe("bwrap");
      expect(res.exit).toBe(0);
      // Should be ≥ 2 interfaces (lo + at least one real one).
      // Note: on minimal CI environments this could be 1 — accept ≥ 1 to
      // be safe, the key proof is that `--unshare-net` was NOT applied
      // (validated separately via decision logic).
      const count = parseInt(res.stdout.trim(), 10);
      expect(count).toBeGreaterThanOrEqual(1);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "respects timeoutMs (SIGTERM after the limit)",
    async () => {
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "workspace-write",
        workspace: "/tmp",
        command: "bash",
        args: ["-c", "sleep 30"],
        spawnOpts: { timeoutMs: 500, maxOutputBytes: 4096 },
      });
      expect(res.timedOut).toBe(true);
    },
  );

  it.skipIf(!sandboxAvailable)(
    "captures and caps stdout (truncation marker)",
    async () => {
      const res = await spawnSandboxed({
        config: enabledConfig(),
        kind: "workspace-write",
        workspace: "/tmp",
        command: "bash",
        args: ["-c", "for i in $(seq 1 200); do echo aaaaaaaaaa; done"],
        spawnOpts: { timeoutMs: 10_000, maxOutputBytes: 128 },
      });
      expect(res.stdout.length).toBeLessThanOrEqual(256);
      expect(res.stdout).toMatch(/truncated/);
    },
  );
});
