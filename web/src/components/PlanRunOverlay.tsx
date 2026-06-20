/**
 * PlanRunOverlay — modal that drives a plan-mode run end-to-end
 * (v0.16 §9 audit #2).
 *
 * Lifecycle:
 *
 *   1. The user clicks "📋 Plan" in the chat header (ChatPanel). The
 *      overlay opens in the `prompt` stage where they type an objective.
 *   2. On submit we POST /api/plans → get a `planId`, open the SSE
 *      stream, and switch to the `streaming` stage. Tokens append into a
 *      growing markdown buffer that we render live with `marked.parse`.
 *   3. When the SSE `done` event arrives we fetch the canonical record
 *      from /api/plans/:id (in case we missed any tokens) and switch to
 *      the `review` stage: Accept / Reject buttons.
 *   4. Accept → POST /api/plans/:id/accept → toast "Plan saved to
 *      .mathran/plans/…" and close. Reject → POST /api/plans/:id/reject
 *      → close.
 *
 * Design notes:
 *
 *   • The overlay never owns the chat panel state; closing it doesn't
 *     touch the underlying conversation. The brief explicitly wants
 *     plan mode to live OUTSIDE chat history (per v0.16 §9), so the
 *     accepted plan body is surfaced via the file path, not a chat
 *     bubble.
 *
 *   • We re-use Tailwind classes from GoalControls/ChatPanel — no new
 *     CSS, no shadcn, no portal lib. The `.md` class already exists in
 *     `web/src/styles/markdown.css` (loaded by index.css).
 *
 *   • Plan markdown follows the schema enforced by PLAN_MODE_FRAGMENT
 *     (## Approach / ## Steps / ## Key files / ## Risks / ## Acceptance).
 *     We don't try to enforce it on the client — render whatever the
 *     model produced verbatim. A future iteration could highlight
 *     missing sections.
 */

import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import {
  acceptPlan,
  createPlanRun,
  getPlan,
  rejectPlan,
  streamPlan,
  type PlanRecord,
} from "../lib/plans.ts";

type Stage = "prompt" | "streaming" | "review" | "done";

export interface PlanRunOverlayProps {
  /** Pre-fill the objective field (e.g. with the user's draft prompt). */
  initialObjective?: string;
  /** Default model id to pass through; the server falls back to its
   *  config default when blank. */
  defaultModel?: string | null;
  /** Fired on Accept; gives the host a chance to toast "Plan saved to
   *  <location>" without the overlay owning the toast UI itself. */
  onAccepted?: (info: { plan: PlanRecord; location: string }) => void;
  /** Fired on Reject for symmetry. The overlay closes after either
   *  call returns. */
  onRejected?: (info: { plan: PlanRecord }) => void;
  /** Called when the user dismisses the overlay (Cancel, Esc, or after
   *  Accept/Reject). The host should set the overlay's visibility
   *  back to false. */
  onClose: () => void;
}

