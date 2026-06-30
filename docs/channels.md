# Channels v1 (MCP push)

Reverse-channel bus that lets out-of-band sources push messages **into
a running ChatSession** so the LLM sees them on its next round. Polling
becomes event-driven.

**Status:** v1 default-off. Server-side bridge wired in `serve.ts`
boot; ChatSession auto-register pending v2.

## Wire format

MCP JSON-RPC notification, method `mathran/channel`:

```json
{
  "jsonrpc": "2.0",
  "method": "mathran/channel",
  "params": {
    "session": "c-abc-123",      // optional — omit → broadcast
    "content": "CI passed: build #4421",
    "role": "user"               // optional — only "user" allowed in v1
  }
}
```

Any MCP server connected to mathran can emit it. The bridge
(`src/core/channels/mcp-bridge.ts`) parses → builds a
`ChannelMessage` → delivers via the process-level
`ChannelRegistry`.

## Routing

- `params.session` set + matches a registered ChatSession →
  **direct delivery** to that session.
- `params.session` unset → **broadcast** to every registered session.
- `params.session` set but unknown → **dropped** (logged, not an error).

## Injection mode (v1: queue-only)

The message is appended to `ChatSession.messages` as a plain
`role: "user"` turn with `meta.fromChannel: "mcp:<server-name>"`. The
LLM sees it on its **next** round — never mid-stream.

`mode: "interrupt"` (abort-in-flight + prepend) is reserved for v2.
Aborting mid-stream needs careful tool-call replay accounting that
doesn't belong with the wire plumbing.

## SPA rendering

The injected message carries `meta.fromChannel` — the SSE bridge
forwards it onto the wire so the SPA can colour the bubble
distinctly. Provider adapters (Anthropic, OpenAI, …) MUST ignore
`meta.*`; it's a pure UI hint.

## Use cases

- **CI passed/failed**: a Sentry / GitHub Actions MCP server pushes
  on workflow completion. The goal "wait for CI then merge" stops
  polling.
- **Lean compile done**: a `lean_server` MCP pushes when
  `Mathlib` finishes building.
- **Mobile remote control**: a Telegram bot MCP forwards your phone
  messages into the desktop session.
- **Cross-agent gossip**: another mathran instance pushes "I finished
  spine v3 of project P, here's the link".

## Architecture

```
                  ┌─────────────────────────────────┐
                  │ MCP server                       │
                  │ (telegram-bot, sentry, ci, …)    │
                  └──────────────┬───────────────────┘
                                 │ JSON-RPC notification
                                 │ method=mathran/channel
                                 ▼
       serve.ts boot     ┌──────────────────┐
       attachMcpBridge → │ McpRegistry sink │
                         └────────┬─────────┘
                                  │ parseChannelNotification
                                  ▼
                         ┌──────────────────┐
                         │ ChannelRegistry  │ ── route ───┐
                         │ (global)         │             │
                         └──────────────────┘             ▼
                                                   ChatSession
                                                   .injectChannelMessage
                                                   (appends user turn)
```

## v2 roadmap

- **Auto-register ChatSession** on construction (currently the bridge
  is attached but ChatSession instances don't register their
  conversationId — every push hits 0 subscriptions until manually
  wired by host code).
- **Interrupt mode** with proper streaming abort + tool-call replay.
- **Webhook bridge** alongside MCP — direct HTTP POST → same
  `ChannelMessage` path.
- **Cross-agent push** (mathran-to-mathran) for fleet coordination.
- **Schema validation** of `params.content` (size cap, content-type)
  + per-server rate-limit.

## Security

- `parseChannelNotification` rejects malformed payloads (non-object
  params, missing content, non-`"user"` role) silently — drops + logs,
  doesn't poison the session.
- A throwing `deliver` callback on one session does **not** abort the
  registry's routing for other sessions (broadcast resilience).
- Re-registering the same sessionId **replaces** the previous callback
  (idempotent — restart-safe).
- MCP server itself is trusted (the user installed it). Per-server
  auth / ACL is reserved for v2.

## Tests

`src/core/channels/__tests__/channels.test.ts` — 19 tests:
- `parseChannelNotification` payload validation (6)
- `ChannelRegistry` direct routing + broadcast + idempotent register +
  throwing-deliver resilience (7)
- `buildInjectedMessage` LLMMessage projection (2)
- `attachMcpBridge` end-to-end MCP → registered session (4)

19/19 pass.
