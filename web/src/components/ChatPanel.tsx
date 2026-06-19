/**
 * Scoped chat panel: drives one conversation inside a given `ChatScopeSpec`
 * (global / project / effort). The parent route component picks the scope and
 * passes it in.
 *
 * Multi-turn support: we read the `session` event from the first SSE response
 * and remember the `conversationId`, so subsequent messages in this UI session
 * append to the same on-disk conversation (BUG #6).
 *
 * A `scopeKey` prop is used to force a state reset when the route switches
 * between scopes (otherwise React reuses our state across routes).
 */
import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { streamChat, type ChatEvent } from "../lib/chat.ts";
import { api, type ChatScopeSpec, type UsageStats } from "../lib/api.ts";
import ContextMeter from "./ContextMeter.tsx";

interface ToolBubble {
  kind: "tool";
  id: string;
  name: string;
  args?: string;
  result?: string;
  ok?: boolean;
}

interface TextBubble {
  kind: "user" | "assistant";
  text: string;
}

type Bubble = ToolBubble | TextBubble;

export default function ChatPanel({
  scope,
  scopeLabel,
}: {
  scope: ChatScopeSpec;
  /** Short label for the header (e.g. "global", "project: foo", "effort: bar"). */
  scopeLabel: string;
}) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset everything when the active scope changes.
  useEffect(() => {
    setBubbles([]);
    setConversationId(null);
    setError(null);
    setInput("");
    setUsage(null);
  }, [scope.kind, (scope as any).projectSlug, (scope as any).effortSlug]);

  useEffect(() => {
    api
      .getProviders()
      .then((p) => {
        if (p.defaultModel) setModel(p.defaultModel);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    setBusy(true);
    setBubbles((b) => [...b, { kind: "user", text }, { kind: "assistant", text: "" }]);

    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "session") {
        setConversationId(ev.conversationId);
        return;
      }
      setBubbles((prev) => {
        const next = [...prev];
        if (ev.type === "text") {
          const last = next[next.length - 1];
          if (last && last.kind === "assistant") {
            next[next.length - 1] = { ...last, text: last.text + ev.delta };
          } else {
            next.push({ kind: "assistant", text: ev.delta });
          }
        } else if (ev.type === "tool-call") {
          next.push({ kind: "tool", id: ev.id, name: ev.name, args: ev.args });
        } else if (ev.type === "tool-result") {
          const idx = next.findIndex(
            (x) => x.kind === "tool" && (x as ToolBubble).id === ev.id,
          );
          if (idx !== -1) {
            next[idx] = { ...(next[idx] as ToolBubble), result: ev.content, ok: ev.ok };
          } else {
            next.push({ kind: "tool", id: ev.id, name: ev.name, result: ev.content, ok: ev.ok });
          }
          next.push({ kind: "assistant", text: "" });
        } else if (ev.type === "error") {
          setError(ev.message);
        }
        return next;
      });
    };

    try {
      await streamChat(scope, text, conversationId ?? undefined, model || undefined, onEvent);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setBubbles((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === "assistant" && last.text === "") return prev.slice(0, -1);
        return prev;
      });
      // Turn complete — refresh the context meter. We read `conversationId` from
      // a ref-like fallback because the just-completed POST may have minted it.
      // The closure captures the pre-POST value; that's fine for second-and-on
      // turns. For the first turn the SSE `session` event already updated state
      // and React will re-render before we get here, but to be safe we also
      // refetch once any time `conversationId` changes (see effect below).
      void refreshUsage();
    }
  }

  // Fetch usage stats whenever the conversation id changes (covers first-turn
  // case where the id is minted server-side and arrives via SSE) or after a
  // turn completes (see the `refreshUsage()` call in `send`'s finally block).
  async function refreshUsage() {
    if (!conversationId) return;
    try {
      const u = await api.getChatUsage(scope, conversationId, model || undefined);
      setUsage(u);
    } catch {
      // Hide silently — the meter is decorative; never break the chat surface.
    }
  }

  useEffect(() => {
    if (!conversationId) return;
    void refreshUsage();
    // refreshUsage is a stable closure over scope+model; we intentionally do
    // not include it in deps to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Chat</h2>
          <p className="text-xs text-slate-400">
            {scopeLabel}
            {conversationId && <> · <span className="font-mono">{conversationId}</span></>}
          </p>
        </div>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="model (e.g. copilot/gpt-5.5)"
          className="w-64 rounded-md border border-slate-300 px-2 py-1 text-xs font-mono outline-none focus:border-slate-500"
        />
      </div>

      {/* v0.3 §19: context-window meter. Hidden gracefully when no usage data
          has landed yet (initial / pre-first-turn state). */}
      {usage ? (
        <ContextMeter
          tokens={usage.tokens}
          contextWindow={usage.contextWindow}
          warning={usage.warning}
          percentage={usage.percentage}
        />
      ) : conversationId ? (
        <ContextMeter
          tokens={0}
          contextWindow={200_000}
          warning={null}
          percentage={0}
          loading
        />
      ) : null}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-6">
        {bubbles.length === 0 && (
          <p className="text-sm text-slate-400">Ask a math or Lean question to start.</p>
        )}
        {bubbles.map((b, i) =>
          b.kind === "tool" ? (
            <div
              key={i}
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
            >
              <div className="font-semibold text-amber-800">
                🛠 {b.name}
                {b.ok !== undefined && (
                  <span className={b.ok ? "text-green-700" : "text-red-700"}>
                    {" "}
                    · {b.ok ? "ok" : "failed"}
                  </span>
                )}
              </div>
              {b.args && (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-amber-900">
                  {b.args}
                </pre>
              )}
              {b.result && (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-slate-700">
                  {b.result}
                </pre>
              )}
            </div>
          ) : (
            <div
              key={i}
              className={`flex ${b.kind === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-2xl rounded-lg px-4 py-2 text-sm ${
                  b.kind === "user"
                    ? "bg-slate-900 text-white"
                    : "border border-slate-200 bg-white"
                }`}
              >
                {b.kind === "assistant" ? (
                  <div
                    className="md"
                    dangerouslySetInnerHTML={{ __html: marked.parse(b.text || "…") as string }}
                  />
                ) : (
                  <span className="whitespace-pre-wrap">{b.text}</span>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      {error && (
        <div className="mx-6 mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <form onSubmit={send} className="flex gap-2 border-t border-slate-200 bg-white p-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message…"
          disabled={busy}
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
