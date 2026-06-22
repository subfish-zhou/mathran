/**
 * Unit tests for the MATHRAN.md memory loader (v0.3 §14).
 *
 * Each test gets a fresh tmpdir to act as both `workspace` and `home`, so the
 * resolver lands on isolated files. We also exercise the truncation cap and
 * verify the formatter never emits an empty header.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  DEFAULT_MEMORY_MAX_BYTES,
  MEMORY_BLOCK_HEADER,
  TRUNCATION_MARKER,
  formatMathranMemory,
  loadMathranMemory,
  loadMathranMemorySync,
  resolveGlobalMemoryPath,
  resolveProjectMemoryPath,
} from "./index.js";

let tmp: string;
let workspace: string;
let home: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-mem-test-"));
  workspace = path.join(tmp, "ws");
  home = path.join(tmp, "home");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("path resolvers", () => {
  it("resolveGlobalMemoryPath uses given home", () => {
    expect(resolveGlobalMemoryPath("/h")).toBe(path.join("/h", ".mathran", "MATHRAN.md"));
  });
  it("resolveGlobalMemoryPath defaults to os.homedir()", () => {
    expect(resolveGlobalMemoryPath()).toBe(
      path.join(os.homedir(), ".mathran", "MATHRAN.md"),
    );
  });
  it("resolveProjectMemoryPath joins workspace + MATHRAN.md", () => {
    expect(resolveProjectMemoryPath("/ws")).toBe(path.join("/ws", "MATHRAN.md"));
  });
});

describe("loadMathranMemory", () => {
  it("returns both bodies when both files exist", async () => {
    await fs.mkdir(path.join(home, ".mathran"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".mathran", "MATHRAN.md"),
      "global notes",
      "utf8",
    );
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), "project notes", "utf8");

    const m = await loadMathranMemory({ workspace, home });
    expect(m.global.body).toBe("global notes");
    expect(m.global.path).toBe(path.join(home, ".mathran", "MATHRAN.md"));
    expect(m.global.truncated).toBe(false);

    expect(m.project.body).toBe("project notes");
    expect(m.project.path).toBe(path.join(workspace, "MATHRAN.md"));
    expect(m.project.truncated).toBe(false);
  });

  it("returns global=null when only project exists", async () => {
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), "p", "utf8");
    const m = await loadMathranMemory({ workspace, home });
    expect(m.global.body).toBeNull();
    expect(m.global.path).toBeNull();
    expect(m.project.body).toBe("p");
  });

  it("returns project=null when only global exists", async () => {
    await fs.mkdir(path.join(home, ".mathran"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".mathran", "MATHRAN.md"),
      "g",
      "utf8",
    );
    const m = await loadMathranMemory({ workspace, home });
    expect(m.global.body).toBe("g");
    expect(m.project.body).toBeNull();
    expect(m.project.path).toBeNull();
  });

  it("returns both null when neither file exists; formatted output is empty", async () => {
    const m = await loadMathranMemory({ workspace, home });
    expect(m.global.body).toBeNull();
    expect(m.project.body).toBeNull();
    expect(formatMathranMemory(m)).toBe("");
  });

  it("truncates files larger than maxBytes (default 16 KB)", async () => {
    const big = "x".repeat(DEFAULT_MEMORY_MAX_BYTES + 100);
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), big, "utf8");
    const m = await loadMathranMemory({ workspace, home, skipGlobal: true });
    expect(m.project.truncated).toBe(true);
    expect(m.project.body!.length).toBe(DEFAULT_MEMORY_MAX_BYTES);
    const out = formatMathranMemory(m);
    expect(out).toContain(TRUNCATION_MARKER);
  });

  it("honors custom maxBytes", async () => {
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), "abcdef", "utf8");
    const m = await loadMathranMemory({ workspace, home, skipGlobal: true, maxBytes: 3 });
    expect(m.project.truncated).toBe(true);
    expect(m.project.body).toBe("abc");
  });

  it("skipGlobal=true never reads the global file even if it exists", async () => {
    await fs.mkdir(path.join(home, ".mathran"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".mathran", "MATHRAN.md"),
      "g",
      "utf8",
    );
    const m = await loadMathranMemory({ workspace, home, skipGlobal: true });
    expect(m.global.body).toBeNull();
    expect(m.global.path).toBeNull();
  });

  it("never throws on EACCES / unreadable files", async () => {
    // Point at a path under a non-existent directory; readFile yields ENOENT.
    const m = await loadMathranMemory({ workspace: "/nonexistent/xyz", home });
    expect(m.project.body).toBeNull();
    expect(m.global.body).toBeNull();
  });
});

describe("loadMathranMemorySync", () => {
  it("matches the async loader for both-present case", async () => {
    await fs.mkdir(path.join(home, ".mathran"), { recursive: true });
    await fs.writeFile(path.join(home, ".mathran", "MATHRAN.md"), "g", "utf8");
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), "p", "utf8");

    const sync = loadMathranMemorySync({ workspace, home });
    expect(sync.global.body).toBe("g");
    expect(sync.project.body).toBe("p");
  });

  it("never throws on missing files (sync)", () => {
    const sync = loadMathranMemorySync({ workspace: "/no/such/dir", home: "/no/such/home" });
    expect(sync.global.body).toBeNull();
    expect(sync.project.body).toBeNull();
  });
});

describe("formatMathranMemory", () => {
  it("emits header + global section only when project missing", async () => {
    await fs.mkdir(path.join(home, ".mathran"), { recursive: true });
    await fs.writeFile(path.join(home, ".mathran", "MATHRAN.md"), "global body", "utf8");
    const m = await loadMathranMemory({ workspace, home });
    const out = formatMathranMemory(m);
    expect(out).toContain(MEMORY_BLOCK_HEADER);
    expect(out).toContain("## Global");
    expect(out).toContain("global body");
    expect(out).not.toContain("## Project");
  });

  it("emits header + project section only when global missing", async () => {
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), "project body", "utf8");
    const m = await loadMathranMemory({ workspace, home });
    const out = formatMathranMemory(m);
    expect(out).toContain(MEMORY_BLOCK_HEADER);
    expect(out).toContain("## Project");
    expect(out).toContain("project body");
    expect(out).not.toContain("## Global");
  });

  it("emits global before project when both present (order matters)", async () => {
    await fs.mkdir(path.join(home, ".mathran"), { recursive: true });
    await fs.writeFile(path.join(home, ".mathran", "MATHRAN.md"), "G_BODY", "utf8");
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), "P_BODY", "utf8");
    const m = await loadMathranMemory({ workspace, home });
    const out = formatMathranMemory(m);
    const gIdx = out.indexOf("G_BODY");
    const pIdx = out.indexOf("P_BODY");
    expect(gIdx).toBeGreaterThan(-1);
    expect(pIdx).toBeGreaterThan(-1);
    expect(gIdx).toBeLessThan(pIdx);
  });

  it("returns '' when both empty", () => {
    const out = formatMathranMemory({
      global: { path: null, body: null, truncated: false },
      project: { path: null, body: null, truncated: false },
    });
    expect(out).toBe("");
  });
});

describe("loadLayeredMathranMemorySync (three-layer)", () => {
  it("loads USER < WORKSPACE < PROJECT and formats them in order", async () => {
    const { loadLayeredMathranMemorySync, formatLayeredMathranMemory } = await import("./index.js");
    await fs.mkdir(path.join(home, ".mathran"), { recursive: true });
    await fs.writeFile(path.join(home, ".mathran", "MATHRAN.md"), "USER MEM", "utf8");
    await fs.writeFile(path.join(workspace, "MATHRAN.md"), "WS MEM", "utf8");
    const projDir = path.join(workspace, "projects", "p1");
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(path.join(projDir, "MATHRAN.md"), "PROJ MEM", "utf8");

    const m = loadLayeredMathranMemorySync({ workspace, home, projectSlug: "p1" });
    expect(m.user.body).toBe("USER MEM");
    expect(m.workspace.body).toBe("WS MEM");
    expect(m.project.body).toBe("PROJ MEM");

    const out = formatLayeredMathranMemory(m);
    expect(out.indexOf("## User")).toBeLessThan(out.indexOf("## Workspace"));
    expect(out.indexOf("## Workspace")).toBeLessThan(out.indexOf("## Project"));
  });

  it("returns empty fragment when nothing exists", async () => {
    const { loadLayeredMathranMemorySync, formatLayeredMathranMemory } = await import("./index.js");
    const m = loadLayeredMathranMemorySync({ workspace, home, skipUser: true });
    expect(formatLayeredMathranMemory(m)).toBe("");
  });
});
