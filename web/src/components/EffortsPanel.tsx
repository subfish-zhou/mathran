/**
 * EffortsPanel — list + create efforts inside the active project.
 *
 * Mirrors mathub's `workspace/<effortId>` UX: a flat list of work units, each
 * with a type (PROOF_ATTEMPT / FORMALIZATION / …) and status (DRAFT /
 * PROMISING / …). Clicking one opens the per-effort detail route.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type EffortSummary } from "../lib/api.ts";
import { EffortDepGraph } from "./EffortDepGraph.tsx";

const TYPES = [
  "CONSTRUCTION",
  "PROOF_ATTEMPT",
  "ESTIMATE",
  "COUNTEREXAMPLE",
  "COMPUTATION",
  "REDUCTION",
  "FORMALIZATION",
  "AUXILIARY",
  "REFERENCE",
] as const;

export default function EffortsPanel({ projectSlug }: { projectSlug: string }) {
  const [efforts, setEfforts] = useState<EffortSummary[]>([]);
  const [title, setTitle] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("PROOF_ATTEMPT");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // sync-upgrade P3-B: Tree | Graph view toggle
  const [view, setView] = useState<"tree" | "graph">("tree");

  async function refresh() {
    setError(null);
    try {
      setEfforts(await api.listEfforts(projectSlug));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, [projectSlug]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setCreating(true);
    try {
      await api.createEffort(projectSlug, { title: title.trim(), type });
      setTitle("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-6 py-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Efforts <span className="text-slate-400">in {projectSlug}</span>
        </h2>
        {/* sync-upgrade P3-B: Tree | Graph toggle */}
        <div className="flex rounded-md border border-slate-200 bg-white text-xs">
          <button
            onClick={() => setView("tree")}
            className={`px-3 py-1 ${view === "tree" ? "bg-slate-900 text-white" : "text-slate-500"}`}
          >
            Tree
          </button>
          <button
            onClick={() => setView("graph")}
            className={`px-3 py-1 ${view === "graph" ? "bg-slate-900 text-white" : "text-slate-500"}`}
          >
            Graph
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {view === "graph" ? (
          <EffortDepGraph projectSlug={projectSlug} />
        ) : (
          <div className="p-6">
            <form onSubmit={create} className="mb-6 flex flex-wrap gap-2 rounded-md border border-slate-200 bg-white p-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New effort title…"
            className="flex-1 min-w-[16rem] rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            disabled={creating}
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as any)}
            className="rounded-md border border-slate-300 px-2 py-2 text-sm"
            disabled={creating}
          >
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={creating || !title.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {creating ? "…" : "Create"}
          </button>
        </form>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {efforts.length === 0 ? (
          <p className="text-sm text-slate-400">
            No efforts yet. An effort is one self-contained work unit
            (proof attempt, formalization, counter-example search, ...).
          </p>
        ) : (
          <ul className="space-y-2">
            {efforts.map((e) => (
              <li key={e.slug}>
                <Link
                  to={`/projects/${projectSlug}/effort/${e.slug}`}
                  className="block rounded-md border border-slate-200 bg-white px-4 py-3 hover:border-slate-400"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{e.title}</span>
                    <span className="text-xs text-slate-500">
                      {e.type} · {e.status} · v{e.currentVersion}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-400 font-mono">
                    {e.slug} · updated {new Date(e.updatedAt).toLocaleString()}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
          </div>
        )}
      </div>
    </div>
  );
}
