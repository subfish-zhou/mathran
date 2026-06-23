/**
 * McpRegistry — process-level manager for all configured MCP servers (v1).
 *
 * One registry owns N {@link McpClient}s. It is the single integration point
 * the rest of mathran touches:
 *
 *   - `init()`         load config + connect every enabled server,
 *   - `toolSpecs()`    project all connected servers' tools into mathran
 *                      {@link ToolSpec}s (namespaced + approval-gated),
 *   - `callTool()`     route a namespaced call back to the owning client,
 *   - `reload()/reloadAll()`  re-spawn a server (resets retry budget),
 *   - `shutdown()`     tear everything down,
 *   - `status()`       snapshot for `/mcp` + the SPA panel.
 *
 * Crash policy (PLAN): a server that exits unexpectedly is retried up to
 * `maxRetries` (default 3) times when `autoRestart` is on; after the budget is
 * exhausted it is parked as `disabled` and only an explicit `reload()` revives
 * it. A misconfigured server is skipped at load time and never blocks the rest.
 *
 * The registry is purely additive: when no servers are configured every method
 * is a cheap no-op and mathran behaves exactly as before.
 */

import type { ToolSpec } from "../chat/session.js";
import { McpClient, type McpClientState, type McpClientFactory } from "./client.js";
import { loadMcpConfig, type LoadMcpConfigOpts, type McpServerConfig } from "./schema.js";
import { namespaceToolName, parseMcpToolName } from "./naming.js";
import { diffServerConfigs, type ServerConfigDiff } from "./watcher.js";

export type McpServerStatus = "connected" | "disconnected" | "disabled";

export interface McpServerStatusInfo {
  name: string;
  status: McpServerStatus;
  state: McpClientState;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  retries: number;
  lastError: string | null;
  command: string;
  transport: "stdio" | "http";
  scope: "global" | "per-conversation";
}

export interface McpRegistryOptions {
  /** Max crash retries before a server is parked as `disabled`. Default 3. */
  maxRetries?: number;
  /** Backoff (ms) between crash retries. Default 500. Set 0 in tests. */
  retryDelayMs?: number;
  /** Injectable client factory (tests). Defaults to the real SDK stdio client. */
  clientFactory?: McpClientFactory;
}

interface ManagedServer {
  config: McpServerConfig;
  client: McpClient;
  status: McpServerStatus;
  retries: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

export class McpRegistry {
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly clientFactory?: McpClientFactory;
  private servers = new Map<string, ManagedServer>();
  private warnings: string[] = [];
  private initialized = false;

  constructor(opts: McpRegistryOptions = {}) {
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.clientFactory = opts.clientFactory;
  }

  /** Warnings accumulated during the last `init()` (bad config etc.). */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Load config + connect every enabled server. Idempotent: a second call is a
   * no-op (use `reloadAll()` to re-read config). Never throws — connect
   * failures land in each server's status.
   */
  async init(opts: LoadMcpConfigOpts): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const { servers, warnings } = loadMcpConfig(opts);
    this.warnings = warnings;
    for (const w of warnings) {
      // eslint-disable-next-line no-console
      console.warn(w);
    }
    await Promise.all(
      servers.map(async (config) => {
        if (!config.enabled) {
          this.servers.set(config.name, {
            config,
            client: this.makeClient(config),
            status: "disabled",
            retries: 0,
          });
          return;
        }
        const managed: ManagedServer = {
          config,
          client: this.makeClient(config),
          status: "disconnected",
          retries: 0,
        };
        this.servers.set(config.name, managed);
        await this.connectServer(managed);
      }),
    );
  }

  private makeClient(config: McpServerConfig): McpClient {
    return new McpClient({
      config,
      ...(this.clientFactory ? { clientFactory: this.clientFactory } : {}),
      onCrash: (name) => {
        void this.handleCrash(name);
      },
    });
  }

  private async connectServer(managed: ManagedServer): Promise<void> {
    const ok = await managed.client.connect();
    managed.status = ok ? "connected" : "disconnected";
  }

