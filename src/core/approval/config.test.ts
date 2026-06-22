import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveApprovalConfig,
  migrateApprovalSettings,
} from "./config.js";

function writeSettings(dir: string, obj: unknown): void {
  const mdir = path.join(dir, ".mathran");
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, "settings.json"), JSON.stringify(obj, null, 2));
}

describe("resolveApprovalConfig", () => {
  let ws: string;
  let home: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-ac-ws-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-ac-home-"));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("defaults to on-request when no settings exist", () => {
    const cfg = resolveApprovalConfig({ workspace: ws, home, skipUser: true });
    expect(cfg.policy).toBe("on-request");
    expect(cfg.learning).toBe(true);
    expect(cfg.proposeAfter).toBe(5);
  });

  it("reads an explicit policy", () => {
    writeSettings(ws, { approval: { policy: "never", learning: false } });
    const cfg = resolveApprovalConfig({ workspace: ws, home, skipUser: true });
    expect(cfg.policy).toBe("never");
    expect(cfg.learning).toBe(false);
  });

  it("reads inline rules + denylist", () => {
    writeSettings(ws, {
      approval: {
        policy: "on-request",
        rules: [{ tool: "bash", prefix: "ls", action: "allow" }],
        denylist: ["bash:rm -rf *"],
      },
    });
    const cfg = resolveApprovalConfig({ workspace: ws, home, skipUser: true });
    expect(cfg.inlineRules).toHaveLength(1);
    expect(cfg.denylist).toEqual(["bash:rm -rf *"]);
  });

  it("wires rules/history file paths", () => {
    const cfg = resolveApprovalConfig({ workspace: ws, home, skipUser: true });
    expect(cfg.rulesFiles[0]).toContain(path.join(ws, ".mathran", "approval-rules.json"));
    expect(cfg.historyFile).toContain(path.join(home, ".mathran", "approval-history.jsonl"));
  });
});

describe("migrateApprovalSettings", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-mig-"));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("returns null when no settings file", () => {
    expect(migrateApprovalSettings(ws)).toBe(null);
  });

  it("writes the default block and warns on a legacy file", () => {
    writeSettings(ws, { editor: "vim" });
    const warn = migrateApprovalSettings(ws);
    expect(warn).toContain("on-request");
    const raw = JSON.parse(
      fs.readFileSync(path.join(ws, ".mathran", "settings.json"), "utf-8"),
    );
    expect(raw.approval.policy).toBe("on-request");
    expect(raw.editor).toBe("vim");
  });

  it("is a no-op when approval already present", () => {
    writeSettings(ws, { approval: { policy: "never" } });
    expect(migrateApprovalSettings(ws)).toBe(null);
  });
});
