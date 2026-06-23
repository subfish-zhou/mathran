/**
 * transports.ts — attach a built mathran MCP {@link Server} to a concrete
 * transport: stdio (default) or HTTP/SSE.
 *
 * Security (PLAN 安全):
 *   - HTTP binds to `127.0.0.1` unless `host` is set explicitly (the caller is
 *     warned by normalizeServerConfig at config-load time).
 *   - HTTP REQUIRES a bearer token: a request without `Authorization: Bearer
 *     <token>` (or `?token=`) is rejected with 401 before reaching the MCP
 *     protocol layer. Starting the http transport without a configured token
 *     throws (fail-closed).
 *
 * The SDK transports are dynamically imported so the (heavy) SDK only loads
 * when a server is actually started.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";

/** Authorize an inbound HTTP request against the configured token. */
export function isAuthorized(
  req: { headers: Record<string, string | string[] | undefined>; url?: string },
  token: string,
): boolean {
  const auth = req.headers["authorization"];
  const header = Array.isArray(auth) ? auth[0] : auth;
  if (header && header === `Bearer ${token}`) return true;
  // Fallback: `?token=` query param (some clients can't set headers on the SSE GET).
  if (req.url) {
    try {
      const u = new URL(req.url, "http://localhost");
      if (u.searchParams.get("token") === token) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Connect a server over stdio. Resolves once the transport is attached. */
export async function serveStdio(server: SdkServer): Promise<void> {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface ServeHttpOptions {
  host: string;
  port: number;
  token: string;
}

export interface HttpServerHandle {
  close(): Promise<void>;
  readonly port: number;
  readonly host: string;
}

/**
 * Serve a mathran MCP server over HTTP/SSE. `serverFactory` is called once per
 * client connection so each SSE stream gets its own `Server` + transport pair
 * (the SDK requires a 1:1 server↔transport binding).
 *
 * Throws synchronously when `token` is empty (fail-closed — no anonymous HTTP).
 */
export async function serveHttp(
  serverFactory: () => Promise<SdkServer>,
  options: ServeHttpOptions,
): Promise<HttpServerHandle> {
  if (!options.token || options.token.length === 0) {
    throw new Error(
      "[mcp-server] refusing to start HTTP transport without a token (set mcp.server.token)",
    );
  }
  const http = await import("node:http");
  const { SSEServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/sse.js"
  );

  const MESSAGE_PATH = "/messages";
  const SSE_PATH = "/sse";
  const transports = new Map<string, InstanceType<typeof SSEServerTransport>>();

  const httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? options.host}`);

    if (!isAuthorized({ headers: req.headers, url: req.url ?? "" }, options.token)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized: missing or invalid bearer token" }));
      return;
    }

    if (req.method === "GET" && reqUrl.pathname === SSE_PATH) {
      const transport = new SSEServerTransport(MESSAGE_PATH, res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => transports.delete(transport.sessionId);
      const server = await serverFactory();
      await server.connect(transport);
      return;
    }

    if (req.method === "POST" && reqUrl.pathname === MESSAGE_PATH) {
      const sessionId = reqUrl.searchParams.get("sessionId") ?? "";
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `unknown sessionId "${sessionId}"` }));
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, options.host, () => resolve());
  });

  return {
    host: options.host,
    port: options.port,
    async close() {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          /* ignore */
        }
      }
      transports.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
