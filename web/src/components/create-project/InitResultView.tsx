/**
 * InitResultView — final summary card shown when an init-project run completes.
 *
 * Renders a headline, a stat row (v1a core stats plus Spine-First extras when
 * `result.mode === "spine"`), the generated wiki page list (each linking to
 * `/projects/:slug/wiki/:page`), and an "Open project" primary button.
 *
 * Pure formatting helpers live in `init-result-helpers.ts` so they can be
 * unit-tested without rendering the component.
 */
import { Link } from "react-router-dom";

import type { InitAgentResult } from "../../lib/api.ts";
import { buildStatRows, summaryHeadline } from "./init-result-helpers.ts";

export interface InitResultViewProps {
  runId: string;
  slug: string;
  result: InitAgentResult;
  /** Optional callback for the "Open project" button (e.g. close the modal). */
  onOpen?: () => void;
}

export default function InitResultView({ runId, slug, result, onOpen }: InitResultViewProps) {
  const stats = buildStatRows(result);
  const wikiPages = result.wikiPages ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className="text-green-500">✅</span>
          {summaryHeadline(result)}
        </h2>
        <p className="text-xs text-slate-500">
          Run <span className="font-mono">{runId}</span> ·{" "}
          {result.mode === "spine" ? "Spine-First" : "v1a"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-center">
            <div className="text-lg font-bold text-slate-800">{stat.value}</div>
            <div className="text-[10px] uppercase tracking-wide text-slate-400">{stat.label}</div>
          </div>
        ))}
      </div>

      {wikiPages.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-slate-600">Wiki pages</span>
          <ul className="flex flex-col gap-1">
            {wikiPages.map((page) => (
              <li key={page}>
                <Link
                  to={`/projects/${slug}/wiki/${page}`}
                  onClick={onOpen}
                  className="block truncate rounded-md border border-slate-200 px-3 py-1.5 font-mono text-xs text-slate-600 hover:border-slate-400 hover:bg-slate-50"
                >
                  {page}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-end">
        <Link
          to={`/projects/${slug}`}
          onClick={onOpen}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Open project
        </Link>
      </div>
    </div>
  );
}
