import { describe, it, expect, vi, afterEach } from "vitest";
import {
  inspectProvider,
  buildProviderReports,
  runDoctor,
} from "./doctor.js";
import type { MathranConfig } from "../../providers/llm/router.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inspectProvider", () => {
  it("reports ok with env key (masked, never raw)", () => {
    const r = inspectProvider(
      "openai",
      { kind: "openai", defaultModel: "gpt-4o" },
      { OPENAI_API_KEY: "sk-secret-1234" },
    );
    expect(r.status).toBe("ok");
    expect(r.source).toBe("env");
    expect(r.detail).toContain("1234");
    expect(r.detail).not.toContain("sk-secret-1234");
  });

  it("prefers config key over env", () => {
    const r = inspectProvider(
      "anthropic",
      { kind: "anthropic", apiKey: "config-key-9999" },
      { ANTHROPIC_API_KEY: "env-key-0000" },
    );
    expect(r.status).toBe("ok");
    expect(r.source).toBe("config");
    expect(r.detail).toContain("9999");
  });

  it("reports missing when no key present", () => {
    const r = inspectProvider("openai", { kind: "openai" }, {});
    expect(r.status).toBe("missing");
    expect(r.source).toBe("none");
  });

  it("reports no-key-needed for local ollama", () => {
    const r = inspectProvider(
      "local",
      { kind: "ollama", baseUrl: "http://localhost:11434" },
      {},
    );
    expect(r.status).toBe("no-key-needed");
    expect(r.detail).toContain("no key needed");
  });

  it("requires endpoint + deployment for azure to be complete", () => {
    const incomplete = inspectProvider(
      "az",
      { kind: "azure" },
      { AZURE_OPENAI_API_KEY: "azkey-4321" },
    );
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.detail).toContain("endpoint");
    expect(incomplete.detail).toContain("deployment");

    const complete = inspectProvider(
      "az",
      { kind: "azure", endpoint: "https://x.openai.azure.com", deployment: "gpt55" },
      { AZURE_OPENAI_API_KEY: "azkey-4321" },
    );
    expect(complete.status).toBe("ok");
  });
});

describe("buildProviderReports", () => {
  it("produces one report per configured provider", () => {
    const cfg: MathranConfig = {
      providers: {
        openai: { kind: "openai" },
        local: { kind: "ollama" },
      },
    };
    const reports = buildProviderReports(cfg, {});
    expect(reports.map((r) => r.key).sort()).toEqual(["local", "openai"]);
  });
});

describe("runDoctor — provider section", () => {
  it("prints per-provider rows with status icons and never prints raw keys", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      lines.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const cfg: MathranConfig = {
      providers: {
        openai: { kind: "openai", defaultModel: "gpt-4o" },
        az: { kind: "azure", endpoint: "https://x", deployment: "d" },
        local: { kind: "ollama" },
      },
    };
    const env = {
      OPENAI_API_KEY: "sk-raw-secret-aaaa",
      AZURE_OPENAI_API_KEY: "az-raw-bbbb",
    };

    await runDoctor({ config: cfg, env });

    const out = lines.join("\n");
    expect(out).toContain("Configured providers");
    // openai: has key → ✅
    expect(out).toMatch(/✅.*openai/);
    // azure complete → ✅
    expect(out).toMatch(/✅.*az/);
    // ollama → ℹ️
    expect(out).toMatch(/ℹ️.*local/);
    // never leak raw secrets
    expect(out).not.toContain("sk-raw-secret-aaaa");
    expect(out).not.toContain("az-raw-bbbb");
  });

  it("warns when a provider is missing its key", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      lines.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const cfg: MathranConfig = {
      providers: { openai: { kind: "openai" } },
    };
    await runDoctor({ config: cfg, env: { OPENAI_API_KEY: "" } });

    const out = lines.join("\n");
    expect(out).toMatch(/⚠️.*openai/);
  });

  it("does not probe APIs by default", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockImplementation(() => {
      throw new Error("network should not be hit");
    });

    const cfg: MathranConfig = {
      providers: { openai: { kind: "openai" } },
    };
    await runDoctor({ config: cfg, env: { OPENAI_API_KEY: "sk-1234" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
