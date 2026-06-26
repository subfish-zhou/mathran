/**
 * /profile page (user-distillation Phase 1).
 *
 * Three tabs:
 *   - My Papers    — what the user has authored (own / coauthor / advisor)
 *   - My Projects  — active research directions, in the user's own words
 *   - Saved        — Phase 2 placeholder ("paper reactions", currently
 *                    just shows the schema is wired but no data yet)
 *
 * Design choices (per _tasks/user-distillation/PLAN.md):
 *   - All writes are user-initiated through this page. No model write tool.
 *   - The forms are intentionally minimal — enough to seed mathran with
 *     useful context, not a paper-management app. Heavy metadata
 *     (abstracts, embeddings, full citations) lives in the paper-graph.
 *   - Empty states explain WHY a user would fill this in (so mathran
 *     knows what to reference) instead of just "no entries".
 *
 * 2026-06-26.
 */

import { useState } from "react";

import {
  addOwnPaper,
  removeOwnPaper,
  removeProject,
  upsertProject,
  useProfileSnapshot,
  type OwnPaperEntry,
  type ProjectProfileEntry,
} from "../lib/profile.ts";

type Tab = "papers" | "projects" | "saved";

export default function ProfilePage(): JSX.Element {
  const { state, refresh } = useProfileSnapshot();
  const [tab, setTab] = useState<Tab>("papers");
  const snap = state.snapshot ?? {
    papersOwn: [],
    papersCited: [],
    projects: [],
    reactions: [],
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col p-6">
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">Profile</h1>
          <p className="mt-1 text-sm text-slate-500">
            What mathran knows about your work. The model reads this slice
            (read-only) so chat references your own papers and current
            directions accurately. Everything below is user-authored —
            nothing is inferred.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-100"
        >
          Refresh
        </button>
      </header>

      {state.status === "error" && (
        <p className="mb-3 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
          Failed to load profile: {state.error}
        </p>
      )}

      <nav className="mb-4 flex gap-2 border-b border-slate-200">
        <TabButton active={tab === "papers"} onClick={() => setTab("papers")}>
          My Papers ({snap.papersOwn.length})
        </TabButton>
        <TabButton active={tab === "projects"} onClick={() => setTab("projects")}>
          My Projects ({snap.projects.length})
        </TabButton>
        <TabButton active={tab === "saved"} onClick={() => setTab("saved")}>
          Saved ({snap.papersCited.length + snap.reactions.length})
        </TabButton>
      </nav>

      <div className="flex-1 overflow-y-auto">
        {tab === "papers" && (
          <PapersTab papers={snap.papersOwn} onChange={() => void refresh()} />
        )}
        {tab === "projects" && (
          <ProjectsTab projects={snap.projects} onChange={() => void refresh()} />
        )}
        {tab === "saved" && (
          <SavedTab citedCount={snap.papersCited.length} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
        active
          ? "border-amber-500 text-amber-700"
          : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Papers tab ────────────────────────────────────────────────────────

function PapersTab({
  papers,
  onChange,
}: {
  papers: OwnPaperEntry[];
  onChange: () => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Papers you authored, coauthored, or advised. Mathran will reference
          these by title + year when conversation touches your own work.
        </p>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="rounded bg-slate-900 px-3 py-1 text-xs text-white hover:bg-slate-800"
        >
          {adding ? "Cancel" : "+ Add paper"}
        </button>
      </div>

      {adding && <PaperForm onSaved={() => { setAdding(false); onChange(); }} />}

      {papers.length === 0 ? (
        <EmptyState
          title="No papers yet"
          body={
            "When mathran knows your papers, it can reference them precisely " +
            "(e.g. 'as you showed in your 2024 arXiv paper on …'). Add one " +
            "above to get started — only title + role + at least one of " +
            "arxivId/doi is required."
          }
        />
      ) : (
        <ul className="space-y-2">
          {papers.map((p) => (
            <li
              key={p.arxivId ?? p.doi}
              className="rounded border border-slate-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-800">{p.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="capitalize">{p.role}</span>
                    {p.year !== undefined && ` · ${p.year}`}
                    {p.status && ` · ${p.status}`}
                    {p.arxivId && ` · arXiv:${p.arxivId}`}
                    {p.doi && !p.arxivId && ` · doi:${p.doi}`}
                  </p>
                  {p.notes && (
                    <p className="mt-1 text-xs text-slate-600">{p.notes}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const id = p.arxivId ?? p.doi;
                    if (!id) return;
                    if (!confirm(`Remove "${p.title}" from profile?`)) return;
                    void removeOwnPaper(id).then(onChange);
                  }}
                  className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PaperForm({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [title, setTitle] = useState("");
  const [arxivId, setArxivId] = useState("");
  const [doi, setDoi] = useState("");
  const [year, setYear] = useState("");
  const [role, setRole] = useState<"author" | "coauthor" | "advisor">("author");
  const [status, setStatus] = useState<"published" | "preprint" | "draft">("preprint");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit =
    title.trim().length > 0 && (arxivId.trim().length > 0 || doi.trim().length > 0);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      await addOwnPaper({
        title: title.trim(),
        arxivId: arxivId.trim() || undefined,
        doi: doi.trim() || undefined,
        year: year ? Number(year) : undefined,
        role,
        status,
        notes: notes.trim() || undefined,
      });
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-3 grid gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm"
    >
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Title *</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">arXiv id</span>
          <input
            value={arxivId}
            onChange={(e) => setArxivId(e.target.value)}
            placeholder="2401.12345"
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">DOI</span>
          <input
            value={doi}
            onChange={(e) => setDoi(e.target.value)}
            placeholder="10.1090/jams/123"
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      </div>
      <p className="text-[11px] text-slate-500">
        At least one of arXiv id or DOI is required (used as the dedup key).
      </p>
      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Year</span>
          <input
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="author">author</option>
            <option value="coauthor">coauthor</option>
            <option value="advisor">advisor</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="preprint">preprint</option>
            <option value="published">published</option>
            <option value="draft">draft</option>
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Notes</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="What's the one-sentence pitch mathran should know about this paper?"
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        />
      </label>
      {err && <p className="text-xs text-rose-700">{err}</p>}
      <div>
        <button
          type="submit"
          disabled={!canSubmit || submitting}
          className="rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save paper"}
        </button>
      </div>
    </form>
  );
}

// ─── Projects tab ──────────────────────────────────────────────────────

function ProjectsTab({
  projects,
  onChange,
}: {
  projects: ProjectProfileEntry[];
  onChange: () => void;
}): JSX.Element {
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Active research directions in your own words. Methods you typically
          reach for, collaborators, and the elevator pitch — what you'd tell a
          new colleague at lunch.
        </p>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="rounded bg-slate-900 px-3 py-1 text-xs text-white hover:bg-slate-800"
        >
          {adding ? "Cancel" : "+ Add project"}
        </button>
      </div>

      {adding && (
        <ProjectForm onSaved={() => { setAdding(false); onChange(); }} />
      )}

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body={
            "Tell mathran what you're working on. A short description of each " +
            "active direction lets the model bring context to chat without you " +
            "having to recap every time."
          }
        />
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => (
            <li
              key={p.slug}
              className="rounded border border-slate-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-800">{p.title}</p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="font-mono">{p.slug}</span>
                    {p.status && ` · ${p.status}`}
                    {p.collaborators && p.collaborators.length > 0 &&
                      ` · with ${p.collaborators.join(", ")}`}
                  </p>
                  {p.description && (
                    <p className="mt-1 text-xs text-slate-600">
                      {p.description}
                    </p>
                  )}
                  {p.methods && p.methods.length > 0 && (
                    <p className="mt-1 text-xs text-slate-500">
                      Methods: {p.methods.join(", ")}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (!confirm(`Remove project "${p.title}"?`)) return;
                    void removeProject(p.slug).then(onChange);
                  }}
                  className="shrink-0 rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectForm({ onSaved }: { onSaved: () => void }): JSX.Element {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"active" | "paused" | "finished" | "abandoned">("active");
  const [methods, setMethods] = useState("");
  const [collaborators, setCollaborators] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canSubmit = slug.trim().length > 0 && title.trim().length > 0;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      await upsertProject({
        slug: slug.trim(),
        title: title.trim(),
        status,
        methods: methods
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        collaborators: collaborators
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        description: description.trim() || undefined,
      });
      onSaved();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mb-3 grid gap-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm"
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Slug *</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="goldbach-s-conjecture"
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 font-mono"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Title *</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Goldbach's conjecture"
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      </div>
      <p className="text-[11px] text-slate-500">
        Slug matches the workspace project directory when one exists; otherwise
        any lowercase-dash slug works.
      </p>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Status</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        >
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="finished">finished</option>
          <option value="abandoned">abandoned</option>
        </select>
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">
          Methods (comma-separated)
        </span>
        <input
          value={methods}
          onChange={(e) => setMethods(e.target.value)}
          placeholder="sieve method, circle method"
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">
          Collaborators (comma-separated)
        </span>
        <input
          value={collaborators}
          onChange={(e) => setCollaborators(e.target.value)}
          placeholder=""
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="The elevator pitch for mathran."
          className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1"
        />
      </label>
      {err && <p className="text-xs text-rose-700">{err}</p>}
      <div>
        <button
          type="submit"
          disabled={!canSubmit || submitting}
          className="rounded bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save project"}
        </button>
      </div>
    </form>
  );
}

// ─── Saved tab (Phase 2 placeholder) ───────────────────────────────────

function SavedTab({ citedCount }: { citedCount: number }): JSX.Element {
  return (
    <EmptyState
      title={`Saved papers + reactions ${
        citedCount > 0 ? `(${citedCount} cited)` : ""
      }`}
      body={
        "Phase 2 will hang 👍 / 👎 / ⭐ / 📝 buttons off paper cards in chat. " +
        "Reactions land here so mathran knows your stance on what you've read. " +
        "Until then, this tab is empty — papers you cite manually appear " +
        "in the backend at ~/.mathran/profile/papers-cited.jsonl."
      }
    />
  );
}

// ─── Shared ────────────────────────────────────────────────────────────

function EmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}): JSX.Element {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      <p className="mx-auto mt-2 max-w-xl text-sm text-slate-500">{body}</p>
    </div>
  );
}
