/**
 * Config loader — parses Mathran's `config.toml` into a MathranConfig.
 *
 * Default location: ~/mathran-workspace/config.toml. A missing file yields a
 * sensible empty config (no providers, no default model). A malformed file
 * raises a clear error.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseToml } from "smol-toml";
import type { MathranConfig, ProviderConfig, ProviderKind } from "../providers/llm/router.js";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), "mathran-workspace", "config.toml");

const VALID_KINDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "azure",
  "copilot",
  "ollama",
]);

function coerceProvider(key: string, raw: any): ProviderConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`config: provider "${key}" must be a table`);
  }
  const kind = raw.kind;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    throw new Error(
      `config: provider "${key}" has invalid kind "${kind}" (expected one of ${[...VALID_KINDS].join(", ")})`,
    );
  }
  const cfg: ProviderConfig = { kind: kind as ProviderKind };
  if (raw.apiKey !== undefined) cfg.apiKey = String(raw.apiKey);
  if (raw.baseUrl !== undefined) cfg.baseUrl = String(raw.baseUrl);
  if (raw.endpoint !== undefined) cfg.endpoint = String(raw.endpoint);
  if (raw.deployment !== undefined) cfg.deployment = String(raw.deployment);
  if (raw.apiVersion !== undefined) cfg.apiVersion = String(raw.apiVersion);
  if (raw.defaultModel !== undefined) cfg.defaultModel = String(raw.defaultModel);
  if (raw.allowedModels !== undefined) {
    if (!Array.isArray(raw.allowedModels)) {
      throw new Error(`config: provider "${key}" allowedModels must be an array of strings`);
    }
    cfg.allowedModels = raw.allowedModels.map((m: unknown) => String(m));
  }
  return cfg;
}

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): MathranConfig {
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { providers: {} };
    }
    throw new Error(`config: failed to read ${configPath}: ${err?.message ?? err}`);
  }

  let parsed: any;
  try {
    parsed = parseToml(text);
  } catch (err: any) {
    throw new Error(`config: failed to parse TOML at ${configPath}: ${err?.message ?? err}`);
  }

  const providers: Record<string, ProviderConfig> = {};
  const rawProviders = parsed?.providers;
  if (rawProviders && typeof rawProviders === "object") {
    for (const [key, value] of Object.entries(rawProviders)) {
      providers[key] = coerceProvider(key, value);
    }
  }

  const cfg: MathranConfig = { providers };
  if (typeof parsed?.defaultModel === "string") {
    cfg.defaultModel = parsed.defaultModel;
  }
  return cfg;
}