export default function PlanRunOverlay({
  initialObjective,
  defaultModel,
  onAccepted,
  onRejected,
  onClose,
}: PlanRunOverlayProps) {
  const [stage, setStage] = useState<Stage>("prompt");
  const [objective, setObjective] = useState(initialObjective ?? "");
  const [model, setModel] = useState(defaultModel ?? "");
  const [error, setError] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [meta, setMeta] = useState<{ turns: number; truncated: boolean; aborted: boolean } | null>(
    null,
  );
  const [pending, setPending] = useState<"accept" | "reject" | "cancel" | null>(null);

  // Hold the in-flight stream's AbortController so the user can bail
  // out mid-generation without leaving the runner spinning server-side.
  const abortRef = useRef<AbortController | null>(null);

  // Close on Esc (matches GoalControls modal UX) — but only when we're
  // not mid-stream, so we don't accidentally drop tokens.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape" && (stage === "prompt" || stage === "review")) {
        ev.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, onClose]);

  // Cancel the in-flight SSE on unmount so a closed overlay doesn't
  // leak a hanging fetch.
  useEffect(() => {
    return () => {
      try { abortRef.current?.abort(); } catch { /* ignore */ }
    };
  }, []);

  async function handleStart() {
    const objTrim = objective.trim();
    if (!objTrim) return;
    setError(null);
    setBody("");
    setMeta(null);
    setStage("streaming");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const { planId: id } = await createPlanRun({
        objective: objTrim,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      setPlanId(id);
      let accum = "";
      for await (const ev of streamPlan(id, { signal: ctrl.signal })) {
        if (ev.type === "token") {
          accum += ev.delta;
          setBody(accum);
        } else if (ev.type === "done") {
          // Trust the server's canonical body (it already ran
          // extractPlanBody to strip any pre-`# Plan` chatter).
          setBody(ev.body || accum);
          setMeta({ turns: ev.turns, truncated: ev.truncated, aborted: ev.aborted });
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
        // 'step' frames are informational; we don't render them but
        // could in a future iteration ("round 2 of 10…").
      }
      // SSE closed cleanly. Re-fetch the canonical snapshot so we have
      // the persisted `status` etc. for any UI that wants it.
      try {
        const fresh = await getPlan(id);
        if (fresh.body && fresh.body.length > 0) setBody(fresh.body);
      } catch {
        // Non-fatal — we already have the streamed body.
      }
      setStage("review");
    } catch (e: any) {
      if (ctrl.signal.aborted) {
        // User cancelled mid-stream; bounce back to the prompt stage
        // with whatever they typed still in the box.
        setStage("prompt");
        setError("Cancelled before the model finished. You can try again.");
      } else {
        setStage("prompt");
        setError(String(e?.message ?? e));
      }
    } finally {
      abortRef.current = null;
    }
  }

  async function handleAccept() {
    if (!planId) return;
    setPending("accept");
    setError(null);
    try {
      const res = await acceptPlan(planId);
      setStage("done");
      onAccepted?.({ plan: res.plan, location: res.location });
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setPending(null);
    }
  }

  async function handleReject() {
    if (!planId) return;
    if (!window.confirm("Reject this plan? You can re-plan with a new objective afterward.")) return;
    setPending("reject");
    setError(null);
    try {
      const res = await rejectPlan(planId);
      setStage("done");
      onRejected?.({ plan: res.plan });
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setPending(null);
    }
  }

  function handleCancelStreaming() {
    try { abortRef.current?.abort(); } catch { /* ignore */ }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => {
        if (stage === "prompt" || stage === "review") onClose();
      }}
      data-testid="plan-overlay"
    >
      <div
        className="flex w-full max-w-3xl max-h-[90vh] flex-col rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">📋 Plan mode</h2>
          <span className="text-[10px] uppercase tracking-wide text-slate-500" title={planId ?? ""}>
            {stage === "prompt"
              ? "draft"
              : stage === "streaming"
                ? `running${planId ? ` · ${planId}` : ""}`
                : stage === "review"
                  ? "ready for review"
                  : "saved"}
          </span>
        </header>

        {stage === "prompt" && (
          <PromptStage
            objective={objective}
            model={model}
            defaultModel={defaultModel ?? null}
            onChangeObjective={setObjective}
            onChangeModel={setModel}
            onCancel={onClose}
            onSubmit={() => void handleStart()}
            error={error}
          />
        )}

        {stage === "streaming" && (
          <StreamingStage
            body={body}
            onCancel={handleCancelStreaming}
          />
        )}

        {stage === "review" && (
          <ReviewStage
            body={body}
            meta={meta}
            pending={pending}
            error={error}
            onAccept={() => void handleAccept()}
            onReject={() => void handleReject()}
            onBack={() => setStage("prompt")}
          />
        )}
      </div>
    </div>
  );
}

// ─── stages ────────────────────────────────────────────────────────────

