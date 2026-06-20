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
  /** v0.16 §11: this tool call is `ask_user` and is paused waiting for
   *  the user's reply. Set when the SSE stream emits `ask_user` or when
   *  the conversation loads with a `pendingAsk` sidecar slot. Cleared
   *  once the answer is submitted (the placeholder tool message is
   *  patched with the reply, so this bubble re-renders as a normal
   *  tool-result). */
  askPending?: {
    question: string;
  };
}

export interface TextBubble {
  kind: "user" | "assistant";
  text: string;
}

export type Bubble = ToolBubble | TextBubble;

export interface LLMMessageWire {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

function isErrorResult(s: string): boolean {
  return /^\s*error:/i.test(s);
}

export function historyToBubbles(history: LLMMessageWire[]): Bubble[] {
  const out: Bubble[] = [];
  for (const m of history) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      out.push({ kind: "user", text: m.content });
      continue;
    }

    if (m.role === "assistant") {
      if (m.content && m.content.trim().length > 0) {
        out.push({ kind: "assistant", text: m.content });
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