  /**
   * Crash handler driving the retry/disable budget. Fired by a client's
   * transport close after a successful connect.
   */
  private async handleCrash(name: string): Promise<void> {
    const managed = this.servers.get(name);
    if (!managed) return;
    if (managed.status === "disabled") return;
    managed.status = "disconnected";
    if (!managed.config.autoRestart || managed.retries >= this.maxRetries) {
      managed.status = "disabled";
      // eslint-disable-next-line no-console
      console.warn(
        `[mcp] server "${name}" crashed and exhausted its retry budget (${managed.retries}/${this.maxRetries}); disabled. Run /mcp ${name} reload to retry.`,
      );
      return;
    }
    managed.retries += 1;
    if (this.retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
    }
    // The managed entry could have been reloaded/disabled while we waited.
    const current = this.servers.get(name);
    if (!current || current !== managed || current.status === "disabled") return;
    // eslint-disable-next-line no-console
    console.warn(`[mcp] retrying server "${name}" (attempt ${managed.retries}/${this.maxRetries})…`);
    // Fresh client so a dead transport isn't reused.
    managed.client = this.makeClient(managed.config);
    const ok = await managed.client.connect();
    if (ok) {
      managed.status = "connected";
      // eslint-disable-next-line no-console
      console.warn(`[mcp] server "${name}" reconnected.`);
    } else {
      managed.status = "disconnected";
      // Connect failed synchronously (no crash callback) — count it and stop or
      // schedule another attempt up to the budget.
      if (managed.retries >= this.maxRetries) {
        managed.status = "disabled";
        // eslint-disable-next-line no-console
        console.warn(
          `[mcp] server "${name}" failed to reconnect and exhausted its retry budget; disabled.`,
        );
      } else {
        void this.handleCrash(name);
      }
    }
  }

  /** Status snapshot for every known server (any state). */
  status(): McpServerStatusInfo[] {
    return [...this.servers.values()].map((m) => ({
      name: m.config.name,
      status: m.status,
      state: m.client.state,
      toolCount: m.status === "connected" ? m.client.tools.length : 0,
      promptCount: m.status === "connected" ? m.client.prompts.length : 0,
      resourceCount: m.status === "connected" ? m.client.resources.length : 0,
      retries: m.retries,
      lastError: m.client.lastError,
      command: [m.config.command ?? m.config.url ?? "", ...m.config.args].join(" ").trim(),
      transport: m.config.transport,
      scope: m.config.scope,
    }));
  }

  /** Status for a single server, or null when unknown. */
  statusFor(name: string): McpServerStatusInfo | null {
    return this.status().find((s) => s.name === name) ?? null;
  }

