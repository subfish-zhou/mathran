import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadLayeredHooks, hookTypeFor } from "./loader.js";
import { MATHRAN_DIR } from "../config/mathran-root.js";

let tmp: string;
let workspace: string;
let home: string;

function writeHook(baseDir: string, fileName: string, body = "#!/bin/sh\necho hi") {
  const dir = path.join(baseDir, MATHRAN_DIR, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), body);
}

function projectDir(): string {
  const d = path.join(workspace, "projects", "p1");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-hooks-test-"));
  workspace = path.join(tmp, "ws");
  home = path.join(tmp, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("hookTypeFor", () => {
  it("classifies by prefix", () => {
    expect(hookTypeFor("pre-chat")).toBe("pre-chat");
    expect(hookTypeFor("pre-chat-lint")).toBe("pre-chat");
    expect(hookTypeFor("post-tool")).toBe("post-tool");
    expect(hookTypeFor("post-tool.audit")).toBe("post-tool");
    expect(hookTypeFor("random")).toBe("unknown");
  });

  it("classifies the five new hook types", () => {
    expect(hookTypeFor("pre-edit")).toBe("pre-edit");
    expect(hookTypeFor("pre-edit-format")).toBe("pre-edit");
    expect(hookTypeFor("post-edit")).toBe("post-edit");
    expect(hookTypeFor("post-edit_prettier")).toBe("post-edit");
    expect(hookTypeFor("pre-commit")).toBe("pre-commit");
    expect(hookTypeFor("pre-commit-test")).toBe("pre-commit");
    expect(hookTypeFor("pre-bash")).toBe("pre-bash");
    expect(hookTypeFor("pre-bash.audit")).toBe("pre-bash");
    expect(hookTypeFor("on-goal-complete")).toBe("on-goal-complete");
    expect(hookTypeFor("on-goal-complete-notify")).toBe("on-goal-complete");
  });

  it("does not confuse similar prefixes", () => {
    expect(hookTypeFor("pre-commitment")).toBe("unknown");
    expect(hookTypeFor("pre-editor")).toBe("unknown");
    expect(hookTypeFor("preedit")).toBe("unknown");
  });
});

import { isBlockingHookType } from "./loader.js";

describe("isBlockingHookType", () => {
  it("blocks pre-* hooks only", () => {
    expect(isBlockingHookType("pre-chat")).toBe(true);
    expect(isBlockingHookType("pre-edit")).toBe(true);
    expect(isBlockingHookType("pre-commit")).toBe(true);
    expect(isBlockingHookType("pre-bash")).toBe(true);
  });
  it("does not block post-*/on-* hooks", () => {
    expect(isBlockingHookType("post-tool")).toBe(false);
    expect(isBlockingHookType("post-edit")).toBe(false);
    expect(isBlockingHookType("on-goal-complete")).toBe(false);
    expect(isBlockingHookType("unknown")).toBe(false);
  });
});

describe("loadLayeredHooks", () => {
  it("returns empty when nothing exists", () => {
    expect(loadLayeredHooks({ workspace, home }).hooks).toEqual([]);
  });

  it("merges all layers (no dedup) lowest → highest", () => {
    writeHook(home, "pre-chat.sh");
    writeHook(workspace, "pre-chat.sh");
    writeHook(projectDir(), "post-tool.sh");
    const r = loadLayeredHooks({ workspace, home, projectSlug: "p1" });
    expect(r.hooks).toHaveLength(3);
    expect(r.hooks.map((h) => h.layer)).toEqual(["user", "workspace", "project"]);
  });

  it("ignores non-hook files (unrecognised extension)", () => {
    writeHook(workspace, "notes.txt");
    writeHook(workspace, "README.md");
    expect(loadLayeredHooks({ workspace, home }).hooks).toEqual([]);
  });

  it("loads .sh/.bash/.js/.py and extensionless hooks", () => {
    writeHook(workspace, "pre-edit.sh");
    writeHook(workspace, "post-edit.bash");
    writeHook(workspace, "pre-bash.js");
    writeHook(workspace, "pre-commit.py");
    writeHook(workspace, "post-tool");
    const r = loadLayeredHooks({ workspace, home });
    const byName = Object.fromEntries(r.hooks.map((h) => [h.name, h.type]));
    expect(byName["pre-edit"]).toBe("pre-edit");
    expect(byName["post-edit"]).toBe("post-edit");
    expect(byName["pre-bash"]).toBe("pre-bash");
    expect(byName["pre-commit"]).toBe("pre-commit");
    expect(byName["post-tool"]).toBe("post-tool");
    expect(r.hooks).toHaveLength(5);
  });

  it("matches the whitelist against the full filename too", () => {
    writeHook(workspace, "post-edit.sh");
    const r = loadLayeredHooks({ workspace, home, allowed: ["post-edit.sh"] });
    expect(r.hooks[0].allowed).toBe(true);
  });

  it("derives type from filename", () => {
    writeHook(workspace, "pre-chat-lint.sh");
    const r = loadLayeredHooks({ workspace, home });
    expect(r.hooks[0].type).toBe("pre-chat");
  });

  it("marks allowed by name or type from the whitelist", () => {
    writeHook(workspace, "pre-chat-lint.sh");
    writeHook(workspace, "post-tool.sh");
    const r = loadLayeredHooks({ workspace, home, allowed: ["pre-chat-lint", "post-tool"] });
    const byName = Object.fromEntries(r.hooks.map((h) => [h.name, h.allowed]));
    expect(byName["pre-chat-lint"]).toBe(true);
    expect(byName["post-tool"]).toBe(true);
  });

  it("marks not-allowed when absent from whitelist", () => {
    writeHook(workspace, "pre-chat-danger.sh");
    const r = loadLayeredHooks({ workspace, home, allowed: ["post-tool"] });
    expect(r.hooks[0].allowed).toBe(false);
  });

  it("allows a whole type via the whitelist", () => {
    writeHook(workspace, "pre-chat-a.sh");
    writeHook(workspace, "pre-chat-b.sh");
    const r = loadLayeredHooks({ workspace, home, allowed: ["pre-chat"] });
    expect(r.hooks.every((h) => h.allowed)).toBe(true);
  });
});
