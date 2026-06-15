/**
 * `mathran doctor` — environment health check.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../../core/config.js";
import { ModelRouter, resolveApiKey } from "../../providers/llm/router.js";
import type { MathranConfig, ProviderConfig, ProviderKind } from "../../providers/llm/router.js";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Status of a single configured provider. ℹ = no key needed (local). */
export type ProviderStatus = "ok" | "missing" | "incomplete" | "no-key-needed";

export interface ProviderReport {
  key: string;
  kind: ProviderKind;
  status: ProviderStatus;
  /** Where the key came from. */
  source: "config" | "env" | "none";
  detail: string;
  model?: string;
}

const ENV_KEY_NAME: Record<ProviderKind, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  copilot: "COPILOT_TOKEN",
  ollama: "OLLAMA_API_KEY",
};

/** Mask a secret, showing only its last 4 characters. */
function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  return `…${key.slice(-4)}`;
}

/**
 * Inspect a single configured provider's key/config status without contacting
 * any API. `ollama` is treated as a local provider that needs no key.
 */
export function inspectProvider(
  key: string,
  cfg: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): ProviderReport {
  const base: ProviderReport = {
    key,
    kind: cfg.kind,
    status: "missing",
    source: "none",
    detail: "",
    model: cfg.defaultModel,
  };

  // Resolve key source: explicit config value wins over env.
  const hasConfigKey = !!cfg.apiKey && cfg.apiKey.length > 0;
  const envName = ENV_KEY_NAME[cfg.kind];
  const envVal = envName ? env[envName] : undefined;
  const resolved = resolveApiKey(cfg, env);
  const source: ProviderReport["source"] = hasConfigKey
    ? "config"
    : envVal && envVal.length > 0
      ? "env"
      : "none";

  if (cfg.kind === "ollama") {
    // Local provider: no key required; just note the base URL if present.
    return {
      ...base,
      status: "no-key-needed",
      source,
      detail: `local (no key needed)${cfg.baseUrl ? `, baseUrl=${cfg.baseUrl}` : ""}`,
    };
  }

  if (cfg.kind === "azure") {
    // Azure needs key + endpoint + deployment to be "complete".
    const missing: string[] = [];
    if (!resolved) missing.push("key");
    if (!cfg.endpoint) missing.push("endpoint");
    if (!cfg.deployment) missing.push("deployment");
    if (missing.length > 0) {
      return {
        ...base,
        status: resolved ? "incomplete" : "missing",
        source,
        detail: `missing ${missing.join(" + ")}`,
      };
    }
    return {
      ...base,
      status: "ok",
      source,
      detail: `key ${source === "config" ? "(config)" : "(env)"} ${maskKey(resolved!)}, endpoint + deployment set`,
    };
  }

  // Generic key-based providers (openai, anthropic, copilot).
  if (resolved && resolved.length > 0) {
    return {
      ...base,
      status: "ok",
      source,
      detail: `key ${source === "config" ? "(config)" : `(env ${envName})`} ${maskKey(resolved)}`,
    };
  }
  return {
    ...base,
    status: "missing",
    source: "none",
    detail: `no key (set ${envName} or providers.${key}.apiKey)`,
  };
}

function statusIcon(status: ProviderStatus): string {
  switch (status) {
    case "ok":
      return "✅";
    case "no-key-needed":
      return "ℹ️";
    default:
      return "⚠️";
  }
}

/** Build the per-provider report lines for the doctor output. */
export function buildProviderReports(
  cfg: MathranConfig,
  env: Record<string, string | undefined> = process.env,
): ProviderReport[] {
  return Object.entries(cfg.providers).map(([key, pc]) => inspectProvider(key, pc, env));
}

/**
 * Send a single minimal chat request to verify reachability. Only invoked
 * under `--probe`. Returns false on any error (kept offline-safe by default).
 */
async function probeProvider(
  cfg: ProviderConfig,
  key: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  try {
    const router = new ModelRouter({ providers: { [key]: cfg } }, { env });
    const model = cfg.defaultModel ?? "";
    const resp = await router.chat({
      model: `${key}/${model}`,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
    });
    for await (const _ of resp.stream()) {
      break;
    }
    return true;
  } catch {
    return false;
  }
}

function checkEnvVar(varName: string): Check {
  const val = process.env[varName];
  return {
    name: varName,
    pass: !!val && val.length > 0,
    detail: val ? `set (${val.length} chars)` : "not set",
  };
}

function checkCommand(cmd: string, args: string[] = ["--version"]): Check {
  try {
    const out = execSync(`${cmd} ${args.join(" ")}`, { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 })
      .toString()
      .trim()
      .split("\n")[0];
    return { name: cmd, pass: true, detail: out };
  } catch (err: any) {
    return { name: cmd, pass: false, detail: err?.message ?? "command failed" };
  }
}

