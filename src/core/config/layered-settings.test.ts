import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  loadLayeredSettings,
  applyUserWhitelist,
  USER_OVERRIDE_WHITELIST,
} from "./layered-settings.js";
import { MATHRAN_DIR, SETTINGS_FILE } from "./mathran-root.js";

let tmp: string;
let workspace: string;
let home: string;

function writeSettings(dir: string, obj: unknown) {
  const root = path.join(dir, MATHRAN_DIR);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, SETTINGS_FILE), JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-settings-test-"));
  workspace = path.join(tmp, "ws");
  home = path.join(tmp, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("applyUserWhitelist", () => {
  it("keeps only whitelisted fields and warns about the rest", () => {
    const warnings: string[] = [];
    const out = applyUserWhitelist(
      {
        ui: { theme: "dark" },
        editor: "nvim",
        modelPreference: { default: "x" },
        skills: { disabled: ["a"] },
        hooks: { allowed: ["b"] },
        agent: { maxIterations: 3 },
      } as any,
      warnings,
    );
    expect(out).toEqual({
      ui: { theme: "dark" },
      editor: "nvim",
      modelPreference: { default: "x" },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skills/);
    expect(warnings[0]).toMatch(/hooks/);
    expect(warnings[0]).toMatch(/agent/);
  });

  it("exposes the documented whitelist", () => {
    expect(USER_OVERRIDE_WHITELIST).toContain("ui.theme");
    expect(USER_OVERRIDE_WHITELIST).toContain("editor");
    expect(USER_OVERRIDE_WHITELIST).toContain("modelPreference");
  });
});

describe("loadLayeredSettings cascade", () => {
  it("returns empty settings when nothing exists", () => {
    const r = loadLayeredSettings({ workspace, home });
    expect(r.settings).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it("PROJECT overrides WORKSPACE", () => {
    writeSettings(workspace, { modelPreference: { default: "ws-model" }, editor: "vim" });
    const projDir = path.join(workspace, "projects", "p1");
    fs.mkdirSync(projDir, { recursive: true });
    writeSettings(projDir, { modelPreference: { default: "proj-model" } });

    const r = loadLayeredSettings({ workspace, home, projectSlug: "p1", skipUser: true });
    expect(r.settings.modelPreference?.default).toBe("proj-model");
    // editor falls through from workspace (not overridden by project)
    expect(r.settings.editor).toBe("vim");
  });

  it("USER override applies for whitelisted fields, ignored for non-whitelisted", () => {
    writeSettings(home, {
      ui: { theme: "light" },
      skills: { disabled: ["should-be-ignored"] },
    });
    writeSettings(workspace, { skills: { disabled: ["ws-skill"] } });

    const r = loadLayeredSettings({ workspace, home });
    // user ui.theme applies (workspace doesn't set it)
    expect(r.settings.ui?.theme).toBe("light");
    // user's skills.disabled is ignored; workspace value wins
    expect(r.settings.skills?.disabled).toEqual(["ws-skill"]);
    expect(r.warnings.some((w) => /may only override/.test(w))).toBe(true);
  });

  it("WORKSPACE wins over USER for whitelisted fields too", () => {
    writeSettings(home, { editor: "user-editor" });
    writeSettings(workspace, { editor: "ws-editor" });
    const r = loadLayeredSettings({ workspace, home });
    expect(r.settings.editor).toBe("ws-editor");
  });

  it("records a warning for malformed JSON and continues", () => {
    const root = path.join(workspace, MATHRAN_DIR);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, SETTINGS_FILE), "{ not json");
    const r = loadLayeredSettings({ workspace, home });
    expect(r.settings).toEqual({});
    expect(r.warnings.some((w) => /not valid JSON/.test(w))).toBe(true);
  });

  it("deep-merges nested objects across layers", () => {
    writeSettings(workspace, { agent: { maxIterations: 5, timeoutMs: 1000 } });
    const projDir = path.join(workspace, "projects", "p2");
    fs.mkdirSync(projDir, { recursive: true });
    writeSettings(projDir, { agent: { maxIterations: 99 } });
    const r = loadLayeredSettings({ workspace, home, projectSlug: "p2", skipUser: true });
    expect(r.settings.agent?.maxIterations).toBe(99);
    expect(r.settings.agent?.timeoutMs).toBe(1000);
  });
});