function PromptStage({
  objective,
  model,
  defaultModel,
  onChangeObjective,
  onChangeModel,
  onCancel,
  onSubmit,
  error,
}: {
  objective: string;
  model: string;
  defaultModel: string | null;
  onChangeObjective: (s: string) => void;
  onChangeModel: (s: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  error: string | null;
}) {
  const canSubmit = objective.trim().length > 0;
  return (
    <>
      <p className="mb-3 text-xs text-slate-600">
        The agent will produce a written plan (Approach / Steps / Key files / Risks / Acceptance)
        using <span className="font-mono">search</span> and{" "}
        <span className="font-mono">read_file_summary</span> only — no writes, no shell. Review and
        accept before any work begins.
      </p>

      <label className="block text-xs font-medium text-slate-700">
        Objective
        <textarea
          value={objective}
          onChange={(e) => onChangeObjective(e.target.value)}
          rows={4}
          placeholder="e.g. Add a /metrics endpoint that exposes p50/p95 round latency."
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-amber-500 focus:outline-none"
          autoFocus
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </label>

      <label className="mt-2 block text-xs font-medium text-slate-700">
        Model (optional)
        <input
          type="text"
          value={model}
          onChange={(e) => onChangeModel(e.target.value)}
          placeholder={defaultModel ?? "default"}
          className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-amber-500 focus:outline-none"
        />
      </label>

      {error && (
        <div className="mt-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmit}
          className="rounded border border-amber-500 bg-amber-100 px-3 py-1 text-sm text-amber-900 hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
          title="Cmd/Ctrl+Enter"
        >
          📋 Plan
        </button>
      </div>
    </>
  );
}

function StreamingStage({
  body,
  onCancel,
}: {
  body: string;
  onCancel: () => void;
}) {
  return (
    <>
      <p className="mb-2 text-xs text-slate-600">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          Drafting plan…
        </span>
      </p>
      <div className="md flex-1 min-h-[200px] overflow-auto rounded border border-slate-200 bg-slate-50 p-3 text-sm">
        {body.length === 0 ? (
          <span className="text-slate-400">Waiting for the first token…</span>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-sm text-red-700 hover:bg-red-50"
          title="Abort the in-flight plan"
        >
          ⏹ Cancel
        </button>
      </div>
    </>
  );
}

function ReviewStage({
  body,
  meta,
  pending,
  error,
  onAccept,
  onReject,
  onBack,
}: {
  body: string;
  meta: { turns: number; truncated: boolean; aborted: boolean } | null;
  pending: "accept" | "reject" | "cancel" | null;
  error: string | null;
  onAccept: () => void;
  onReject: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-600">
        {meta && (
          <>
            <span title="LLM rounds used">▶ {meta.turns}</span>
            {meta.truncated && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">
                truncated
              </span>
            )}
            {meta.aborted && (
              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-800">
                aborted
              </span>
            )}
          </>
        )}
      </div>
      <div className="md flex-1 min-h-[200px] overflow-auto rounded border border-slate-200 bg-slate-50 p-3 text-sm">
        {body.length === 0 ? (
          <span className="text-slate-400">(empty plan — try again with a sharper objective)</span>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
        )}
      </div>

      {error && (
        <div className="mt-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="mt-4 flex justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={pending !== null}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-sm hover:bg-slate-50 disabled:opacity-50"
          title="Discard this draft and edit the objective"
        >
          ← New objective
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReject}
            disabled={pending !== null || body.length === 0}
            className="rounded border border-slate-300 bg-white px-3 py-1 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "reject" ? "Rejecting…" : "✕ Reject"}
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={pending !== null || body.length === 0}
            className="rounded border border-emerald-500 bg-emerald-100 px-3 py-1 text-sm text-emerald-900 hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending === "accept" ? "Saving…" : "✓ Accept"}
          </button>
        </div>
      </div>
    </>
  );
}
