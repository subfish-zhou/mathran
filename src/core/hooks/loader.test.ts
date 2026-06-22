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

  it("ignores non-.sh files", () => {
    writeHook(workspace, "notes.txt");
    expect(loadLayeredHooks({ workspace, home }).hooks).toEqual([]);
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
