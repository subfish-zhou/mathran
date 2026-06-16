import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import {
  api,
  type ProjectSummary,
  type WikiPageSummary,
  type WikiPage,
} from "../lib/api.ts";

export default function WikiPanel({
  activeProject,
  onSelectProject,
}: {
  activeProject: string | null;
  onSelectProject: (slug: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void api.listProjects().then(setProjects).catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    setPage(null);
    setPages([]);
    if (!activeProject) return;
    setError(null);
    api
      .listWiki(activeProject)
      .then(setPages)
      .catch((e) => setError((e as Error).message));
  }, [activeProject]);

  async function openPage(name: string) {
    if (!activeProject) return;
    setError(null);
    setEditing(false);
    setStatus(null);
    try {
      const p = await api.getWikiPage(activeProject, name);
      setPage(p);
      setDraft(p.body);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    if (!activeProject || !page) return;
    setError(null);
    setStatus("Saving…");
    try {
      const saved = await api.saveWikiPage(activeProject, page.page, draft);
      setPage(saved);
      setDraft(saved.body);
      setEditing(false);
      setStatus("Saved.");
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }

  const rendered = useMemo(() => (page ? marked.parse(page.body) : ""), [page]);

  return (
    <div className="grid h-full grid-cols-[16rem_1fr] overflow-hidden">
      <div className="flex flex-col overflow-hidden border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Project
          </label>
          <select
            value={activeProject ?? ""}
            onChange={(e) => onSelectProject(e.target.value || "")}
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="">Select…</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name ?? p.slug}
              </option>
            ))}
          </select>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {activeProject && pages.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-400">No wiki pages.</li>
          )}
          {pages.map((p) => (
            <li key={p.page}>
              <button
                onClick={() => openPage(p.page)}
                className={`w-full rounded-md px-3 py-2 text-left text-sm ${
                  page?.page === p.page ? "bg-slate-100 font-medium" : "hover:bg-slate-50"
                }`}
              >
                {p.title ?? p.page}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col overflow-hidden">
        {error && (
          <div className="m-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        {!page && !error && (
          <p className="p-6 text-sm text-slate-400">
            {activeProject ? "Select a wiki page." : "Select a project first."}
          </p>
        )}
        {page && (
          <>
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
              <h1 className="font-mono text-sm font-semibold">{page.page}.md</h1>
              <div className="flex items-center gap-3">
                {status && <span className="text-xs text-slate-400">{status}</span>}
                {editing ? (
                  <>
                    <button
                      onClick={() => {
                        setEditing(false);
                        setDraft(page.body);
                      }}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={save}
                      className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setEditing(true)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-full min-h-[24rem] w-full resize-none rounded-md border border-slate-300 p-4 font-mono text-sm outline-none focus:border-slate-500"
                />
              ) : (
                <div className="md max-w-3xl" dangerouslySetInnerHTML={{ __html: rendered }} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
