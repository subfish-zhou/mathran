/**
 * McpClient — thin lifecycle wrapper around the official MCP SDK `Client` over
 * a stdio transport (v1, client-only).
 *
 * Responsibilities:
 *   - spawn the server subprocess (`StdioClientTransport`) and run the MCP
 *     initialize handshake (`connect`),
 *   - cache the server's advertised `tools` (`listTools`),
 *   - proxy `callTool`,
 *   - surface a crash (transport `onclose`/`onerror`) to the owner via an
 *     `onCrash` callback so the registry can drive retry/disable.
 *
 * Everything here is defensive: connect/list/call failures resolve to typed
 * error results rather than throwing across the registry boundary, so one bad
 * server can never crash mathran (PLAN 安全: 进程隔离).
 *
 * The SDK transport is dynamically imported so the (heavy) SDK only loads when
 * a server is actually configured.
 */

import type { McpServerConfig } from "./schema.js";

/** A tool descriptor as advertised by an upstream MCP server. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** Upstream JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/** A prompt descriptor as advertised by an upstream MCP server. */
export interface McpPromptDescriptor {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** A resource descriptor as advertised by an upstream MCP server. */
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Normalised result of a `callTool` round-trip. */
export interface McpCallResult {
  ok: boolean;
  /** Flattened textual content, ready to feed back to the LLM. */
  content: string;
}

export type McpClientState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface McpClientOptions {
  config: McpServerConfig;
  /**
   * Fired when the transport closes or errors *after* a successful connect
   * (i.e. the server crashed / exited). Not fired for an explicit
   * `disconnect()`. The registry uses this to drive the retry/disable policy.
   */
  onCrash?: (serverName: string, error: Error) => void;
  /**
   * Channels v1 — fired on EVERY notification the upstream MCP server
   * pushes that doesn't have a more-specific handler installed (i.e.
   * we wire this onto the SDK's `fallbackNotificationHandler`). The
   * registry uses this to forward `mathran/channel` pushes into the
   * channels bus. Other methods are also surfaced here so callers can
   * extend without re-wiring the bridge (e.g. future `mathran/progress`).
   *
   * The first arg is the upstream server's configured name (NOT its
   * advertised name), so the channel tag stays stable across server
   * version bumps.
   */
  onNotification?: (serverName: string, method: string, params: unknown) => void;
  /** Injectable client factory for tests (defaults to the real SDK). */
  clientFactory?: McpClientFactory;
}

/**
 * Minimal structural contract of the SDK `Client` we depend on. Declared
 * locally so tests can supply a fake without importing the SDK and so the SDK
 * import stays lazy.
 */
export interface SdkLikeClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  listPrompts?(): Promise<{ prompts: Array<{ name: string; description?: string; arguments?: unknown }> }>;
  listResources?(): Promise<{ resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }> }>;
  getPrompt?(params: { name: string; arguments?: Record<string, string> }): Promise<unknown>;
  readResource?(params: { uri: string }): Promise<unknown>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
  getServerVersion?(): { name?: string; version?: string } | undefined;
  /**
   * Channels v1 — set the catch-all notification handler. The real SDK
   * exposes this via `Protocol.fallbackNotificationHandler` (a settable
   * property, not a method). We expose both shapes structurally so
   * test fakes can pick either: an injectable `setFallbackNotificationHandler`
   * method, or a settable `fallbackNotificationHandler` property.
   */
  setFallbackNotificationHandler?: (
    handler: (notification: { method: string; params?: unknown }) => void | Promise<void>,
  ) => void;
  fallbackNotificationHandler?: (
    notification: { method: string; params?: unknown },
  ) => void | Promise<void>;
}

export interface SdkLikeTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export interface McpClientFactory {
  /**
   * Build a connected-but-not-yet-connected `{ client, transport }` pair for
   * the given server config. The returned `client.connect(transport)` performs
   * the handshake.
   */
  create(config: McpServerConfig): Promise<{ client: SdkLikeClient; transport: SdkLikeTransport }>;
}

