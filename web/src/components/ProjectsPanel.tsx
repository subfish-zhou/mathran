/**
 * ProjectsPanel — the "home" landing page.
 *
 * Lists all projects, lets you create a new one, and links each project to
 * its own route (which loads the inner tab tree: efforts / wiki / chat /
 * settings). Used at `/` and at `/projects` in the router.
 *
 * The "AI-assist init" path opens a modal: first the `AiInitConfig` form, then
 * the live `InitAgentProgress` SSE dashboard once the run is kicked off.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type ProjectSummary, type InitAgentResult, type RunLedgerSnapshot } from "../lib/api.ts";
import AiInitConfig, { type AiInitPayload } from "./create-project/AiInitConfig.tsx";
import InitAgentProgress from "./create-project/InitAgentProgress.tsx";
import InitResultView from "./create-project/InitResultView.tsx";
import { extractInitResult } from "./create-project/init-result-helpers.ts";

export default function ProjectsPanel() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState("");
  const [aiAssist, setAiAssist] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // AI-assist modal flow: "config" → form, "progress" → SSE dashboard,
  // "result" → final summary card.
  const [modal, setModal] = useState<null | "config" | "progress" | "result">(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [initMode, setInitMode] = useState<"v1a" | "spine">("spine");
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [initResult, setInitResult] = useState<InitAgentResult | null>(null);

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

  function closeModal() {
    setModal(null);
    setRunId(null);
    setPendingSlug(null);
    setInitResult(null);
    setLoading(false);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (aiAssist) {
      // Defer the actual init to the AiInitConfig modal (it collects the title,
      // search depth, pipeline toggles and seed references).
      setError(null);
      setModal("config");
      return;
    }
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

  async function handleAiSubmit(payload: AiInitPayload) {
    setLoading(true);
    setError(null);
    try {
      const { projectSlug, runId: newRunId } = await api.initProjectAi(payload.title, {
        searchDepth: payload.searchDepth,
        useSpine: payload.useSpine,
        seedReferences: payload.seedReferences,
      });
      setName("");
      setPendingSlug(projectSlug);
      setInitMode(payload.useSpine ? "spine" : "v1a");
      if (newRunId) {
        setRunId(newRunId);
        setModal("progress");
        setLoading(false);
      } else {
        // No run id (agent disabled) — go straight to the new project.
        closeModal();
        await refresh();
        navigate(`/projects/${projectSlug}`);
      }
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
      setModal(null);
    }
  }

  async function handleRunComplete(snapshot: RunLedgerSnapshot) {
    const slug = pendingSlug;
    if (!slug) {
      closeModal();
      await refresh();
      return;
    }
    let wikiPages: string[] = [];
    try {
      wikiPages = (await api.listWiki(slug)).map((p) => p.page);
    } catch {
      /* best-effort — fall back to an empty page list */
    }
    setInitResult(extractInitResult(snapshot, { slug, mode: initMode, wikiPages }));
    setModal("result");
    void refresh();
  }

  async function goToProject() {
    const slug = pendingSlug;
    closeModal();
    await refresh();
    if (slug) navigate(`/projects/${slug}`);
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-1 text-2xl font-bold">Projects</h1>
      <p className="mb-6 text-sm text-slate-500">
        A project is a workspace for one mathematical investigation. Each project
        contains its own wiki, assistant chats, and a set of efforts (proof
        attempts, formalizations, counter-example searches, ...).
      </p>

      <form onSubmit={create} className="mb-6 flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name (e.g. Twin Primes)"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
          />
          <button
            type="submit"
            disabled={loading || (!aiAssist && !name.trim())}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? "…" : aiAssist ? "AI Init" : "Create"}
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={aiAssist}
            onChange={(e) => setAiAssist(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          AI-assist init
          <span className="text-xs text-slate-400">
            — research seed papers &amp; draft a wiki automatically
          </span>
        </label>
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

      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            {modal === "config" && (
              <AiInitConfig onSubmit={handleAiSubmit} onCancel={closeModal} loading={loading} />
            )}
            {modal === "progress" && runId && (
              <>
                <InitAgentProgress
                  runId={runId}
                  mode={initMode}
                  onComplete={handleRunComplete}
                  onError={(msg) => setError(msg)}
                />
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={goToProject}
                    className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Open project
                  </button>
                </div>
              </>
            )}
            {modal === "result" && runId && initResult && pendingSlug && (
              <InitResultView
                runId={runId}
                slug={pendingSlug}
                result={initResult}
                onOpen={closeModal}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
