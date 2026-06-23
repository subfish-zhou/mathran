/**
 * ModelRouter — a single LLMProvider that fans out to per-provider adapters
 * based on a "provider/model" routing string.
 *
 * Routing:
 *   - `req.model` containing "/"  → "<providerKey>/<realModel>"
 *   - `req.model` without "/"     → resolve provider from `defaultModel`'s
 *                                    prefix (if any) or the first provider key;
 *                                    the bare string is the real model.
 *
 * API-key resolution priority: explicit ProviderConfig.apiKey > process.env >
 * (config file value, which *is* ProviderConfig.apiKey). Adapters are
 * instantiated lazily (on first use) and cached, so a missing key for an
 * unused provider never crashes the router.
 */

import type { LLMProvider, LLMRequest, LLMResponse, LLMMessage } from "../../core/providers/llm.js";
import { OpenAIAdapter } from "./openai.js";
import { AnthropicAdapter } from "./anthropic.js";
import { AzureOpenAIAdapter } from "./azure.js";
import { OllamaAdapter } from "./ollama.js";
import { CopilotAdapter } from "./copilot-adapter.js";
import { createFallbackTokenCounter } from "../../core/chat/token-counter.js";

export type ProviderKind = "openai" | "anthropic" | "azure" | "copilot" | "ollama";

export interface ProviderConfig {
  kind: ProviderKind;
  apiKey?: string;
  baseUrl?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  /** Optional default model for this provider when none is supplied. */
  defaultModel?: string;
  /**
   * Optional whitelist of bare model names this provider will accept. When set,
   * a request whose resolved model is not in the list is rejected with a clear
   * error listing the allowed models. When omitted (or empty), no whitelist
   * check is performed — any model string is forwarded to the adapter
   * (fail-open, for backward compatibility).
   */
  allowedModels?: string[];
}

export interface MathranConfig {
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
}

export type AdapterFactory = (
  providerKey: string,
  cfg: ProviderConfig,
) => LLMProvider;

export interface ModelRouterOptions {
  /** Injection seam for tests; defaults to building real adapters. */
  adapterFactory?: AdapterFactory;
  /** Environment source (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

const ENV_KEY: Record<ProviderKind, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  copilot: "COPILOT_TOKEN",
  ollama: "OLLAMA_API_KEY",
};

/** Resolve an API key: explicit config value wins, then the env var. */
export function resolveApiKey(
  cfg: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (cfg.apiKey && cfg.apiKey.length > 0) return cfg.apiKey;
  const envName = ENV_KEY[cfg.kind];
  return envName ? env[envName] : undefined;
}

export class ModelRouter implements LLMProvider {
  private cfg: MathranConfig;
  private env: Record<string, string | undefined>;
  private factory: AdapterFactory;
  private cache = new Map<string, LLMProvider>();

  constructor(cfg: MathranConfig, opts: ModelRouterOptions = {}) {
    this.cfg = cfg;
    this.env = opts.env ?? process.env;
    this.factory = opts.adapterFactory ?? ((key, c) => this.defaultFactory(key, c));
  }

  async describe(): Promise<{ name: string; defaultModel?: string }> {
    return { name: "model-router", defaultModel: this.cfg.defaultModel };
  }

  /**
   * Aggregate vision capability per route. Returns true when the adapter
   * the router would dispatch to (resolved from `modelString` like
   * `provider/model`) declares `supportsVision = true`. The host calls this
   * BEFORE issuing the chat request so it can decide whether to forward
   * `ContentPart[]` (image parts) or degrade-fallback to a `[Image: ...]`
   * text marker injected by chat-attachments.
   *
   * Returns false when:
   *   - the routing string can't be resolved (no providers configured),
   *   - the resolved provider lazily-constructed adapter would throw
   *     (e.g. missing API key for an unused provider — we don't want a
   *     vision probe to crash the unrelated route),
   *   - the adapter exists but doesn't set `supportsVision`.
   *
   * Named `routeSupportsVision` (not `supportsVision`) to avoid colliding
   * with the boolean field on the `LLMProvider` interface — the router
   * itself is per-route-aware so a single static boolean wouldn't make
   * sense.
   */
  routeSupportsVision(modelString: string): boolean {
    try {
      const { providerKey } = this.resolve(modelString);
      const adapter = this.getAdapter(providerKey);
      return adapter.supportsVision === true;
    } catch {
      return false;
    }
  }

  async chat(req: LLMRequest): Promise<LLMResponse> {
    const { providerKey, model } = this.resolve(req.model);
    this.assertModelAllowed(providerKey, model);
    const adapter = this.getAdapter(providerKey);
    return adapter.chat({ ...req, model });
  }

