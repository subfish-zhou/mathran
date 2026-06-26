/**
 * EffortDocumentPanel — view/edit the main document of a single effort.
 *
 * Mathub's `workspace/<effortId>/document` page lives here. The effort detail
 * route also exposes:
 *   - status / type metadata (editable inline)
 *   - "snapshot" button → freezes current state to `.versions/v<N+1>/`
 *   - per-effort chat via the route sidebar.
 *
 * We deliberately keep the doc as plain Markdown for v0.1.0 (no LaTeX
 * preview, no comments overlay). That's already enough to round-trip
 * blueprint-style writing.
 */
import { useEffect, useMemo, useState } from "react";
import { safeRenderMarkdown } from "../lib/safe-markdown.ts";
import { api, type EffortSummary } from "../lib/api.ts";

const STATUSES = [
  "DRAFT",
  "PROPOSED",
  "UNDER_REVIEW",
  "PROMISING",
  "DEAD_END",
  "VERIFIED",
  "ARCHIVED",
] as const;

export default function EffortDocumentPanel({
  projectSlug,
  effortSlug,
}: {
  projectSlug: string;
  effortSlug: string;
}) {
  const [effort, setEffort] = useState<EffortSummary | null>(null);
  const [doc, setDoc] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [versions, setVersions] = useState<number[]>([]);

  async function reload() {
    setError(null);
    setStatus(null);
    try {
      const e = await api.getEffort(projectSlug, effortSlug);
      setEffort(e.effort);
      const d = await api.getEffortDocument(projectSlug, effortSlug);
      setDoc(d.document);
      setDraft(d.document);
      setVersions(await api.listEffortVersions(projectSlug, effortSlug));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    setEffort(null);
    setDoc("");
    setDraft("");
    setEditing(false);
    void reload();
  }, [projectSlug, effortSlug]);

  async function save() {
    setStatus(null);
    setError(null);
    try {
      const r = await api.saveEffortDocument(projectSlug, effortSlug, draft);
      setDoc(r.document);
      setEditing(false);
      setStatus("Document saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function changeStatus(next: string) {
    setError(null);
    try {
      const r = await api.patchEffort(projectSlug, effortSlug, { status: next });
      setEffort(r.effort);
      setStatus(`Status → ${r.effort.status}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function snapshot() {
    setError(null);
    try {
      const r = await api.snapshotEffort(projectSlug, effortSlug);
      setVersions(await api.listEffortVersions(projectSlug, effortSlug));
      setStatus(`Snapshotted as v${r.version}.`);
      // Refresh metadata (currentVersion bumps).
      const e = await api.getEffort(projectSlug, effortSlug);
      setEffort(e.effort);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const rendered = useMemo(() => safeRenderMarkdown(doc || "_(empty document)_"), [doc]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-6 py-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Effort document
          </h2>
          {effort && (
            <p className="text-sm font-medium">
              {effort.title}
              <span className="ml-2 text-xs text-slate-500 font-mono">
                {effort.type} · v{effort.currentVersion}
              </span>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {effort && (
            <select
              value={effort.status}
              onChange={(e) => void changeStatus(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
            >
              {STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          )}
          <button
            onClick={snapshot}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs hover:border-slate-500"
          >
            Snapshot
          </button>
          {!editing ? (
            <button
              onClick={() => {
                setEditing(true);
                setDraft(doc);
              }}
              className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white"
            >
              Edit
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  setEditing(false);
                  setDraft(doc);
                }}
                className="rounded-md border border-slate-300 px-3 py-1 text-xs"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white"
              >
                Save
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      {status && (
        <div className="mx-6 mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{status}</div>
      )}

      <div className="flex-1 overflow-y-auto p-6">
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-full w-full rounded-md border border-slate-300 bg-white p-3 font-mono text-sm"
          />
        ) : (
          <div
            className="md prose max-w-none"
            dangerouslySetInnerHTML={{ __html: rendered as string }}
          />
        )}
        {!editing && versions.length > 0 && (
          <div className="mt-6 text-xs text-slate-500">
            <span className="font-semibold">Snapshots:</span>{" "}
            {versions.map((v) => `v${v}`).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}
