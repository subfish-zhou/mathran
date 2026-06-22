// Approval Policy 矩阵 — modal that surfaces a tool-call approval request.
//
// Rendered by ChatPanel when an `approval_request` SSE event arrives. The user
// picks an outcome (allow once / for session / always-prefix / deny, or
// retry / abandon for on-failure prompts); the chosen ApprovalDecision is
// handed back to the host which POSTs it via `postApprovalDecision`.

import { useState } from "react";
import {
  buildApprovalOptions,
  riskLabel,
  type ApprovalDecision,
  type ApprovalOption,
  type ApprovalRequest,
} from "../lib/approval-client.ts";

const RISK_BADGE: Record<string, string> = {
  read: "border-slate-300 bg-slate-100 text-slate-700",
  write: "border-amber-300 bg-amber-50 text-amber-800",
  exec: "border-red-300 bg-red-50 text-red-800",
  net: "border-purple-300 bg-purple-50 text-purple-800",
};

const TONE_CLASS: Record<ApprovalOption["tone"], string> = {
  primary:
    "border-emerald-500 bg-emerald-100 text-emerald-900 hover:bg-emerald-200",
  neutral: "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  danger: "border-red-400 bg-red-100 text-red-900 hover:bg-red-200",
};

export interface ApprovalDialogProps {
  request: ApprovalRequest;
  /** Called with the user's decision; the host POSTs it and closes the modal. */
  onDecide: (decision: ApprovalDecision) => void;
  /** Set while the decision POST is in flight (buttons disabled). */
  pending?: boolean;
  /** Non-fatal error from a failed POST, surfaced inline for a retry. */
  error?: string | null;
}

const TRIGGER_BLURB: Record<ApprovalRequest["trigger"], string> = {
  policy: "Your approval policy requires sign-off for this tool.",
  untrusted: "This call touches untrusted content (path or command).",
  "on-failure": "This tool already ran and failed — retry or abandon?",
};

export function ApprovalDialog({
  request,
  onDecide,
  pending = false,
  error = null,
}: ApprovalDialogProps): JSX.Element {
  const options = buildApprovalOptions(request);
  // For `allow_prefix` the user can tweak the suggested prefix before sending.
  const prefixOption = options.find((o) => o.outcome === "allow_prefix");
  const [prefix, setPrefix] = useState(prefixOption?.prefix ?? "");

  function decide(option: ApprovalOption): void {
    if (pending) return;
    const decision: ApprovalDecision = { outcome: option.outcome };
    if (option.outcome === "allow_prefix") {
      decision.prefix = prefix.trim() || option.prefix;
    }
    if (option.outcome === "deny") {
      decision.reason = "Denied by user";
    }
    onDecide(decision);
  }

  const badge = RISK_BADGE[request.riskClass] ?? RISK_BADGE.read;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tool approval required"
    >
      <div className="flex w-full max-w-lg flex-col rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
        <header className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            🔐 Approval needed
            <span className="font-mono text-sm text-slate-600">
              {request.tool}
            </span>
          </h2>
          <span
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badge}`}
          >
            {riskLabel(request.riskClass)}
          </span>
        </header>

        <p className="mb-2 text-xs text-slate-600">
          {TRIGGER_BLURB[request.trigger]}
        </p>

        <pre className="mb-3 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs text-slate-800">
          {request.preview}
        </pre>

        {request.rationale ? (
          <p className="mb-3 border-l-2 border-slate-200 pl-2 text-xs italic text-slate-500">
            {request.rationale}
          </p>
        ) : null}

        {prefixOption ? (
          <label className="mb-3 block text-xs font-medium text-slate-700">
            Always-allow prefix
            <input
              type="text"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              disabled={pending}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1 font-mono text-xs focus:border-emerald-500 focus:outline-none"
            />
          </label>
        ) : null}

        {error ? (
          <div className="mb-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800">
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          {options.map((option) => (
            <button
              key={option.outcome}
              type="button"
              disabled={pending}
              onClick={() => decide(option)}
              className={`rounded border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${TONE_CLASS[option.tone]}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ApprovalDialog;