/** Default factory: real MCP SDK over stdio or http (SSE). Lazily imported. */
export const defaultMcpClientFactory: McpClientFactory = {
  async create(config: McpServerConfig) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "mathran", version: "0.12.0" });
    if (config.transport === "http") {
      const { SSEClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/sse.js"
      );
      const headers: Record<string, string> = { ...config.headers };
      if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
      const transport = new SSEClientTransport(new URL(config.url as string), {
        // Attach auth headers to BOTH the SSE GET and the POST messages.
        eventSourceInit: {
          fetch: (url: string | URL | Request, init?: RequestInit) =>
            fetch(url as RequestInfo, {
              ...init,
              headers: { ...(init?.headers as Record<string, string>), ...headers },
            }),
        } as unknown as Record<string, unknown>,
        requestInit: { headers },
      });
      return {
        client: client as unknown as SdkLikeClient,
        transport: transport as unknown as SdkLikeTransport,
      };
    }
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    const transport = new StdioClientTransport({
      command: config.command as string,
      args: config.args,
      // Merge the configured env on top of the SDK's safe default env. The
      // child still inherits PATH etc. from the default-env helper.
      env: { ...config.env },
      stderr: "inherit",
    });
    return {
      client: client as unknown as SdkLikeClient,
      transport: transport as unknown as SdkLikeTransport,
    };
  },
};

/** Flatten an SDK `callTool` result's `content[]` into plain text. */
export function flattenToolResult(result: unknown): McpCallResult {
  if (!result || typeof result !== "object") {
    return { ok: true, content: "" };
  }
  const r = result as { content?: unknown; isError?: boolean };
  const isError = r.isError === true;
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const item of r.content) {
      if (!item || typeof item !== "object") continue;
      const block = item as { type?: string; text?: string };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block.type === "resource") {
        const res = (item as { resource?: { text?: string; uri?: string } }).resource;
        if (res?.text) parts.push(res.text);
        else if (res?.uri) parts.push(`[resource: ${res.uri}]`);
      } else if (block.type) {
        parts.push(`[${block.type} content omitted]`);
      }
    }
  }
  return { ok: !isError, content: parts.join("\n") };
}

export class McpClient {
  readonly config: McpServerConfig;
  private readonly onCrash?: McpClientOptions["onCrash"];
  private readonly onNotification?: McpClientOptions["onNotification"];
  private readonly factory: McpClientFactory;

  private client: SdkLikeClient | null = null;
  private _state: McpClientState = "idle";
  private _tools: McpToolDescriptor[] = [];
  private _prompts: McpPromptDescriptor[] = [];
  private _resources: McpResourceDescriptor[] = [];
  private _lastError: string | null = null;
  /** Set while we deliberately tear down, to suppress the crash callback. */
  private intentionalClose = false;

  constructor(opts: McpClientOptions) {
    this.config = opts.config;
    this.onCrash = opts.onCrash;
    this.onNotification = opts.onNotification;
    this.factory = opts.clientFactory ?? defaultMcpClientFactory;
  }

  get state(): McpClientState {
    return this._state;
  }

  get tools(): McpToolDescriptor[] {
    return this._tools;
  }

  get prompts(): McpPromptDescriptor[] {
    return this._prompts;
  }

