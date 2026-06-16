/**
 * ProjectsPanel — the "home" landing page.
 *
 * Lists all projects, lets you create a new one, and links each project to
 * its own route (which loads the inner tab tree: efforts / wiki / chat /
 * settings). Used at `/` and at `/projects` in the router.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ProjectSummary } from "../lib/api.ts";

export default function ProjectsPanel() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

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
      navigate(`/projects/${created.slug}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 text-2xl font-bold">Projects</h1>
      <p className="mb-6 text-sm text-slate-500">
        A project is a workspace for one mathematical investigation. Each project
        contains its own wiki, assistant chats, and a set of efforts (proof
        attempts, formalizations, counter-example searches, ...).
      </p>

      <form onSubmit={create} className="mb-6 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name (e.g. Twin Primes)"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
        <button
          type="submit"
          disabled={loading || !name.trim()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "…" : "Create"}
        </button>
      </form>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {projects.length === 0 ? (
        <p className="text-sm text-slate-400">No projects yet.</p>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li key={p.slug}>
              <Link
                to={`/projects/${p.slug}`}
                className="block rounded-md border border-slate-200 bg-white px-4 py-3 hover:border-slate-400"
              >
                <div className="font-medium">{p.name ?? p.slug}</div>
                <div className="font-mono text-xs text-slate-400">
                  {p.slug}
                  {p.created_at && (
                    <> · created {new Date(p.created_at).toLocaleDateString()}</>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
