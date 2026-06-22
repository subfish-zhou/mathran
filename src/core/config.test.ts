import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mathran-cfg-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("loadConfig", () => {
  it("parses a happy-path config with multiple providers", () => {
    const p = write(
      "config.toml",
      `
defaultModel = "openai/gpt-4o"

[providers.openai]
kind = "openai"
apiKey = "sk-test"

[providers.azure]
kind = "azure"
endpoint = "https://x.openai.azure.com"
deployment = "gpt-4o"
apiVersion = "2024-10-21"
`,
    );
    const cfg = loadConfig(p);
    expect(cfg.defaultModel).toBe("openai/gpt-4o");
    expect(cfg.providers.openai).toEqual({ kind: "openai", apiKey: "sk-test" });
    expect(cfg.providers.azure).toEqual({
      kind: "azure",
      endpoint: "https://x.openai.azure.com",
      deployment: "gpt-4o",
      apiVersion: "2024-10-21",
    });
  });

  it("returns an empty default config when the file is missing", () => {
    const cfg = loadConfig(path.join(dir, "does-not-exist.toml"));
    expect(cfg).toEqual({ providers: {} });
    expect(cfg.defaultModel).toBeUndefined();
  });

  it("throws a clear error on malformed TOML", () => {
    const p = write("bad.toml", "this is = = not valid toml ][");
    expect(() => loadConfig(p)).toThrow(/failed to parse TOML/);
  });

  it("rejects a provider with an invalid kind", () => {
    const p = write(
      "badkind.toml",
      `
[providers.weird]
kind = "not-a-real-kind"
`,
    );
    expect(() => loadConfig(p)).toThrow(/invalid kind/);
  });

  it("handles a config with no providers table", () => {
    const p = write("nostuff.toml", `defaultModel = "openai/gpt-4o"\n`);
    const cfg = loadConfig(p);
    expect(cfg.defaultModel).toBe("openai/gpt-4o");
    expect(cfg.providers).toEqual({});
  });

  it("parses a copilot provider with an allowedModels whitelist", () => {
    const p = write(
      "copilot.toml",
      `
defaultModel = "copilot/gpt-5.5"

[providers.copilot]
kind = "copilot"
defaultModel = "gpt-5.5"
allowedModels = ["gpt-5.5", "claude-opus-4.8"]
`,
    );
    const cfg = loadConfig(p);
    expect(cfg.providers.copilot).toEqual({
      kind: "copilot",
      defaultModel: "gpt-5.5",
      allowedModels: ["gpt-5.5", "claude-opus-4.8"],
    });
  });

  it("leaves allowedModels undefined when omitted (fail-open)", () => {
    const p = write(
      "copilot-nolist.toml",
      `
[providers.copilot]
kind = "copilot"
defaultModel = "gpt-5.5"
`,
    );
    const cfg = loadConfig(p);
    expect(cfg.providers.copilot.allowedModels).toBeUndefined();
  });

  it("rejects allowedModels that is not an array", () => {
    const p = write(
      "copilot-bad.toml",
      `
[providers.copilot]
kind = "copilot"
allowedModels = "gpt-5.5"
`,
    );
    expect(() => loadConfig(p)).toThrow(/allowedModels must be an array/);
  });
});