  /**
   * Enforce a provider's `allowedModels` whitelist (when configured). Throws a
   * clear error listing the allowed models if `model` is not permitted. A
   * provider without `allowedModels` (or with an empty list) imposes no
   * restriction.
   */
  assertModelAllowed(providerKey: string, model: string): void {
    const cfg = this.cfg.providers[providerKey];
    const allowed = cfg?.allowedModels;
    if (!allowed || allowed.length === 0) return;
    if (!allowed.includes(model)) {
      throw new Error(
        `ModelRouter: model "${model}" is not allowed for provider "${providerKey}". ` +
          `Allowed models: ${allowed.join(", ")}`,
      );
    }
  }

  /**
   * Delegate token counting to the provider the router would route to for the
   * default model. Falls back to the legacy char/4 counter when no provider
   * resolves or the inner provider lacks `countTokens`.
   */
  countTokens(messages: LLMMessage[]): number {
    let adapter: LLMProvider | undefined;
    try {
      const { providerKey } = this.resolve(this.cfg.defaultModel ?? "");
      adapter = this.getAdapter(providerKey);
    } catch {
      adapter = undefined;
    }
    if (adapter?.countTokens) return adapter.countTokens(messages);
    return createFallbackTokenCounter().countMessages(messages);
  }

  /** Parse a routing string into a provider key + real model name. */
  resolve(modelString: string): { providerKey: string; model: string } {
    const raw = modelString ?? "";
    if (raw.includes("/")) {
      const slash = raw.indexOf("/");
      const providerKey = raw.slice(0, slash);
      const model = raw.slice(slash + 1);
      return { providerKey, model };
    }
    // No prefix: resolve the provider from defaultModel or the first provider.
    const def = this.cfg.defaultModel;
    if (def && def.includes("/")) {
      const slash = def.indexOf("/");
      const providerKey = def.slice(0, slash);
      const model = raw.length > 0 ? raw : def.slice(slash + 1);
      return { providerKey, model };
    }
    const firstKey = Object.keys(this.cfg.providers)[0];
    if (!firstKey) {
      throw new Error("ModelRouter: no providers configured");
    }
    const model = raw.length > 0 ? raw : (def ?? this.cfg.providers[firstKey].defaultModel ?? "");
    return { providerKey: firstKey, model };
  }

  private getAdapter(providerKey: string): LLMProvider {
    const existing = this.cache.get(providerKey);
    if (existing) return existing;
    const cfg = this.cfg.providers[providerKey];
    if (!cfg) {
      throw new Error(
        `ModelRouter: unknown provider "${providerKey}" (known: ${Object.keys(this.cfg.providers).join(", ") || "none"})`,
      );
    }
    const adapter = this.factory(providerKey, cfg);
    this.cache.set(providerKey, adapter);
    return adapter;
  }

  private defaultFactory(_providerKey: string, cfg: ProviderConfig): LLMProvider {
    const apiKey = resolveApiKey(cfg, this.env);
    switch (cfg.kind) {
      case "openai":
        if (!apiKey) throw new Error("OpenAI provider requires an API key (config.apiKey or OPENAI_API_KEY)");
        return new OpenAIAdapter({ apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel });
      case "anthropic":
        if (!apiKey) throw new Error("Anthropic provider requires an API key (config.apiKey or ANTHROPIC_API_KEY)");
        return new AnthropicAdapter({ apiKey, baseUrl: cfg.baseUrl, defaultModel: cfg.defaultModel });
      case "azure":
        if (!apiKey) throw new Error("Azure provider requires an API key (config.apiKey or AZURE_OPENAI_API_KEY)");
        if (!cfg.endpoint || !cfg.deployment || !cfg.apiVersion) {
          throw new Error("Azure provider requires endpoint, deployment and apiVersion");
        }
        return new AzureOpenAIAdapter({
          apiKey,
          endpoint: cfg.endpoint,
          deployment: cfg.deployment,
          apiVersion: cfg.apiVersion,
          defaultModel: cfg.defaultModel,
        });
      case "ollama":
        return new OllamaAdapter({ baseUrl: cfg.baseUrl, apiKey, defaultModel: cfg.defaultModel });
      case "copilot":
        return new CopilotAdapter({ defaultModel: cfg.defaultModel });
      default:
        throw new Error(`ModelRouter: unsupported provider kind "${(cfg as ProviderConfig).kind}"`);
    }
  }
}
