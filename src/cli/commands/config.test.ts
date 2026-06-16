/**
 * Unit tests for the `mathran config` CLI sub-commands (GAP #16).
 *
 * Each test points the helpers at a freshly-minted tmp workspace, runs one
 * sub-command, and asserts both the exit code, the printed output, and the
 * on-disk TOML.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  runConfigPath,
  runConfigList,
  runConfigGet,
  runConfigSet,
  runConfigUnset,
} from "./config.js";

let workspace: string;
let cfgPath: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-config-cli-"));
  cfgPath = path.join(workspace, "config.toml");
  stdout = "";
  stderr = "";
  // Capture stdout/stderr without leaking into the actual test runner output.
  // We monkey-patch process.{stdout,stderr}.write for the duration of one test
  // by appending to the local strings.
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (chunk: any) => {
    stdout += String(chunk);
    return true;
  };
  (process.stderr as any).write = (chunk: any) => {
    stderr += String(chunk);
    return true;
  };
  // Restore on teardown.
  (globalThis as any).__restoreIO__ = () => {
    process.stdout.write = origOut as any;
    process.stderr.write = origErr as any;
  };
});

function restore() {
  (globalThis as any).__restoreIO__?.();
}

describe("mathran config path", () => {
  it("prints the resolved config path under the given workspace", async () => {
    const code = await runConfigPath({ workspace });
    restore();
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(cfgPath);
  });
});

describe("mathran config set / get / unset", () => {
  it("set creates the file if missing and writes a top-level value", async () => {
    const code = await runConfigSet("defaultModel", "copilot/gpt-5.5", { workspace });
    restore();
    expect(code).toBe(0);
    const raw = await fs.readFile(cfgPath, "utf-8");
    expect(raw).toContain('defaultModel = "copilot/gpt-5.5"');
  });

  it("set on a provider field creates the [providers.X] table when missing", async () => {
    const code = await runConfigSet("providers.openai.kind", "openai", { workspace });
    restore();
    expect(code).toBe(0);
    const raw = await fs.readFile(cfgPath, "utf-8");
    expect(raw).toMatch(/\[providers\.openai\]/);
    expect(raw).toContain('kind = "openai"');
  });

  it("set rejects an invalid provider kind", async () => {
    const code = await runConfigSet("providers.x.kind", "not-a-kind", { workspace });
    restore();
    expect(code).toBe(2);
    expect(stderr).toMatch(/invalid provider kind/);
  });

  it("set rejects an unknown provider field", async () => {
    const code = await runConfigSet("providers.openai.bogus", "v", { workspace });
    restore();
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown provider field/);
  });

  it("set rejects an unsupported key shape", async () => {
    const code = await runConfigSet("workspaceRoot", "/tmp/x", { workspace });
    restore();
    expect(code).toBe(2);
    expect(stderr).toMatch(/unsupported key/);
  });

  it("get returns the value when present", async () => {
    await runConfigSet("defaultModel", "azure/gpt55", { workspace });
    stdout = "";
    const code = await runConfigGet("defaultModel", { workspace });
    restore();
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("azure/gpt55");
  });

  it("get returns 1 + '(unset)' on missing key", async () => {
    const code = await runConfigGet("defaultModel", { workspace });
    restore();
    expect(code).toBe(1);
    expect(stderr).toMatch(/unset/);
  });

  it("get --json emits null on missing", async () => {
    const code = await runConfigGet("defaultModel", { workspace, json: true });
    restore();
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("null");
  });

  it("get on apiKey returns '[redacted]', never the secret", async () => {
    await runConfigSet("providers.openai.kind", "openai", { workspace });
    await runConfigSet("providers.openai.apiKey", "sk-secret-do-not-leak", { workspace });
    stdout = "";
    const code = await runConfigGet("providers.openai.apiKey", { workspace });
    restore();
    expect(code).toBe(0);
    expect(stdout).toContain("[redacted]");
    expect(stdout).not.toContain("sk-secret-do-not-leak");
  });

  it("unset removes a top-level value", async () => {
    await runConfigSet("defaultModel", "x", { workspace });
    stdout = "";
    const code = await runConfigUnset("defaultModel", { workspace });
    restore();
    expect(code).toBe(0);
    const raw = await fs.readFile(cfgPath, "utf-8");
    expect(raw).not.toContain("defaultModel");
  });

  it("unset removes a provider field, and the table when last field goes", async () => {
    await runConfigSet("providers.openai.kind", "openai", { workspace });
    await runConfigSet("providers.openai.apiKey", "x", { workspace });
    stdout = "";
    await runConfigUnset("providers.openai.apiKey", { workspace });
    const raw1 = await fs.readFile(cfgPath, "utf-8");
    expect(raw1).toContain('[providers.openai]');
    await runConfigUnset("providers.openai.kind", { workspace });
    restore();
    const raw2 = await fs.readFile(cfgPath, "utf-8");
    expect(raw2).not.toContain("providers.openai");
  });

  it("unset returns 1 on missing key", async () => {
    const code = await runConfigUnset("defaultModel", { workspace });
    restore();
    expect(code).toBe(1);
    expect(stderr).toMatch(/was not set/);
  });
});

describe("mathran config list", () => {
  it("redacts apiKey in human output", async () => {
    await runConfigSet("defaultModel", "copilot/gpt-5.5", { workspace });
    await runConfigSet("providers.openai.kind", "openai", { workspace });
    await runConfigSet("providers.openai.apiKey", "sk-shh", { workspace });
    stdout = "";
    const code = await runConfigList({ workspace });
    restore();
    expect(code).toBe(0);
    expect(stdout).toContain("defaultModel: copilot/gpt-5.5");
    expect(stdout).toContain("openai [openai]");
    expect(stdout).toContain("apiKey = [redacted]");
    expect(stdout).not.toContain("sk-shh");
  });

  it("--json emits a structured summary", async () => {
    await runConfigSet("defaultModel", "copilot/gpt-5.5", { workspace });
    await runConfigSet("providers.openai.kind", "openai", { workspace });
    await runConfigSet("providers.openai.apiKey", "sk-shh", { workspace });
    stdout = "";
    const code = await runConfigList({ workspace, json: true });
    restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.defaultModel).toBe("copilot/gpt-5.5");
    expect(parsed.providers.openai.kind).toBe("openai");
    expect(parsed.providers.openai.apiKey).toBe("[redacted]");
    expect(parsed.configPath).toBe(cfgPath);
  });
});