function checkCopilotToken(): Check {
  const candidates = [
    path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"), "credentials", "github-copilot.token.json"),
  ];
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      const expiresAt = typeof j.expiresAt === "number" ? j.expiresAt : 0;
      const minutesLeft = Math.max(0, Math.floor((expiresAt - Date.now()) / 60000));
      const usable = j.integrationId === "vscode-chat" && expiresAt - Date.now() > 5 * 60_000;
      return {
        name: "copilot session token",
        pass: usable,
        detail: usable
          ? `${path.basename(p)} (${minutesLeft}m left, integration=${j.integrationId})`
          : `${path.basename(p)} stale or wrong integration (need fresh login)`,
      };
    } catch {
      continue;
    }
  }
  // Fallback: check OAuth config exists
  const oauth = path.join(os.homedir(), ".copilot", "config.json");
  try {
    fs.statSync(oauth);
    return {
      name: "copilot session token",
      pass: false,
      detail: `no cached session token; OAuth config present at ~/.copilot/config.json — first call will exchange one`,
    };
  } catch {
    return {
      name: "copilot session token",
      pass: false,
      detail: "no session token cache and no ~/.copilot/config.json; run `copilot` to log in",
    };
  }
}

export interface DoctorOptions {
  /** Actually send a minimal request to test reachability (default: false). */
  probe?: boolean;
  /** Injected config (defaults to loadConfig()). */
  config?: MathranConfig;
  /** Environment source (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  console.log("mathran doctor — environment health check");
  console.log("");

  const sections: Array<{ heading: string; checks: Check[] }> = [
    {
      heading: "LLM providers (need at least one)",
      checks: [
        checkCopilotToken(),
        checkEnvVar("AZURE_OPENAI_API_KEY"),
        checkEnvVar("AZURE_OPENAI_ENDPOINT"),
        checkEnvVar("OPENAI_API_KEY"),
        checkEnvVar("ANTHROPIC_API_KEY"),
        checkEnvVar("COPILOT_TOKEN"),
      ],
    },
    {
      heading: "Lean toolchain",
      checks: [
        checkCommand("elan"),
        checkCommand("lake"),
        checkCommand("lean"),
      ],
    },
    {
      heading: "Node runtime",
      checks: [
        checkCommand("node"),
        checkCommand("npm"),
      ],
    },
  ];

  let allPass = true;
  for (const sec of sections) {
    console.log(`── ${sec.heading}`);
    for (const c of sec.checks) {
      const sym = c.pass ? "✓" : "✗";
      console.log(`  ${sym}  ${c.name.padEnd(28)} ${c.detail}`);
      if (!c.pass) allPass = false;
    }
    console.log("");
  }

  // Per-provider key/config status from config.toml (PRD AC2).
  const env = opts.env ?? process.env;
  let cfg: MathranConfig;
  try {
    cfg = opts.config ?? loadConfig();
  } catch (err: any) {
    cfg = { providers: {} };
    console.log("── Configured providers (config.toml)");
    console.log(`  ✗  failed to load config: ${err?.message ?? err}`);
    console.log("");
  }
  const reports = buildProviderReports(cfg!, env);
  console.log("── Configured providers (config.toml)");
  if (reports.length === 0) {
    console.log("  ℹ️  no providers configured in config.toml");
  } else {
    for (const r of reports) {
      const icon = statusIcon(r.status);
      const label = `${r.key} [${r.kind}]${r.model ? ` ${r.model}` : ""}`;
      console.log(`  ${icon}  ${label.padEnd(34)} ${r.detail}`);
    }
  }
  console.log("");

  if (opts.probe && reports.length > 0) {
    console.log("── Provider reachability (--probe)");
    for (const r of reports) {
      if (r.status === "missing" || r.status === "incomplete") {
        console.log(`  ⚠️  ${r.key.padEnd(20)} skipped (${r.detail})`);
        continue;
      }
      const ok = await probeProvider(cfg!.providers[r.key], r.key, env);
      console.log(`  ${ok ? "✅" : "✗"}  ${r.key.padEnd(20)} ${ok ? "reachable" : "unreachable"}`);
      if (!ok) allPass = false;
    }
    console.log("");
  }

  // LLM section pass = at least one provider available
  const llmChecks = sections[0].checks;
  const llmReady = llmChecks.some((c) => c.pass);
  if (!llmReady) {
    console.error("✗ No LLM provider configured. Either:");
    console.error("    - Log into GitHub Copilot (use the `copilot` CLI), or");
    console.error("    - Set AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or");
    console.error("    - Set OPENAI_API_KEY");
    return 1;
  }

  return allPass ? 0 : 1;
}
