import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadLayeredCommands } from "./loader.js";
import { MATHRAN_DIR } from "../config/mathran-root.js";

let tmp: string;
let workspace: string;
let home: string;

function writeCommand(baseDir: string, fileName: string, content: string) {
  const dir = path.join(baseDir, MATHRAN_DIR, "commands");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
}

function projectDir(): string {
  const d = path.join(workspace, "projects", "p1");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-cmd-test-"));
  workspace = path.join(tmp, "ws");
  home = path.join(tmp, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("loadLayeredCommands", () => {
  it("returns empty when nothing exists", () => {
    expect(loadLayeredCommands({ workspace, home }).commands).toEqual([]);
  });

  it("defaults name to filename and captures body", () => {
    writeCommand(workspace, "review.md", "Please review the code.");
    const r = loadLayeredCommands({ workspace, home });
    expect(r.commands[0].name).toBe("review");
    expect(r.commands[0].manifest.body.trim()).toBe("Please review the code.");
  });

  it("honors a frontmatter name + description", () => {
    writeCommand(
      workspace,
      "r.md",
      "---\nname: review\ndescription: Code review\n---\nbody here",
    );
    const r = loadLayeredCommands({ workspace, home });
    expect(r.commands[0].name).toBe("review");
    expect(r.commands[0].manifest.description).toBe("Code review");
    expect(r.commands[0].manifest.body.trim()).toBe("body here");
  });

  it("dedups by name: PROJECT > WORKSPACE > USER", () => {
    writeCommand(home, "dup.md", "user body");
    writeCommand(workspace, "dup.md", "ws body");
    writeCommand(projectDir(), "dup.md", "proj body");
    const r = loadLayeredCommands({ workspace, home, projectSlug: "p1" });
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].layer).toBe("project");
    expect(r.commands[0].manifest.body.trim()).toBe("proj body");
  });

  it("ignores non-.md files", () => {
    writeCommand(workspace, "notes.txt", "ignore me");
    expect(loadLayeredCommands({ workspace, home }).commands).toEqual([]);
  });

  it("warns on malformed frontmatter", () => {
    writeCommand(workspace, "bad.md", "---\n: : bad: :\n---\nbody");
    const r = loadLayeredCommands({ workspace, home });
    expect(r.commands).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
