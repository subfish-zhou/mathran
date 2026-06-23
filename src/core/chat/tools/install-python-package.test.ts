import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createInstallPythonPackageTool } from "./install-python-package.js";
import { python3OnPath } from "./python-venv.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-gap4-pip-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("createInstallPythonPackageTool", () => {
  it("errors without a conversationId", async () => {
    const res = await createInstallPythonPackageTool({ workspace }).execute({
      package: "wheel",
    });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("conversationId");
  });

  it("errors without a package name", async () => {
    const res = await createInstallPythonPackageTool({
      workspace,
      conversationId: "c1",
    }).execute({ package: "  " });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("requires 'package'");
  });

  it("installs a lightweight package into the conv venv and records it", async () => {
    if (!(await python3OnPath())) return;
    const tool = createInstallPythonPackageTool({
      workspace,
      conversationId: "c1",
    });
    // `six` is tiny and pure-python — fast to install.
    const res = await tool.execute({ package: "six" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("installed six");
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(
          workspace,
          ".mathran",
          "python-envs",
          "c1",
          ".mathran-manifest.json",
        ),
        "utf-8",
      ),
    );
    expect(manifest.six).toBe(true);
  }, 180_000);
});