  /** Bare tool descriptors for one connected server (for `/mcp <name> tools`). */
  toolsFor(name: string): Array<{ name: string; description?: string }> {
    const managed = this.servers.get(name);
    if (!managed || managed.status !== "connected") return [];
    return managed.client.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
    }));
  }

  /** Every connected server's tools, namespaced. */
  listAllTools(): Array<{ server: string; tool: string; namespaced: string }> {
    const out: Array<{ server: string; tool: string; namespaced: string }> = [];
    for (const m of this.servers.values()) {
      if (m.status !== "connected") continue;
      for (const t of m.client.tools) {
        out.push({
          server: m.config.name,
          tool: t.name,
          namespaced: namespaceToolName(m.config.name, t.name),
        });
      }
    }
    return out;
  }

  /**
   * Project all connected MCP tools into mathran {@link ToolSpec}s. Each spec:
   *   - is named `mcp__<server>__<tool>`,
   *   - carries the upstream JSON Schema as `parameters`,
   *   - is `riskClass: "exec"` so it flows through the approval policy exactly
   *     like `dispatch_subagent` (PLAN 安全),
   *   - dispatches back through `callTool`.
   *
   * When any connected server advertises resources, a single
   * `get_mcp_resource` tool is appended so the LLM can pull a resource by URI.
   */
  toolSpecs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const m of this.servers.values()) {
      if (m.status !== "connected") continue;
      const serverName = m.config.name;
      for (const tool of m.client.tools) {
        const namespaced = namespaceToolName(serverName, tool.name);
        specs.push({
          name: namespaced,
          riskClass: "exec",
          ...(tool.description
            ? { description: `[MCP:${serverName}] ${tool.description}` }
            : { description: `[MCP:${serverName}] ${tool.name}` }),
          parameters: normalizeParameters(tool.inputSchema),
          execute: async (args: Record<string, unknown>) => {
            return this.callTool(serverName, tool.name, args ?? {});
          },
        });
      }
    }
    if (this.listAllResources().length > 0) {
      specs.push(this.makeGetResourceTool());
    }
    return specs;
  }

  /** Every connected server's prompts, namespaced `mcp__<server>__<prompt>`. */
  listAllPrompts(): Array<{
    server: string;
    name: string;
    namespaced: string;
    description?: string;
  }> {
    const out: Array<{ server: string; name: string; namespaced: string; description?: string }> = [];
    for (const m of this.servers.values()) {
      if (m.status !== "connected") continue;
      for (const p of m.client.prompts) {
        out.push({
          server: m.config.name,
          name: p.name,
          namespaced: namespaceToolName(m.config.name, p.name),
          ...(p.description ? { description: p.description } : {}),
        });
      }
    }
    return out;
  }

  /** Bare prompt descriptors for one connected server (for `/mcp <name> prompts`). */
  promptsFor(name: string): Array<{ name: string; description?: string }> {
    const managed = this.servers.get(name);
    if (!managed || managed.status !== "connected") return [];
    return managed.client.prompts.map((p) => ({
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
    }));
  }

  /** Every connected server's resources. */
  listAllResources(): Array<{
    server: string;
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
  }> {
    const out: Array<{ server: string; uri: string; name?: string; description?: string; mimeType?: string }> = [];
    for (const m of this.servers.values()) {
      if (m.status !== "connected") continue;
      for (const r of m.client.resources) {
        out.push({
          server: m.config.name,
          uri: r.uri,
          ...(r.name ? { name: r.name } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        });
      }
    }
    return out;
  }

  /** Bare resource descriptors for one connected server. */
  resourcesFor(name: string): Array<{ uri: string; name?: string; description?: string }> {
    const managed = this.servers.get(name);
    if (!managed || managed.status !== "connected") return [];
    return managed.client.resources.map((r) => ({
      uri: r.uri,
      ...(r.name ? { name: r.name } : {}),
      ...(r.description ? { description: r.description } : {}),
    }));
  }

  /** Fetch a prompt's text. `name` may be bare (with `server`) or namespaced. */
  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string> = {},
  ): Promise<{ ok: boolean; content: string }> {
    const managed = this.servers.get(serverName);
    if (!managed || managed.status !== "connected") {
      return { ok: false, content: `mcp server "${serverName}" is not connected` };
    }
    return managed.client.getPrompt(promptName, args);
  }

  /** Read a resource by URI from a given server. */
  async readResource(serverName: string, uri: string): Promise<{ ok: boolean; content: string }> {
    const managed = this.servers.get(serverName);
    if (!managed || managed.status !== "connected") {
      return { ok: false, content: `mcp server "${serverName}" is not connected` };
    }
    return managed.client.readResource(uri);
  }

  /**
   * Single `get_mcp_resource` tool exposed to the LLM. Args: `{ server, uri }`.
   * `riskClass: "read"` — resources are read-only by definition.
   */
  private makeGetResourceTool(): ToolSpec {
    return {
      name: "get_mcp_resource",
      riskClass: "read",
      description:
        "Read a resource advertised by a connected MCP server. Provide the server name and the resource uri (see /mcp <server> resources).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name." },
          uri: { type: "string", description: "Resource URI to read." },
        },
        required: ["server", "uri"],
      },
      execute: async (args: Record<string, unknown>) => {
        const server = typeof args.server === "string" ? args.server : "";
        const uri = typeof args.uri === "string" ? args.uri : "";
        if (!server || !uri) {
          return { ok: false, content: "get_mcp_resource requires { server, uri }" };
        }
        return this.readResource(server, uri);
      },
    };
  }

  /** Route a call to the owning client. `toolName` is the BARE upstream name. */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const managed = this.servers.get(serverName);
    if (!managed) {
      return { ok: false, content: `unknown mcp server "${serverName}"` };
    }
    if (managed.status !== "connected") {
      return {
        ok: false,
        content: `mcp server "${serverName}" is ${managed.status}; cannot call "${toolName}"`,
      };
    }
    return managed.client.callTool(toolName, args);
  }

  /** Route a call by its namespaced name (`mcp__<server>__<tool>`). */
  async callNamespaced(
    namespaced: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string }> {
    const parsed = parseMcpToolName(namespaced);
    if (!parsed) {
      return { ok: false, content: `not a namespaced mcp tool: "${namespaced}"` };
    }
    return this.callTool(parsed.serverName, parsed.toolName, args);
  }

  /**
   * Reload a single server: tear it down and reconnect, resetting its retry
   * budget. Revives a `disabled` server. Returns the post-reload status.
   */
  async reload(name: string): Promise<McpServerStatusInfo | null> {
    const managed = this.servers.get(name);
    if (!managed) return null;
    await managed.client.disconnect();
    managed.client = this.makeClient(managed.config);
    managed.retries = 0;
    managed.status = "disconnected";
    if (managed.config.enabled) {
      await this.connectServer(managed);
    } else {
      managed.status = "disabled";
    }
    return this.statusFor(name);
  }

  /** Reload every known server. */
  async reloadAll(): Promise<McpServerStatusInfo[]> {
    await Promise.all([...this.servers.keys()].map((n) => this.reload(n)));
    return this.status();
  }

  /**
   * Add a server config at runtime (hot reload `added`). Connects it when
   * enabled. A name collision replaces the existing entry (use `reload` to keep
   * the same config). Never throws.
   */
  async addServer(config: McpServerConfig): Promise<McpServerStatusInfo | null> {
    const existing = this.servers.get(config.name);
    if (existing) await existing.client.disconnect();
    const managed: ManagedServer = {
      config,
      client: this.makeClient(config),
      status: config.enabled ? "disconnected" : "disabled",
      retries: 0,
    };
    this.servers.set(config.name, managed);
    if (config.enabled) await this.connectServer(managed);
    return this.statusFor(config.name);
  }

  /** Remove + disconnect a server at runtime (hot reload `removed`). */
  async removeServer(name: string): Promise<boolean> {
    const managed = this.servers.get(name);
    if (!managed) return false;
    await managed.client.disconnect();
    this.servers.delete(name);
    return true;
  }

  /** Names of all currently-managed servers (any status). */
  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  /**
   * Re-read the on-disk config and apply the delta to the live set without
   * tearing down unaffected servers (PLAN #4 hot reload). Returns the diff.
   * Even when the registry hasn't been `init()`ed this works (it just adds).
   */
  async reloadFromConfig(opts: LoadMcpConfigOpts): Promise<ServerConfigDiff> {
    const { servers, warnings } = loadMcpConfig(opts);
    this.warnings = warnings;
    const current = [...this.servers.values()].map((m) => m.config);
    const diff = diffServerConfigs(current, servers);
    for (const name of diff.removed) {
      await this.removeServer(name);
    }
    for (const cfg of diff.added) {
      await this.addServer(cfg);
    }
    for (const cfg of diff.changed) {
      // Replace config then reload so the new command/url/transport takes effect.
      const managed = this.servers.get(cfg.name);
      if (managed) managed.config = cfg;
      await this.addServer(cfg);
    }
    this.initialized = true;
    return diff;
  }

  /** Tear down every server. Safe to call multiple times. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.servers.values()].map((m) => m.client.disconnect()),
    );
    this.servers.clear();
    this.initialized = false;
  }
}

/**
 * Ensure the tool parameters are a JSON-Schema *object* mathran's adapters can
 * forward. MCP guarantees `inputSchema` is an object schema, but a defensive
 * fallback keeps a malformed upstream schema from breaking the tool list.
 */
function normalizeParameters(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && typeof schema === "object" && schema.type === "object") {
    return schema;
  }
  return { type: "object", properties: schema?.properties ?? {} };
}

// ── Process-level singleton ─────────────────────────────────────────────────

let globalRegistry: McpRegistry | null = null;

/** The shared process-level registry (created on first access). */
export function getGlobalMcpRegistry(): McpRegistry {
  if (!globalRegistry) globalRegistry = new McpRegistry();
  return globalRegistry;
}

/** Test hook: replace / clear the process singleton. */
export function setGlobalMcpRegistry(registry: McpRegistry | null): void {
  globalRegistry = registry;
}
