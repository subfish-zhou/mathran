/**
 * Tests for the layered settings HTTP surface (`settings-routes.ts`).
 *
 * Driven against a bare `Hono` app via `app.request(...)` (no network), with a
 * throwaway workspace + a `home` override so the USER layer lands in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Hono } from "hono";

import {
  registerSettingsRoutes,
  deepMergeSettings,
  validateUserWhitelist,
  computeSources,
  mergeAndWriteSettings,
  settingsPathForLayer,
  USER_WHITELIST_MESSAGE,
} from "./settings-routes.js";

let workspace: string;
let home: string;
let app: Hono;

function build(): Hono {
  const a = new Hono();
  registerSettingsRoutes(a, workspace, { home });
  return a;
}

async function writeJson(file: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf-8");
}

function userFile(): string {
  return path.join(home, ".mathran", "settings.json");
}
function workspaceFile(): string {
  return path.join(workspace, ".mathran", "settings.json");
}
function projectFile(slug: string): string {
  return path.join(workspace, "projects", slug, ".mathran", "settings.json");
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-set-ws-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-set-home-"));
  app = build();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── pure helpers ──────────────────────────────────────────────────────

describe("deepMergeSettings", () => {
  it("deep-merges nested objects and replaces arrays/scalars", () => {
    const out = deepMergeSettings(
      { ui: { theme: "light" }, approval: { policy: "on-request", denylist: ["a"] } },
      { approval: { denylist: ["b", "c"] } },
    );
    expect(out).toEqual({
      ui: { theme: "light" },
      approval: { policy: "on-request", denylist: ["b", "c"] },
    });
  });

  it("deletes a key when patched with null", () => {
    const out = deepMergeSettings({ editor: "nvim", ui: { theme: "dark" } }, { editor: null });
    expect(out).toEqual({ ui: { theme: "dark" } });
  });
});

describe("validateUserWhitelist", () => {
  it("accepts ui.theme / editor / modelPreference", () => {
    expect(
      validateUserWhitelist({ ui: { theme: "dark" }, editor: "code", modelPreference: { default: "x" } }),
    ).toEqual({ ok: true });
  });

  it("rejects approval at the user layer", () => {
    const r = validateUserWhitelist({ approval: { policy: "never" } });
    expect(r.ok).toBe(false);
    expect(r.field).toBe("approval");
  });

  it("rejects ui sub-keys other than theme", () => {
    const r = validateUserWhitelist({ ui: { density: "compact" } });
    expect(r.ok).toBe(false);
    expect(r.field).toBe("ui.density");
  });
});

describe("computeSources", () => {
  it("attributes each leaf to the highest-precedence layer", () => {
    const sources = computeSources(
      { ui: { theme: "dark" }, approval: { policy: "never" } },
      {
        user: { ui: { theme: "dark" } },
        workspace: { approval: { policy: "never" } },
        project: {},
      },
    );
    expect(sources["ui.theme"]).toBe("user");
    expect(sources["approval.policy"]).toBe("workspace");
  });
});

describe("settingsPathForLayer", () => {
  it("returns null for the project layer without a slug", () => {
    expect(settingsPathForLayer("project", workspace, home)).toBeNull();
  });
});

// ── GET /api/settings/effective ───────────────────────────────────────

describe("GET /api/settings/effective", () => {
  it("merges all three layers with project winning", async () => {
    await writeJson(userFile(), { ui: { theme: "light" }, editor: "nvim" });
    await writeJson(workspaceFile(), { approval: { policy: "on-request" }, agent: { maxIterations: 100 } });
    await writeJson(projectFile("foo"), { approval: { policy: "never" } });

    const res = await app.request("/api/settings/effective?projectSlug=foo");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.effective.ui.theme).toBe("light");
    expect(body.effective.editor).toBe("nvim");
    expect(body.effective.approval.policy).toBe("never"); // project wins
    expect(body.effective.agent.maxIterations).toBe(100);
  });

  it("reports per-field sources", async () => {
    await writeJson(userFile(), { ui: { theme: "dark" } });
    await writeJson(workspaceFile(), { approval: { policy: "untrusted" } });
    const res = await app.request("/api/settings/effective");
    const body = await res.json();
    expect(body.sources["ui.theme"]).toBe("user");
    expect(body.sources["approval.policy"]).toBe("workspace");
  });

  it("returns the on-disk paths for each layer", async () => {
    const res = await app.request("/api/settings/effective?projectSlug=foo");
    const body = await res.json();
    expect(body.paths.user).toBe(userFile());
    expect(body.paths.workspace).toBe(workspaceFile());
    expect(body.paths.project).toBe(projectFile("foo"));
  });
});

// ── GET /api/settings/:layer ──────────────────────────────────────────

describe("GET /api/settings/:layer", () => {
  it("returns raw layer settings un-merged", async () => {
    await writeJson(workspaceFile(), { approval: { policy: "on-failure" } });
    const res = await app.request("/api/settings/workspace");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings).toEqual({ approval: { policy: "on-failure" } });
  });

  it("returns {} when the file does not exist", async () => {
    const res = await app.request("/api/settings/user");
    const body = await res.json();
    expect(body.settings).toEqual({});
  });

  it("404s an unknown layer", async () => {
    const res = await app.request("/api/settings/bogus");
    expect(res.status).toBe(404);
  });

  it("400s project layer without a slug", async () => {
    const res = await app.request("/api/settings/project");
    expect(res.status).toBe(400);
  });
});

// ── PUT /api/settings/:layer ──────────────────────────────────────────

describe("PUT /api/settings/:layer", () => {
  it("writes a whitelisted user field and persists it", async () => {
    const res = await app.request("/api/settings/user", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui: { theme: "dark" } }),
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(userFile(), "utf-8"));
    expect(onDisk.ui.theme).toBe("dark");
  });

  it("rejects a non-whitelisted user field (approval.policy) with 400", async () => {
    const res = await app.request("/api/settings/user", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: { policy: "never" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(USER_WHITELIST_MESSAGE);
    expect(fsSync.existsSync(userFile())).toBe(false);
  });

  it("partial-updates the user layer, preserving other fields", async () => {
    await writeJson(userFile(), { editor: "nvim", ui: { theme: "light" } });
    const res = await app.request("/api/settings/user", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui: { theme: "dark" } }),
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(userFile(), "utf-8"));
    expect(onDisk.editor).toBe("nvim"); // preserved
    expect(onDisk.ui.theme).toBe("dark"); // updated
  });

  it("writes approval.policy on the workspace layer", async () => {
    const res = await app.request("/api/settings/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: { policy: "never" } }),
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(workspaceFile(), "utf-8"));
    expect(onDisk.approval.policy).toBe("never");
  });

  it("400s a project-layer PUT without a slug", async () => {
    const res = await app.request("/api/settings/project", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: { policy: "never" } }),
    });
    expect(res.status).toBe(400);
  });

  it("writes the project layer under projects/<slug>/.mathran", async () => {
    const res = await app.request("/api/settings/project?projectSlug=foo", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: { disabled: ["lean-stuck-debugger"] } }),
    });
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(projectFile("foo"), "utf-8"));
    expect(onDisk.skills.disabled).toEqual(["lean-stuck-debugger"]);
  });

  it("400s a body that fails schema validation", async () => {
    const res = await app.request("/api/settings/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval: { policy: "bogus-policy" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/schema/i);
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("400s invalid JSON", async () => {
    const res = await app.request("/api/settings/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("stamps schemaVersion on write", async () => {
    await app.request("/api/settings/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editor: "code" }),
    });
    const onDisk = JSON.parse(await fs.readFile(workspaceFile(), "utf-8"));
    expect(typeof onDisk.schemaVersion).toBe("number");
  });
});

// ── atomic write crash safety ─────────────────────────────────────────

describe("mergeAndWriteSettings (atomic)", () => {
  it("leaves no .tmp file and does not corrupt state when rename fails", async () => {
    // Force `fs.rename(tmp, target)` to fail by making the target an existing
    // (non-empty) directory — renaming a file onto it throws, exercising the
    // atomic-write cleanup path without ESM spying.
    const dir = path.join(workspace, ".mathran");
    const target = path.join(dir, "settings.json");
    await fs.mkdir(path.join(target, "marker"), { recursive: true });

    await expect(mergeAndWriteSettings(target, { editor: "code" })).rejects.toThrow();

    // The pre-existing target (a directory here) is untouched...
    expect(fsSync.statSync(target).isDirectory()).toBe(true);
    expect(fsSync.existsSync(path.join(target, "marker"))).toBe(true);

    // ...and no leftover .tmp.* sibling remains.
    const entries = await fs.readdir(dir);
    expect(entries.some((e) => e.startsWith("settings.json.tmp."))).toBe(false);
  });
});
