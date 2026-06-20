// SSE client for the scoped chat endpoints. EventSource only supports GET, so
// we read the streamed response body manually and parse the `event:` / `data:`
// frames that Hono's streamSSE emits.

import { chatScopeBase, type ChatScopeSpec } from "./api.ts";

export type ChatEvent =
  | { type: "session"; sessionId: string; conversationId: string }
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; args: string }
  | { type: "tool-result"; id: string; name: string; ok: boolean; content: string }
  | { type: "done"; finishReason: string }
  | { type: "error"; message: string };

/**
 * Stream a single user message through one of the three chat scopes.
 *
 * `conversationId` is optional — the backend mints one when omitted, and the
 * caller can pick it up from the first `session` event so subsequent turns can
 * reuse it (BUG #6 multi-turn fix).
 */
export async function streamChat(
  scope: ChatScopeSpec,
  message: string,
  conversationId: string | undefined,
  model: string | undefined,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = { message };
  if (conversationId) body.conversationId = conversationId;
  if (model) body.model = model;

  await pumpSSE(
    chatScopeBase(scope),
    body,
    onEvent,
    signal,
  );
}

/**
 * Re-run a prior user prompt by ordinal. The server truncates history to
 * everything before that user message, replays it into the session, then
 * streams the new assistant turn using the same SSE envelope as `streamChat`,
 * so callers can reuse one event handler for both flows.
 *
 * `userMessageIndex` is the 0-based ordinal *among user messages only*
 * (matches the server's counting in `POST .../rerun`). The SPA derives it by
 * counting `kind: "text"` + `role: "user"` bubbles up to the clicked bubble.
 *
 * `overrideText` (optional) lets callers replace the prompt body without
 * needing a separate "edit + resend" endpoint. The server still truncates to
 * the same position; only the text fed into `session.send()` changes.
 */
export async function rerunChat(
  scope: ChatScopeSpec,
  conversationId: string,
  userMessageIndex: number,
  model: string | undefined,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
  overrideText?: string,
): Promise<void> {
  const body: Record<string, unknown> = { userMessageIndex };
  if (model) body.model = model;
  if (overrideText !== undefined) body.overrideText = overrideText;
  const url = `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/rerun`;
  await pumpSSE(url, body, onEvent, signal);
}

/**
 * Drop a tail of a conversation's history (server-side; no SSE).
 *
 * `mode: "include"` (default) wipes the target user message + everything
 * after it. `mode: "after"` keeps the target user message and only drops
 * what comes after it (used by "Delete this reply").
 *
 * Returns the new history length so callers can refresh meters. The SPA
 * keeps its bubble list in sync optimistically.
 */
export async function truncateChat(
  scope: ChatScopeSpec,
  conversationId: string,
  userMessageIndex: number,
  mode: "include" | "after" = "include",
  signal?: AbortSignal,
): Promise<{ length: number; mode: "include" | "after" }> {
  const res = await fetch(
    `${chatScopeBase(scope)}/${encodeURIComponent(conversationId)}/truncate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessageIndex, mode }),
      signal,
    },
  );
  if (!res.ok) {
    let msg = `truncate failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const data = (await res.json()) as { length: number; mode: "include" | "after" };
  return data;
}

/**
 * Shared SSE pump: POSTs `body` to `url` and dispatches `event:` / `data:`
 * frames as typed `ChatEvent`s through `onEvent`. Extracted from `streamChat`
 * so re-run (and any future chat-shaped endpoint) reuses the same parser.
 */
async function pumpSSE(
  url: string,
  body: Record<string, unknown>,
  onEvent: (ev: ChatEvent) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let msg = `chat request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    onEvent({ type: "error", message: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushFrame = (frame: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (eventName === "error") {
        onEvent({ type: "error", message: String(parsed.message ?? "error") });
      } else {
        onEvent({ type: eventName, ...parsed } as ChatEvent);
      }
    } catch {
      /* ignore unparseable frame */
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) flushFrame(frame);
    }
  }
  if (buffer.trim()) flushFrame(buffer);
}
