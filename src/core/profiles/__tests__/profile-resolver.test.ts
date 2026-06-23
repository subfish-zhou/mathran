/**
 * Permission Profiles (#2) — resolver: user-file override, listing, unknown
 * profile error, and mutation classification.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadProfileDefinition,
  resolveProfile,
  listAvailableProfiles,
  isMutatingCall,
  isReadOnlyShellCommand,
  UnknownProfileError,
} from "../profile-resolver.js";

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mathran-profiles-"));
}

function writeProfile(root: string, name: string, body: unknown): void {
  const dir = path.join(root, ".mathran", "profiles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body));
}

describe("loadProfileDefinition", () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = mkdtemp();
    workspace = mkdtemp();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("returns the builtin when no user file exists", () => {
    const def = loadProfileDefinition("dev", { home, workspace });
    expect(def.name).toBe("dev");
    expect(def.approval?.policy).toBe("never");
  });

  it("throws UnknownProfileError for an unknown name", () => {
    expect(() => loadProfileDefinition("nope", { home, workspace })).toThrow(
      UnknownProfileError,
    );
  });

  it("user file overrides a builtin of the same name", () => {
    writeProfile(home, "ci", {
      description: "my ci",
      approval: { policy: "on-request" },
      readOnlyMode: false,
    });
    const e = resolveProfile("ci", { home, workspace });
    expect(e.description).toBe("my ci");
    expect(e.policy).toBe("on-request");
    expect(e.readOnlyMode).toBe(false);
  });

  it("workspace file overrides the user file", () => {
    writeProfile(home, "ci", { description: "user-ci" });
    writeProfile(workspace, "ci", { description: "ws-ci" });
    const e = resolveProfile("ci", { home, workspace });
    expect(e.description).toBe("ws-ci");
  });

  it("supports a brand-new custom profile name", () => {
    writeProfile(home, "tight", {
      approval: { policy: "untrusted" },
      denylistTools: ["bash"],
    });
    const e = resolveProfile("tight", { home, workspace });
    expect(e.name).toBe("tight");
    expect(e.policy).toBe("untrusted");
    expect(e.denylistTools).toEqual(["bash"]);
  });

  it("skips a malformed user file and falls back to the builtin", () => {
    const dir = path.join(home, ".mathran", "profiles");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dev.json"), "{ not json");
    const def = loadProfileDefinition("dev", { home, workspace });
    expect(def.approval?.policy).toBe("never"); // builtin
  });
});

describe("listAvailableProfiles", () => {
  let home: string;
  let workspace: string;
  beforeEach(() => {
    home = mkdtemp();
    workspace = mkdtemp();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("lists the three builtins by default", () => {
    const list = listAvailableProfiles({ home, workspace });
    expect(list.map((p) => p.name)).toEqual(["dev", "ci", "review"]);
    expect(list.every((p) => p.source === "builtin")).toBe(true);
  });

  it("includes custom profiles and marks overridden source", () => {
    writeProfile(home, "tight", { description: "t" });
    writeProfile(workspace, "ci", { description: "ws" });
    const list = listAvailableProfiles({ home, workspace });
    const names = list.map((p) => p.name);
    expect(names).toContain("tight");
    expect(list.find((p) => p.name === "ci")?.source).toBe("workspace");
    expect(list.find((p) => p.name === "tight")?.source).toBe("user");
  });
});

describe("isReadOnlyShellCommand", () => {
  it("accepts plain read commands", () => {
    for (const cmd of ["ls -la", "cat file.txt", "grep foo src", "pwd", "git status", "git log --oneline"]) {
      expect(isReadOnlyShellCommand(cmd)).toBe(true);
    }
  });

  it("accepts read pipelines", () => {
    expect(isReadOnlyShellCommand("cat a.txt | grep foo | wc -l")).toBe(true);
  });

  it("rejects mutating commands", () => {
    for (const cmd of ["rm -rf x", "echo hi > out.txt", "git commit -m x", "git push", "mkdir d", "$(rm x)"]) {
      expect(isReadOnlyShellCommand(cmd)).toBe(false);
    }
  });

  it("rejects an unknown command in a pipeline", () => {
    expect(isReadOnlyShellCommand("cat a | mytool")).toBe(false);
  });
});

describe("isMutatingCall", () => {
  it("write tools always mutate", () => {
    expect(isMutatingCall("write_file", "write", { path: "a" })).toBe(true);
    expect(isMutatingCall("edit_file", "write", { path: "a" })).toBe(true);
    expect(isMutatingCall("todo_write", "write", {})).toBe(true);
  });

  it("read tools never mutate", () => {
    expect(isMutatingCall("read_file", "read", { path: "a" })).toBe(false);
  });

  it("lean_check is non-mutating verification", () => {
    expect(isMutatingCall("lean_check", "exec", {})).toBe(false);
  });

  it("bash mutates only for mutating commands", () => {
    expect(isMutatingCall("bash", "exec", { command: "ls -la" })).toBe(false);
    expect(isMutatingCall("bash", "exec", { command: "rm -rf x" })).toBe(true);
    expect(isMutatingCall("bash", "exec", { command: "git status" })).toBe(false);
  });

  it("dispatch_subagent mutates (could write via a subagent)", () => {
    expect(isMutatingCall("dispatch_subagent", "exec", {})).toBe(true);
  });
});
