/**
 * Tests for `bwrap.ts` argv builder.
 *
 * Focus: deterministic argv shape per profile, fs-bind plumbing, and
 * --unshare-net presence per profile. We use `skipExistsCheck: true` so
 * argv shape is stable across hosts (CI / dev / containers).
 */

import { describe, expect, it } from "vitest";
import {
  buildBwrapArgv,
  expandHome,
  systemReadOnlyBinds,
} from "../bwrap.js";

const FAKE_BWRAP = "/usr/bin/bwrap";

describe("buildBwrapArgv", () => {
  it("workspace-write: binds workspace RW, unshare-net, tmpfs /tmp, fresh /proc", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: { kind: "workspace-write", workspace: "/ws" },
      command: "bash",
      args: ["-lc", "echo hi"],
      skipExistsCheck: true,
    });
    expect(r.cmd).toBe(FAKE_BWRAP);
    expect(r.kind).toBe("workspace-write");
    expect(r.networkUnshared).toBe(true);

    // Core flags present
    expect(r.argv).toContain("--new-session");
    expect(r.argv).toContain("--die-with-parent");
    expect(r.argv).toContain("--unshare-user");
    expect(r.argv).toContain("--unshare-pid");
    expect(r.argv).toContain("--unshare-net");

    // /proc, /dev, /tmp synthetic mounts
    expectPair(r.argv, "--proc", "/proc");
    expectPair(r.argv, "--dev", "/dev");
    expectPair(r.argv, "--tmpfs", "/tmp");

    // Workspace bound RW
    expectTriple(r.argv, "--bind", "/ws", "/ws");

    // Command after `--`
    const dashIdx = r.argv.indexOf("--");
    expect(dashIdx).toBeGreaterThan(0);
    expect(r.argv.slice(dashIdx + 1)).toEqual(["bash", "-lc", "echo hi"]);
  });

  it("workspace-read: binds workspace RO (--ro-bind not --bind) and unshares net", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: { kind: "workspace-read", workspace: "/ws" },
      command: "cat",
      args: ["/ws/file.txt"],
      skipExistsCheck: true,
    });
    expect(r.networkUnshared).toBe(true);
    expect(r.argv).toContain("--unshare-net");

    // Workspace must be RO
    expectTriple(r.argv, "--ro-bind", "/ws", "/ws");
    // ...and NOT also bound RW
    expect(hasTriple(r.argv, "--bind", "/ws", "/ws")).toBe(false);
  });

  it("network: keeps net (no --unshare-net), workspace stays RW", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: { kind: "network", workspace: "/ws" },
      command: "curl",
      args: ["https://example.com"],
      skipExistsCheck: true,
    });
    expect(r.networkUnshared).toBe(false);
    expect(r.argv).not.toContain("--unshare-net");
    expectTriple(r.argv, "--bind", "/ws", "/ws");
  });

  it("throws when kind=disabled (callers must handle fallthrough)", () => {
    expect(() =>
      buildBwrapArgv({
        capabilities: { bwrapPath: FAKE_BWRAP },
        request: { kind: "disabled", workspace: "/ws" },
        command: "bash",
        args: [],
        skipExistsCheck: true,
      }),
    ).toThrow(/disabled/);
  });

  it("throws when bwrapPath missing (defensive — caller bug)", () => {
    expect(() =>
      buildBwrapArgv({
        capabilities: { bwrapPath: null },
        request: { kind: "workspace-write", workspace: "/ws" },
        command: "bash",
        args: [],
        skipExistsCheck: true,
      }),
    ).toThrow(/bwrapPath/);
  });

  it("extraReadOnlyPaths and extraReadWritePaths are bound with the right flags", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: {
        kind: "workspace-write",
        workspace: "/ws",
        extraReadOnlyPaths: ["/ro1", "/ro2"],
        extraReadWritePaths: ["/rw1"],
      },
      command: "bash",
      args: [],
      skipExistsCheck: true,
    });
    expectTriple(r.argv, "--ro-bind", "/ro1", "/ro1");
    expectTriple(r.argv, "--ro-bind", "/ro2", "/ro2");
    expectTriple(r.argv, "--bind", "/rw1", "/rw1");
  });

  it("env defaults: HOME=/tmp, TMPDIR=/tmp, USER=sandbox", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: { kind: "workspace-write", workspace: "/ws" },
      command: "bash",
      args: [],
      skipExistsCheck: true,
    });
    expectTriple(r.argv, "--setenv", "HOME", "/tmp");
    expectTriple(r.argv, "--setenv", "TMPDIR", "/tmp");
    expectTriple(r.argv, "--setenv", "USER", "sandbox");
  });

  it("cwd flag is added when SandboxRequest.cwd is set", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: { kind: "workspace-write", workspace: "/ws", cwd: "/ws/sub" },
      command: "ls",
      args: [],
      skipExistsCheck: true,
    });
    expectPair(r.argv, "--chdir", "/ws/sub");
  });

  it("relative cwd is resolved against workspace", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: { kind: "workspace-write", workspace: "/ws", cwd: "sub/dir" },
      command: "ls",
      args: [],
      skipExistsCheck: true,
    });
    expectPair(r.argv, "--chdir", "/ws/sub/dir");
  });

  it("system RO binds list is non-empty (sanity)", () => {
    const binds = systemReadOnlyBinds();
    expect(binds.length).toBeGreaterThan(2);
    expect(binds).toContain("/usr");
    expect(binds).toContain("/etc");
  });

  it("system RO binds appear when they exist on host (skipExistsCheck=true → all appear)", () => {
    const r = buildBwrapArgv({
      capabilities: { bwrapPath: FAKE_BWRAP },
      request: { kind: "workspace-write", workspace: "/ws" },
      command: "bash",
      args: [],
      skipExistsCheck: true,
    });
    for (const sysPath of systemReadOnlyBinds()) {
      expectTriple(r.argv, "--ro-bind", sysPath, sysPath);
    }
  });
});

describe("expandHome", () => {
  it("expands leading ~", () => {
    process.env.HOME = "/home/test";
    // os.homedir uses the env var on most platforms.
    expect(expandHome("~")).toBeTruthy();
    expect(expandHome("~/foo").endsWith("/foo")).toBe(true);
  });

  it("returns absolute paths unchanged", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
  });
});

// ─── helpers ──────────────────────────────────────────────────────────

function findPairIndex(argv: string[], flag: string, value: string): number {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag && argv[i + 1] === value) return i;
  }
  return -1;
}

function findTripleIndex(
  argv: string[],
  flag: string,
  v1: string,
  v2: string,
): number {
  for (let i = 0; i < argv.length - 2; i++) {
    if (argv[i] === flag && argv[i + 1] === v1 && argv[i + 2] === v2) return i;
  }
  return -1;
}

function expectPair(argv: string[], flag: string, value: string): void {
  if (findPairIndex(argv, flag, value) < 0) {
    throw new Error(
      `expected argv to contain [${flag}, ${value}]; got:\n${argv.join(" ")}`,
    );
  }
}

function expectTriple(
  argv: string[],
  flag: string,
  v1: string,
  v2: string,
): void {
  if (findTripleIndex(argv, flag, v1, v2) < 0) {
    throw new Error(
      `expected argv to contain [${flag}, ${v1}, ${v2}]; got:\n${argv.join(" ")}`,
    );
  }
}

function hasTriple(
  argv: string[],
  flag: string,
  v1: string,
  v2: string,
): boolean {
  return findTripleIndex(argv, flag, v1, v2) >= 0;
}
