/**
 * InitAgentProgress — live SSE dashboard for an init-project agent run.
 *
 * Opens an EventSource against `/api/agent/init-project/:runId/stream`, listens
 * for `phase` events (and ignores `ping` heartbeats), and renders the pipeline
 * phase list with per-phase status (past / current / future) plus any phase
 * metadata. Closes the stream on completion, error, or unmount.
 *
 * Pure helpers (`getPhaseOrder`, `getPhaseStatus`) live in
 * `init-progress-helpers.ts` so they can be unit-tested without `react`.
 */
import { useEffect, useState } from "react";

import type { RunLedgerSnapshot } from "../../lib/api.ts";
import {
  getPhaseOrder,
  getPhaseStatus,
  type InitPhase,
} from "./init-progress-helpers.ts";

export { getPhaseOrder, getPhaseStatus };
export type { InitPhase };

export interface InitAgentProgressProps {
  runId: string;
  mode?: "v1a" | "spine";
  onComplete?: (snapshot: RunLedgerSnapshot) => void;
  onError?: (msg: string) => void;
}

interface PhaseEvent {
  phase: InitPhase;
  event?: "start" | "end";
  at?: string;
  data?: Record<string, unknown>;
}

const PHASE_LABELS: Record<InitPhase, string> = {
  seed_research: "Seed research",
  deep_crawl: "Deep crawl",
  build_wiki: "Build wiki",
  explore_graph: "Explore graph",
  build_spine: "Build spine",
  build_efforts: "Build efforts",
  spine_wiki: "Spine wiki",
  review_refine: "Review & refine",
  verify: "Verify",
  link_review: "Link review",
  completeness_check: "Completeness check",
  completed: "Completed",
  error: "Error",
};

const META_KEYS: Array<[string, string]> = [
  ["spineNodes", "Spine nodes"],
  ["effortsCreated", "Efforts created"],
  ["papersDiscovered", "Papers discovered"],
  ["pagesRefined", "Pages refined"],
  ["pagesFlagged", "Pages flagged"],
];

function statusIcon(status: "past" | "current" | "future"): string {
  if (status === "past") return "✅";
  if (status === "current") return "⏳";
  return "○";
}

export default function InitAgentProgress({
  runId,
  mode = "spine",
  onComplete,
  onError,
}: InitAgentProgressProps) {
  const [current, setCurrent] = useState<InitPhase | null>(null);
  const [latestData, setLatestData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const order = getPhaseOrder(mode);

  useEffect(() => {
    const es = new EventSource(`/api/agent/init-project/${encodeURIComponent(runId)}/stream`);
    let closed = false;

    const close = (): void => {
      if (closed) return;
      closed = true;
      es.close();
    };

    es.addEventListener("phase", (e) => {
      let rec: PhaseEvent;
      try {
        rec = JSON.parse((e as MessageEvent).data) as PhaseEvent;
      } catch {
        return;
      }
      if (!rec.phase) return;
      setCurrent(rec.phase);
      if (rec.data) setLatestData(rec.data);

      if (rec.phase === "completed") {
        close();
        void (async () => {
          try {
            const res = await fetch(`/api/agent/init-project/${encodeURIComponent(runId)}`);
            const snapshot = (await res.json()) as RunLedgerSnapshot;
            onComplete?.(snapshot);
          } catch {
            onComplete?.({
              run: {
                runId,
                agentType: "init-project",
                status: "completed",
                startedAt: rec.at ?? new Date().toISOString(),
              },
              phases: [],
              checkpoint: null,
              logs: [],
            });
          }
        })();
      } else if (rec.phase === "error") {
        const msg =
          (rec.data && typeof rec.data.error === "string" && rec.data.error) ||
          "Init agent reported an error";
        setError(msg);
        close();
        onError?.(msg);
      }
    });

    es.addEventListener("ping", () => {
      /* heartbeat — no-op */
    });

    es.onerror = () => {
      if (closed) return;
      const msg = "Lost connection to the init agent stream";
      setError(msg);
      close();
      onError?.(msg);
    };

    return () => {
      close();
    };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Initializing project</h2>
        <p className="text-xs text-slate-500">
          Run <span className="font-mono">{runId}</span> · {mode === "spine" ? "Spine-First" : "v1a"}
        </p>
      </div>

      <ol className="flex flex-col gap-1.5">
        {order.map((phase) => {
          const status = current ? getPhaseStatus(current, phase, order) : "future";
          return (
            <li
              key={phase}
              className={
                "flex items-center gap-2 text-sm " +
                (status === "current"
                  ? "font-medium text-slate-900"
                  : status === "past"
                    ? "text-slate-500"
                    : "text-slate-400")
              }
            >
              <span>{statusIcon(status)}</span>
              <span>{PHASE_LABELS[phase]}</span>
            </li>
          );
        })}
      </ol>

      {latestData && (
        <div className="flex flex-wrap gap-3 text-xs text-slate-600">
          {META_KEYS.map(([key, label]) =>
            typeof latestData[key] === "number" ? (
              <span key={key} className="rounded bg-slate-100 px-2 py-1">
                {label}: <span className="font-mono">{String(latestData[key])}</span>
              </span>
            ) : null,
          )}
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
    </div>
  );
}
