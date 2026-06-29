/**
 * WikiPanel — list + view/edit wiki pages of one project.
 *
 * Now route-driven (T1-E):
 *   /projects/:slug/wiki              → page index + welcome panel
 *   /projects/:slug/wiki/:page        → that page
 *
 * `currentPage` is null on the index route; non-null on a specific page route.
 * Wiki versioning surfaces as a "History" button that lists snapshots
 * (T1-A backend feature).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { safeRenderMarkdown } from "../lib/safe-markdown.ts";
import {
  api,
  type WikiDiffResponse,
  type WikiHistoryEntry,
  type WikiPage,
  type WikiPageSummary,
} from "../lib/api.ts";

export default function WikiPanel({
  projectSlug,
  currentPage,
}: {
  projectSlug: string;
  currentPage: string | null;
}) {
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [history, setHistory] = useState<WikiHistoryEntry[] | null>(null);
  const [diff, setDiff] = useState<WikiDiffResponse | null>(null);
  const [diffFrom, setDiffFrom] = useState<string>("");
  const [diffTo, setDiffTo] = useState<string>("current");
  const navigate = useNavigate();

  // Refresh index whenever the project changes or after a save/delete.
  async function refreshIndex() {
    setError(null);
    try {
      setPages(await api.listWiki(projectSlug));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refreshIndex();
  }, [projectSlug]);

  // Load the requested page (or clear it when on the index).
  useEffect(() => {
    setPage(null);
    setDraft("");
    setEditing(false);
    setHistory(null);
    setDiff(null);
    if (!currentPage) return;
    setError(null);
    api
      .getWikiPage(projectSlug, currentPage)
      .then((p) => {
        setPage(p);
        setDraft(p.body);
      })
      .catch((e) => setError((e as Error).message));
  }, [projectSlug, currentPage]);

  async function save() {
    if (!page) return;
    setError(null);
    setStatus("Saving…");
    try {
      const saved = await api.saveWikiPage(projectSlug, page.page, draft);
      setPage(saved);
      setDraft(saved.body);
      setEditing(false);
      setStatus("Saved.");
      await refreshIndex();
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }

  async function showHistory() {
    if (!page) return;
    setError(null);
    try {
      const h = await api.wikiHistory(projectSlug, page.page);
      setHistory(h);
      // Default the "from" selector to the latest history version so a single
      // click on "Compare" gives the most useful diff (latest snapshot vs current).
      if (h.length > 0 && !diffFrom) setDiffFrom(String(h[0].version));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * GAP #10: load a unified diff between two versions and render it inline.
   * "" / "current" map to the live page body; positive integers map to
   * `.history/<page>/v<N>.md`.
   */
  async function showDiff() {
    if (!page) return;
    setError(null);
    try {
      const from =
        diffFrom === "" || diffFrom === "current" ? "current" : Number(diffFrom);
      const to = diffTo === "current" ? "current" : Number(diffTo);
      const d = await api.wikiDiff(projectSlug, page.page, { from, to });
      setDiff(d);
    } catch (e) {
      setError((e as Error).message);
      setDiff(null);
    }
  }

  async function viewHistoryVersion(v: number) {
    if (!page) return;
    try {
      const old = await api.wikiHistoryVersion(projectSlug, page.page, v);
      setDraft(old.body);
      setEditing(true);
      setStatus(`Loaded v${v} into editor (save to make it the new head)`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createPage(e: React.FormEvent) {
    e.preventDefault();
    const name = creatingName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!name) return;
    try {
      await api.saveWikiPage(projectSlug, name, "# New page\n\n");
      setCreatingName("");
      await refreshIndex();
      navigate(`/projects/${projectSlug}/wiki/${name}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const rendered = useMemo(() => (page ? safeRenderMarkdown(page.body) : ""), [page]);

  return (
    <div className="grid h-full grid-cols-[16rem_1fr] overflow-hidden">
      <div className="flex flex-col overflow-hidden border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Wiki pages
          </h3>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {pages.length === 0 && (
            <li className="px-3 py-2 text-sm text-slate-400">No wiki pages yet.</li>
          )}
          {pages.map((p) => (
            <li key={p.page}>
              <Link
                to={`/projects/${projectSlug}/wiki/${p.page}`}
                className={`block rounded-md px-3 py-2 text-left text-sm ${
                  currentPage === p.page ? "bg-slate-100 font-medium" : "hover:bg-slate-50"
                }`}
              >
                {p.title ?? p.page}
              </Link>
            </li>
          ))}
        </ul>
        <form onSubmit={createPage} className="border-t border-slate-200 p-3">
          <input
            value={creatingName}
            onChange={(e) => setCreatingName(e.target.value)}
            placeholder="new-page-name"
            className="mb-2 w-full rounded-md border border-slate-300 px-2 py-1 text-xs"
          />
          <button
            type="submit"
            disabled={!creatingName.trim()}
            className="w-full rounded-md bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50"
          >
            + New page
          </button>
        </form>
      </div>

      <div className="flex flex-col overflow-hidden">
        {error && (
          <div className="m-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        {!currentPage && !error && (
          <div className="p-6 text-sm text-slate-400">
            <p>Pick a wiki page on the left, or create a new one.</p>
          </div>
        )}
        {page && (
          <>
            <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
              <h1 className="font-mono text-sm font-semibold">{page.page}.md</h1>
              <div className="flex items-center gap-3">
                {status && <span className="text-xs text-slate-400">{status}</span>}
                <button
                  onClick={showHistory}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100"
                >
                  History
                </button>
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
            {history && history.length > 0 && (
              <div className="border-b border-slate-200 bg-amber-50 px-6 py-2 text-xs">
                <span className="font-semibold text-amber-800">History:</span>{" "}
                {history.map((h, i) => (
                  <span key={h.version}>
                    {i > 0 && " · "}
                    <button
                      onClick={() => viewHistoryVersion(h.version)}
                      className="underline hover:text-amber-900"
                    >
                      v{h.version}
                    </button>{" "}
                    <span className="text-amber-700">
                      ({new Date(h.savedAt).toLocaleString()})
                    </span>
                  </span>
                ))}
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-semibold text-amber-800">Compare:</span>
                  <select
                    value={diffFrom}
                    onChange={(e) => setDiffFrom(e.target.value)}
                    className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs"
                  >
                    <option value="">(latest history)</option>
                    {history.map((h) => (
                      <option key={h.version} value={String(h.version)}>
                        v{h.version}
                      </option>
                    ))}
                    <option value="current">current</option>
                  </select>
                  <span className="text-amber-700">→</span>
                  <select
                    value={diffTo}
                    onChange={(e) => setDiffTo(e.target.value)}
                    className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs"
                  >
                    <option value="current">current</option>
                    {history.map((h) => (
                      <option key={h.version} value={String(h.version)}>
                        v{h.version}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={showDiff}
                    className="rounded-md border border-amber-400 bg-white px-2 py-0.5 text-xs hover:bg-amber-100"
                  >
                    Show diff
                  </button>
                  {diff && (
                    <button
                      onClick={() => setDiff(null)}
                      className="rounded-md border border-amber-300 px-2 py-0.5 text-xs hover:bg-amber-100"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}
            {diff && (
              <div className="border-b border-slate-200 bg-slate-50 px-6 py-3">
                <div className="mb-1 text-xs text-slate-500">
                  Diff: {diff.from.label} → {diff.to.label}
                </div>
                <pre className="max-h-72 overflow-auto rounded-md border border-slate-200 bg-white p-3 font-mono text-xs leading-relaxed">
                  {renderUnifiedDiff(diff.patch)}
                </pre>
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-6">
              {editing ? (
                /* Split view: raw markdown left, live preview right.
                 * Same `.md` style used by view mode, KaTeX renders via
                 * the marked-katex-extension wired in lib/markdown.ts.
                 * Preview updates on every keystroke — `safeRenderMarkdown`
                 * is cheap enough (marked + DOMPurify, no syntax tree
                 * persistence) that 100KB wiki pages still feel instant.
                 *
                 * On screens narrower than 1100px the split flexes to
                 * vertical so an editor on a laptop still has usable
                 * width per pane. 2026-06-29 fix for "no way to edit"
                 * complaint (textarea was 100% width and gave no live
                 * feedback for math/markdown).
                 */
                <div className="flex h-full min-h-[24rem] flex-col gap-4 xl:flex-row">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="# markdown… (KaTeX: \\(inline\\), \\[display\\], $math$, $$display$$)"
                    spellCheck={false}
                    className="h-full min-h-[24rem] w-full xl:w-1/2 flex-1 resize-none rounded-md border border-slate-300 bg-slate-50 p-4 font-mono text-sm leading-relaxed outline-none focus:border-slate-500"
                  />
                  <div
                    className="md max-w-none flex-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-4 xl:w-1/2"
                    aria-label="Live preview"
                    dangerouslySetInnerHTML={{
                      __html: safeRenderMarkdown(draft) as string,
                    }}
                  />
                </div>
              ) : (
                <div className="md max-w-3xl" dangerouslySetInnerHTML={{ __html: rendered as string }} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Colorize a unified-diff string for inline display: `+` lines green, `-`
 * lines red, `@@` hunks blue, everything else default. Renders into a single
 * `<>...</>` fragment of `<span>` nodes for use inside a `<pre>`.
 */
function renderUnifiedDiff(patch: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const lines = patch.split("\n");
  lines.forEach((line, i) => {
    let cls = "";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "text-slate-500";
    else if (line.startsWith("@@")) cls = "text-sky-700";
    else if (line.startsWith("+")) cls = "bg-green-50 text-green-800";
    else if (line.startsWith("-")) cls = "bg-red-50 text-red-800";
    out.push(
      <span key={i} className={`block whitespace-pre-wrap ${cls}`}>
        {line || "\u00a0"}
      </span>,
    );
  });
  return out;
}
