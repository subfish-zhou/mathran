import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  runRootInit,
  runRootValidate,
  runRootShow,
  runRootMigrate,
} from "./init-root.js";
import { MATHRAN_DIR, SETTINGS_FILE, SIGNATURE_FILE } from "../../core/config/mathran-root.js";

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-rootcli-test-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runRootInit", () => {
  it("creates a fresh root and returns 0", () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj);
    expect(runRootInit(proj, { home })).toBe(0);
    expect(fs.existsSync(path.join(proj, MATHRAN_DIR, SIGNATURE_FILE))).toBe(true);
  });

  it("does not double-append .mathran", () => {
    const proj = path.join(tmp, "proj2");
    fs.mkdirSync(proj);
    expect(runRootInit(path.join(proj, ".mathran"), { home })).toBe(0);
    expect(fs.existsSync(path.join(proj, ".mathran", ".mathran"))).toBe(false);
  });

  it("rejects /etc and returns 1", () => {
    expect(runRootInit("/etc", { home })).toBe(1);
  });

  it("rejects a missing parent dir", () => {
    expect(runRootInit(path.join(tmp, "no", "such", "dir"), { home })).toBe(1);
  });
});

describe("runRootValidate", () => {
  it("validates a created root", () => {
    const proj = path.join(tmp, "v1");
    fs.mkdirSync(proj);
    runRootInit(proj, { home });
    expect(runRootValidate(proj, { home })).toBe(0);
  });

  it("fails on a missing root", () => {
    expect(runRootValidate(path.join(tmp, "nope"), { home })).toBe(1);
  });
});

describe("runRootShow", () => {
  it("returns 0 with merged settings", () => {
    const workspace = path.join(tmp, "ws");
    const wsRoot = path.join(workspace, MATHRAN_DIR);
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.writeFileSync(path.join(wsRoot, SETTINGS_FILE), JSON.stringify({ editor: "vim" }));
    expect(runRootShow({ workspace, home })).toBe(0);
  });
});

describe("runRootMigrate", () => {
  it("copies config.toml defaultModel into settings.json", async () => {
    const workspace = path.join(tmp, "ws2");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "config.toml"), 'defaultModel = "copilot/gpt-5.5"\n');
    expect(await runRootMigrate({ workspace, home })).toBe(0);
    const settings = JSON.parse(
      fs.readFileSync(path.join(workspace, MATHRAN_DIR, SETTINGS_FILE), "utf-8"),
    );
    expect(settings.modelPreference.default).toBe("copilot/gpt-5.5");
  });

  it("dry-run does not write", async () => {
    const workspace = path.join(tmp, "ws3");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "config.toml"), 'defaultModel = "x"\n');
    expect(await runRootMigrate({ workspace, home, dryRun: true })).toBe(0);
    expect(fs.existsSync(path.join(workspace, MATHRAN_DIR, SETTINGS_FILE))).toBe(false);
  });

  it("returns 1 when config.toml is absent", async () => {
    const workspace = path.join(tmp, "ws4");
    fs.mkdirSync(workspace, { recursive: true });
    expect(await runRootMigrate({ workspace, home })).toBe(1);
  });
});