  get resources(): McpResourceDescriptor[] {
    return this._resources;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get serverVersion(): { name?: string; version?: string } | undefined {
    try {
      return this.client?.getServerVersion?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Spawn + handshake + list-tools. Resolves to `true` on success, `false` on
   * any failure (with `lastError` set + `state = "error"`). Never throws.
   */
  async connect(): Promise<boolean> {
    if (this._state === "connecting" || this._state === "connected") return this._state === "connected";
    this._state = "connecting";
    this._lastError = null;
    this.intentionalClose = false;
    try {
      const { client, transport } = await this.factory.create(this.config);
      // Wire crash detection BEFORE connecting so an immediate exit is caught.
      transport.onclose = () => this.handleTransportClose(new Error("transport closed"));
      transport.onerror = (err: Error) => {
        this._lastError = err?.message ?? String(err);
      };
      // Channels v1 — wire the catch-all notification handler BEFORE the
      // SDK handshake so we don't drop early pushes (an upstream server
      // can emit notifications immediately after `initialize`). We try the
      // method form first (test fakes prefer it) and fall back to the
      // settable property (which is how the real SDK Protocol exposes it).
      if (this.onNotification) {
        const handler = (n: { method: string; params?: unknown }) => {
          try {
            this.onNotification?.(this.config.name, n.method, n.params);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[mcp] notification handler for "${this.config.name}" threw: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        };
        if (typeof client.setFallbackNotificationHandler === "function") {
          client.setFallbackNotificationHandler(handler);
        } else {
          // Settable-property form (real SDK).
          (client as { fallbackNotificationHandler?: typeof handler }).fallbackNotificationHandler =
            handler;
        }
      }
      await client.connect(transport);
      this.client = client;
      const load = this.config.load ?? ["tools", "prompts", "resources"];
      if (load.includes("tools")) {
        const listed = await client.listTools();
        this._tools = (listed.tools ?? []).map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          inputSchema:
            t.inputSchema && typeof t.inputSchema === "object"
              ? (t.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
        }));
      }
      if (load.includes("prompts") && client.listPrompts) {
        try {
          const p = await client.listPrompts();
          this._prompts = (p.prompts ?? []).map((d) => ({
            name: d.name,
            ...(d.description ? { description: d.description } : {}),
            ...(Array.isArray(d.arguments) ? { arguments: d.arguments as McpPromptDescriptor["arguments"] } : {}),
          }));
        } catch {
          // Server doesn't support prompts — not fatal.
          this._prompts = [];
        }
      }
      if (load.includes("resources") && client.listResources) {
        try {
          const r = await client.listResources();
          this._resources = (r.resources ?? []).map((d) => ({
            uri: d.uri,
            ...(d.name ? { name: d.name } : {}),
            ...(d.description ? { description: d.description } : {}),
            ...(d.mimeType ? { mimeType: d.mimeType } : {}),
          }));
        } catch {
          this._resources = [];
        }
      }
      this._state = "connected";
      return true;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      this._state = "error";
      // Best-effort cleanup of a half-open client.
      try {
        await this.client?.close();
      } catch {
        /* ignore */
      }
      this.client = null;
      return false;
    }
  }

  private handleTransportClose(err: Error): void {
    if (this.intentionalClose) return;
    if (this._state === "disconnected") return;
    this._state = "disconnected";
    this._lastError = err.message;
    this.onCrash?.(this.config.name, err);
  }

  /**
   * Invoke an upstream tool by its *bare* (un-namespaced) name. Returns a typed
   * result; transport/protocol errors come back as `{ ok: false }` instead of
   * throwing.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (this._state !== "connected" || !this.client) {
      return {
        ok: false,
        content: `mcp server "${this.config.name}" is not connected (state: ${this._state})`,
      };
    }
    try {
      const raw = await this.client.callTool({ name: toolName, arguments: args });
      return flattenToolResult(raw);
    } catch (err) {
      return {
        ok: false,
        content: `mcp call ${this.config.name}/${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Fetch a prompt's messages by name, flattened to text. Used to inject MCP
   * prompts into mathran's prompt library.
   */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpCallResult> {
    if (this._state !== "connected" || !this.client?.getPrompt) {
      return { ok: false, content: `mcp server "${this.config.name}" cannot getPrompt (state: ${this._state})` };
    }
    try {
      const raw = await this.client.getPrompt({ name, arguments: args });
      return flattenPromptResult(raw);
    } catch (err) {
      return { ok: false, content: `mcp getPrompt ${this.config.name}/${name} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Read a resource by URI, flattened to text. */
  async readResource(uri: string): Promise<McpCallResult> {
    if (this._state !== "connected" || !this.client?.readResource) {
      return { ok: false, content: `mcp server "${this.config.name}" cannot readResource (state: ${this._state})` };
    }
    try {
      const raw = await this.client.readResource({ uri });
      return flattenResourceResult(raw);
    } catch (err) {
      return { ok: false, content: `mcp readResource ${this.config.name}/${uri} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Explicit teardown — does NOT fire the crash callback. Never throws. */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this._tools = [];
    this._prompts = [];
    this._resources = [];
    this._state = "disconnected";
  }
}

/** Flatten an SDK `getPrompt` result's `messages[]` into plain text. */
export function flattenPromptResult(result: unknown): McpCallResult {
  if (!result || typeof result !== "object") return { ok: true, content: "" };
  const r = result as { messages?: Array<{ content?: { type?: string; text?: string } }> };
  const parts: string[] = [];
  if (Array.isArray(r.messages)) {
    for (const m of r.messages) {
      const c = m?.content;
      if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
    }
  }
  return { ok: true, content: parts.join("\n") };
}

/** Flatten an SDK `readResource` result's `contents[]` into plain text. */
export function flattenResourceResult(result: unknown): McpCallResult {
  if (!result || typeof result !== "object") return { ok: true, content: "" };
  const r = result as { contents?: Array<{ text?: string; uri?: string }> };
  const parts: string[] = [];
  if (Array.isArray(r.contents)) {
    for (const c of r.contents) {
      if (typeof c?.text === "string") parts.push(c.text);
      else if (c?.uri) parts.push(`[resource: ${c.uri}]`);
    }
  }
  return { ok: true, content: parts.join("\n") };
}
