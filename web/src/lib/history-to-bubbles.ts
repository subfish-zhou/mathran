/**
 * Reconstruct the ChatPanel's `Bubble[]` view from a `LLMMessage[]` history
 * (as returned by `GET <chat-base>/:conversationId`).
 *
 * Wire shape (mirrors `src/core/providers/llm.ts`):
 *
 *   {
 *     role: "system" | "user" | "assistant" | "tool",
 *     content: string,
 *     toolCallId?: string,
 *     name?: string,
 *     toolCalls?: Array<{ id, name, arguments }>,
 *   }
 *
 * Bubble shape (mirrors ChatPanel's internal type):
 *
 *   { kind: "user" | "assistant", text }
 *   { kind: "tool", id, name, args?, result?, ok? }
 *
 * Rules:
 *   - `system` messages → dropped (user-invisible).
 *   - `user`            → { kind: "user", text: content }
 *   - `assistant` with toolCalls → emit one assistant bubble if content non-empty,
 *                                 then one tool bubble per call (args only, no result yet)
 *   - `assistant` plain → { kind: "assistant", text: content }
 *   - `tool`            → match prior tool bubble by toolCallId; fill result/ok.
 *                         If toolCallId is missing or unmatched, append a
 *                         result-only tool bubble (defensive — shouldn't happen
 *                         in normal flows but we never want to drop data).
 *
 * `ok` is inferred from the result text — anything starting with "error:" or
 * "Error:" (case-insensitive) is treated as failed. Matches the heuristic the
 * `tool-result` SSE event uses on the live-stream side. Future: bake `ok`
 * into the persisted format so we don't have to re-parse.
 */
export interface ToolBubble {
  kind: "tool";
  id: string;
  name: string;
  args?: string;
  result?: string;
  ok?: boolean;
  /** 2026-06-25 — populated when the backend emits a `file-written`
   *  side-channel event for this tool call (write_file / edit_file
   *  success). The SPA renders a <FileBubble> chip below the tool
   *  output with Download + Copy-path buttons.
   *
   *  NOTE: this field is transient — `file-written` is a live SSE
   *  event with no jsonl persistence, so a reloaded conversation
   *  will show the tool bubble without the chip. The absolute path
   *  is still present in the assistant's reply text, so users can
   *  hit /api/file?path=<path> manually. Re-hydrating on reload
   *  would require an extra server lookup per write_file tool call;
   *  out of scope for this commit. */
  fileWritten?: {
    path: string;
    relPath: string;
    filename: string;
    bytes: number;
    mime: string;
  };
  /** v0.16 §11: this tool call is `ask_user` and is paused waiting for
   *  the user's reply. Set when the SSE stream emits `ask_user` or when
   *  the conversation loads with a `pendingAsk` sidecar slot. Cleared
   *  once the answer is submitted (the placeholder tool message is
   *  patched with the reply, so this bubble re-renders as a normal
   *  tool-result). */
  /** v0.16 §11: this tool call paused on `ask_user` and is waiting for
   *  the user's reply. Set when the SSE stream emits `ask_user` or when
   *  the conversation loads with a `pendingAsk` sidecar slot. Cleared
   *  once the answer is submitted (the placeholder tool message is
   *  patched with the reply, so this bubble re-renders as a normal
   *  tool-result).
   *
   *  v0.19 Codex parity — four optional structured fields the model
   *  may have supplied via `ask_user({ options, default, timeoutSeconds,
   *  allowCustom })`. When present the SPA renders a richer answer
   *  surface (button list / countdown / default hint). All optional;
   *  bare ask_user calls render the same textarea-only widget as
   *  before. `timeoutAt` mirrors the sidecar's `timeoutAt` deadline so
   *  the SPA can render a countdown that survives a reload. */
  askPending?: {
    question: string;
    options?: string[];
    default?: string;
    timeoutSeconds?: number;
    allowCustom?: boolean;
    timeoutAt?: number;
  };
}

export interface TextBubble {
  kind: "user" | "assistant";
  text: string;
  /**
   * Reasoning / chain-of-thought text for an assistant bubble (UX gap B).
   * Populated either live (accumulated from `reasoning` SSE deltas) or on
   * history load from the persisted `LLMMessage.reasoning` field. ChatPanel
   * renders it as a collapsed `<ReasoningBlock>` above the answer. Absent on
   * user bubbles and on assistant turns the model answered without thinking.
   */
  reasoning?: string;
  /**
   * Attachment chips to render under a user bubble (v0.17 mathub parity).
   * Populated only on `kind === "user"` rows whose persisted `LLMMessage`
   * carried an `attachments:[…]` array — i.e. messages originally sent
   * with files attached via `POST /api/uploads`. ChatPanel renders an 80×80
   * `<img>` preview for images and a `📎 filename` chip for everything else;
   * both link out to `GET /api/uploads/<encoded-path>`.
   */
  attachments?: Array<{ path: string; filename: string; mimeType: string }>;
}

export type Bubble = ToolBubble | TextBubble;

export interface LLMMessageWire {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  attachments?: Array<{ path: string; filename: string; mimeType: string }>;
  /** UX gap B — persisted chain-of-thought for an assistant turn. */
  reasoning?: string;
}

function isErrorResult(s: string): boolean {
  return /^\s*error:/i.test(s);
}

export function historyToBubbles(history: LLMMessageWire[]): Bubble[] {
  const out: Bubble[] = [];
  for (const m of history) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      const bubble: TextBubble = { kind: "user", text: m.content };
      if (m.attachments && m.attachments.length > 0) {
        bubble.attachments = m.attachments;
      }
      out.push(bubble);
      continue;
    }

    if (m.role === "assistant") {
      const hasText = !!(m.content && m.content.trim().length > 0);
      const hasReasoning = !!(m.reasoning && m.reasoning.length > 0);
      if (hasText || hasReasoning) {
        const bubble: TextBubble = { kind: "assistant", text: hasText ? m.content : "" };
        if (hasReasoning) bubble.reasoning = m.reasoning;
        out.push(bubble);
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        for (const tc of m.toolCalls) {
          out.push({
            kind: "tool",
            id: tc.id,
            name: tc.name,
            args: tc.arguments,
          });
        }
      }
      continue;
    }

    if (m.role === "tool") {
      // Find the matching tool bubble we emitted from the assistant turn.
      const id = m.toolCallId ?? "";
      const idx = id
        ? out.findIndex((b) => b.kind === "tool" && (b as ToolBubble).id === id)
        : -1;
      if (idx !== -1) {
        const bubble = out[idx] as ToolBubble;
        out[idx] = {
          ...bubble,
          result: m.content,
          ok: !isErrorResult(m.content),
        };
      } else {
        out.push({
          kind: "tool",
          id: id || `orphan-${out.length}`,
          name: m.name ?? "(unknown tool)",
          result: m.content,
          ok: !isErrorResult(m.content),
        });
      }
      continue;
    }
  }
  return out;
}
