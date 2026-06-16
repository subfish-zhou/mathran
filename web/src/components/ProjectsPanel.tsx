import { useEffect, useState } from "react";
import { api, type ProjectSummary, type ProjectDetail } from "../lib/api.ts";

export default function ProjectsPanel({
  activeProject,
  onSelect,
  onOpenWiki,
}: {
  activeProject: string | null;
  onSelect: (slug: string) => void;
  onOpenWiki: (slug: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setError(null);
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function openProject(slug: string) {
    onSelect(slug);
    setError(null);
    try {
      setDetail(await api.getProject(slug));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const created = await api.createProject(trimmed);
      setName("");
      await refresh();
      await openProject(created.slug);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid h-full grid-cols-[20rem_1fr] overflow-hidden">
      <div className="flex flex-col overflow-hidden border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Projects
          </h2>
          <form onSubmit={create} className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="New project name"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              New
            </button>
          </form>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {projects.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-400">No projects yet.</li>
          )}
          {projects.map((p) => (
            <li key={p.slug}>
              <button
                onClick={() => openProject(p.slug)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  activeProject === p.slug ? "bg-slate-100 font-medium" : "hover:bg-slate-50"
                }`}
              >
                <div>{p.name ?? p.slug}</div>
                <div className="font-mono text-xs text-slate-400">{p.slug}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="overflow-y-auto p-6">
        {error && (
          <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        {!detail && <p className="text-sm text-slate-400">Select a project to view its structure.</p>}
        {detail && (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h1 className="text-xl font-bold">
                  {(detail.project as any)?.project?.name ?? detail.slug}
                </h1>
                <div className="font-mono text-xs text-slate-400">{detail.slug}</div>
              </div>
              <button
                onClick={() => onOpenWiki(detail.slug)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100"
              >
                Open Wiki →
              </button>
            </div>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Structure
            </h3>
            <ul className="rounded-md border border-slate-200 bg-white">
              {detail.entries.map((entry) => (
                <li
                  key={entry}
                  className="border-b border-slate-100 px-3 py-2 font-mono text-sm last:border-b-0"
                >
                  {entry}
                </li>
              ))}
              {detail.entries.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-400">empty</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
