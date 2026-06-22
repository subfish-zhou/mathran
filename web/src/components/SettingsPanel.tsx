/**
 * SettingsPanel — the SPA `/settings` page.
 *
 * Covers every {@link MathranSettings} field across the three cascade layers
 * (USER / WORKSPACE / PROJECT). The USER tab is whitelisted to ui.theme /
 * editor / modelPreference (policy fields are hidden + a note explains why);
 * the WORKSPACE / PROJECT tabs expose the full schema.
 *
 * Backed by:
 *   GET /api/settings/effective   — for per-field "(from …)" source hints
 *   GET /api/settings/:layer      — the raw layer we're editing
 *   PUT /api/settings/:layer      — saves ONLY the changed fields (a diff), so
 *                                   hand-edited passthrough keys survive.
 *
 * The LLM-provider editor lives at /settings/providers; a link sits at the
 * bottom of this page.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, type ProjectSummary } from "../lib/api.ts";
import {
  APPROVAL_POLICIES,
  THEMES,
  addApprovalRule,
  diffSettings,
  hasUnsavedChanges,
  isSectionEditable,
  parseDenylist,
  removeApprovalRule,
  serializeDenylist,
  sourceLabel,
  type ApprovalRule,
  type ApprovalSettings,
  type EffectiveSettingsResponse,
  type MathranSettings,
  type SettingsLayerName,
} from "../lib/settings-client.ts";

const LAYER_TABS: SettingsLayerName[] = ["user", "workspace", "project"];

export default function SettingsPanel() {
  const [layer, setLayer] = useState<SettingsLayerName>("user");
  const [projectSlug, setProjectSlug] = useState<string>("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const [base, setBase] = useState<MathranSettings>({});
  const [draft, setDraft] = useState<MathranSettings>({});
  const [effective, setEffective] = useState<EffectiveSettingsResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Load the available projects once (for the PROJECT tab dropdown).
  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => {});
  }, []);

  const load = useCallback(
    async (l: SettingsLayerName, slug: string) => {
      setLoading(true);
      setError(null);
      setStatus(null);
      try {
        const slugArg = l === "project" ? slug || undefined : undefined;
        if (l === "project" && !slugArg) {
          setBase({});
          setDraft({});
          setEffective(null);
          return;
        }
        const [raw, eff] = await Promise.all([
          api.getSettings(l, slugArg),
          api.getEffectiveSettings(slugArg),
        ]);
        setBase(raw.settings ?? {});
        setDraft(structuredClone(raw.settings ?? {}));
        setEffective(eff);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(layer, projectSlug);
  }, [layer, projectSlug, load]);

  const dirty = hasUnsavedChanges(base, draft);

  function switchLayer(next: SettingsLayerName) {
    if (next === layer) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setLayer(next);
  }

  function patchDraft(mut: (d: MathranSettings) => void) {
    setDraft((prev) => {
      const next = structuredClone(prev);
      mut(next);
      return next;
    });
  }

  async function save() {
    const patch = diffSettings(base, draft);
    if (Object.keys(patch).length === 0) {
      setStatus("Nothing to save.");
      return;
    }
    setError(null);
    setStatus("Saving…");
    try {
      const slugArg = layer === "project" ? projectSlug || undefined : undefined;
      const res = await api.putSettings(layer, patch, slugArg);
      setBase(res.settings ?? {});
      setDraft(structuredClone(res.settings ?? {}));
      setStatus("Saved.");
      // Refresh effective so source hints stay accurate.
      void api.getEffectiveSettings(slugArg).then(setEffective).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }

  function reset() {
    setDraft(structuredClone(base));
    setStatus(null);
    setError(null);
  }

  const sources = effective?.sources ?? {};
  const editable = (section: string) => isSectionEditable(layer, section);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl pb-24">
        <h1 className="mb-1 text-xl font-bold tracking-tight">Settings</h1>
        <p className="mb-4 text-sm text-slate-500">
          Edit layered <code>.mathran/settings.json</code>. Lower layers are
          overridden by higher ones (USER &lt; WORKSPACE &lt; PROJECT).
        </p>

        {/* Layer tabs */}
        <div className="mb-4 flex items-center gap-1 border-b border-slate-200">
          {LAYER_TABS.map((l) => (
            <button
              key={l}
              onClick={() => switchLayer(l)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize transition ${
                layer === l
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {l}
            </button>
          ))}
          {layer === "project" && (
            <select
              value={projectSlug}
              onChange={(e) => {
                if (dirty && !window.confirm("Discard unsaved changes?")) return;
                setProjectSlug(e.target.value);
              }}
              className="ml-2 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-slate-500"
            >
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name ?? p.slug}
                </option>
              ))}
            </select>
          )}
        </div>

        {layer === "user" && (
          <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            The USER layer is whitelisted: only <strong>theme</strong>,{" "}
            <strong>editor</strong> and <strong>model preference</strong> are
            writable here. Policy fields (approval, skills, hooks, agent) are
            workspace/project-owned.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {layer === "project" && !projectSlug ? (
          <p className="text-sm text-slate-400">
            Pick a project above to edit its settings.
          </p>
        ) : loading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : (
          <div className="space-y-6">
            {/* UI */}
            <Section title="UI" editable={editable("ui")}>
              <Field label="Theme" hint={sourceLabel(sources, "ui.theme")}>
                <div className="flex gap-3">
                  {THEMES.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="radio"
                        name="theme"
                        disabled={!editable("ui")}
                        checked={(draft.ui?.theme ?? "system") === t}
                        onChange={() =>
                          patchDraft((d) => {
                            d.ui = { ...(d.ui ?? {}), theme: t };
                          })
                        }
                      />
                      {t}
                    </label>
                  ))}
                </div>
              </Field>
            </Section>

            {/* Editor */}
            <Section title="Editor" editable={editable("editor")}>
              <Field label="Command" hint={sourceLabel(sources, "editor")}>
                <input
                  value={draft.editor ?? ""}
                  disabled={!editable("editor")}
                  onChange={(e) => patchDraft((d) => { d.editor = e.target.value; })}
                  placeholder="nvim"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500 disabled:bg-slate-100"
                />
              </Field>
            </Section>

            {/* Model preference */}
            <Section title="Model Preference" editable={editable("modelPreference")}>
              <Field label="Default model" hint={sourceLabel(sources, "modelPreference.default")}>
                <input
                  value={draft.modelPreference?.default ?? ""}
                  disabled={!editable("modelPreference")}
                  onChange={(e) =>
                    patchDraft((d) => {
                      d.modelPreference = { ...(d.modelPreference ?? {}), default: e.target.value };
                    })
                  }
                  placeholder="copilot/gpt-5.5"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500 disabled:bg-slate-100"
                />
              </Field>
            </Section>

            {/* Approval policy */}
            {editable("approval") && (
              <ApprovalSection
                value={draft.approval ?? {}}
                sources={sources}
                onChange={(next) => patchDraft((d) => { d.approval = next; })}
              />
            )}

            {/* Skills */}
            {editable("skills") && (
              <Section title="Skills" editable>
                <Field label="Disabled (one per line)" hint={sourceLabel(sources, "skills.disabled")}>
                  <textarea
                    value={(draft.skills?.disabled ?? []).join("\n")}
                    onChange={(e) =>
                      patchDraft((d) => {
                        d.skills = { ...(d.skills ?? {}), disabled: parseDenylist(e.target.value) };
                      })
                    }
                    rows={3}
                    placeholder="lean-stuck-debugger"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
                  />
                </Field>
              </Section>
            )}

            {/* Hooks */}
            {editable("hooks") && (
              <Section title="Hooks" editable>
                <p className="mb-2 text-xs text-slate-400">
                  Preview — hook execution is gated on a separate change. Listed
                  hooks are whitelisted but not yet run.
                </p>
                <Field label="Allowed (one per line)" hint={sourceLabel(sources, "hooks.allowed")}>
                  <textarea
                    value={(draft.hooks?.allowed ?? []).join("\n")}
                    onChange={(e) =>
                      patchDraft((d) => {
                        d.hooks = { ...(d.hooks ?? {}), allowed: parseDenylist(e.target.value) };
                      })
                    }
                    rows={3}
                    placeholder="post-edit.sh"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
                  />
                </Field>
              </Section>
            )}

            {/* Agent */}
            {editable("agent") && (
              <Section title="Agent" editable>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Max iterations" hint={sourceLabel(sources, "agent.maxIterations")}>
                    <input
                      type="number"
                      value={draft.agent?.maxIterations ?? ""}
                      onChange={(e) =>
                        patchDraft((d) => {
                          const n = e.target.value === "" ? undefined : Number(e.target.value);
                          d.agent = { ...(d.agent ?? {}), maxIterations: n };
                        })
                      }
                      placeholder="200"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
                    />
                  </Field>
                  <Field label="Timeout (ms)" hint={sourceLabel(sources, "agent.timeoutMs")}>
                    <input
                      type="number"
                      value={draft.agent?.timeoutMs ?? ""}
                      onChange={(e) =>
                        patchDraft((d) => {
                          const n = e.target.value === "" ? undefined : Number(e.target.value);
                          d.agent = { ...(d.agent ?? {}), timeoutMs: n };
                        })
                      }
                      placeholder="120000"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
                    />
                  </Field>
                </div>
              </Section>
            )}
          </div>
        )}

        <div className="mt-8 border-t border-slate-200 pt-4 text-sm">
          See also:{" "}
          <Link to="/settings/providers" className="font-medium text-slate-700 underline">
            LLM Providers →
          </Link>
        </div>
      </div>

      {/* Sticky save bar */}
      {!(layer === "project" && !projectSlug) && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/90 px-6 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-end gap-3">
            {status && <span className="text-xs text-slate-400">{status}</span>}
            {dirty && <span className="text-xs text-amber-600">unsaved changes</span>}
            <button
              onClick={reset}
              disabled={!dirty}
              className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-40"
            >
              Reset
            </button>
            <button
              onClick={save}
              disabled={!dirty}
              className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              Save changes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── small presentational helpers ────────────────────────────────────────

function Section({
  title,
  editable,
  children,
}: {
  title: string;
  editable: boolean;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
        {!editable && (
          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-400">
            read-only at this layer
          </span>
        )}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <label className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-600">
        {label}
        {hint && <span className="text-[10px] font-normal text-slate-400">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

function ApprovalSection({
  value,
  sources,
  onChange,
}: {
  value: ApprovalSettings;
  sources: Record<string, SettingsLayerName>;
  onChange: (next: ApprovalSettings) => void;
}) {
  const [newRule, setNewRule] = useState<ApprovalRule>({ tool: "", action: "allow" });

  function patch(mut: (a: ApprovalSettings) => void) {
    const next = structuredClone(value);
    mut(next);
    onChange(next);
  }

  return (
    <Section title="Approval Policy" editable>
      <Field label="Policy" hint={sourceLabel(sources, "approval.policy")}>
        <div className="flex flex-wrap gap-3">
          {APPROVAL_POLICIES.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="approval-policy"
                checked={(value.policy ?? "on-request") === p}
                onChange={() => patch((a) => { a.policy = p; })}
              />
              {p}
            </label>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Learning" hint={sourceLabel(sources, "approval.learning")}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.learning ?? false}
              onChange={(e) => patch((a) => { a.learning = e.target.checked; })}
            />
            enabled
          </label>
        </Field>
        <Field label="Propose after" hint={sourceLabel(sources, "approval.proposeAfter")}>
          <input
            type="number"
            value={value.proposeAfter ?? ""}
            onChange={(e) =>
              patch((a) => {
                a.proposeAfter = e.target.value === "" ? undefined : Number(e.target.value);
              })
            }
            placeholder="5"
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
          />
        </Field>
      </div>

      {/* Rules */}
      <Field label="Rules">
        <ul className="mb-2 space-y-1">
          {(value.rules ?? []).map((r, i) => (
            <li
              key={i}
              className="flex items-center justify-between rounded border border-slate-200 px-2 py-1 text-xs"
            >
              <span className="font-mono">
                {r.tool}
                {r.prefix ? ` prefix "${r.prefix}"` : ""}
                {r.pathGlob ? ` glob "${r.pathGlob}"` : ""} → {r.action}
                {r.scope ? ` (${r.scope})` : ""}
              </span>
              <button
                onClick={() => patch((a) => { a.rules = removeApprovalRule(a.rules, i); })}
                className="ml-2 text-red-600 hover:underline"
              >
                remove
              </button>
            </li>
          ))}
          {(value.rules ?? []).length === 0 && (
            <li className="text-xs text-slate-400">No inline rules.</li>
          )}
        </ul>
        <div className="flex flex-wrap items-end gap-2 rounded border border-dashed border-slate-300 p-2">
          <input
            value={newRule.tool}
            onChange={(e) => setNewRule((r) => ({ ...r, tool: e.target.value }))}
            placeholder="tool (e.g. bash)"
            className="w-28 rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-500"
          />
          <input
            value={newRule.prefix ?? ""}
            onChange={(e) => setNewRule((r) => ({ ...r, prefix: e.target.value || undefined }))}
            placeholder="prefix"
            className="w-28 rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-500"
          />
          <select
            value={newRule.action}
            onChange={(e) => setNewRule((r) => ({ ...r, action: e.target.value as "allow" | "deny" }))}
            className="rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-slate-500"
          >
            <option value="allow">allow</option>
            <option value="deny">deny</option>
          </select>
          <button
            disabled={!newRule.tool.trim()}
            onClick={() => {
              patch((a) => { a.rules = addApprovalRule(a.rules, { ...newRule, tool: newRule.tool.trim() }); });
              setNewRule({ tool: "", action: "allow" });
            }}
            className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            + add
          </button>
        </div>
      </Field>

      {/* Denylist */}
      <Field label="Denylist (one per line)" hint={sourceLabel(sources, "approval.denylist")}>
        <textarea
          value={serializeDenylist(value.denylist)}
          onChange={(e) => patch((a) => { a.denylist = parseDenylist(e.target.value); })}
          rows={3}
          placeholder={"bash:rm -rf\nbash:sudo *"}
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs outline-none focus:border-slate-500"
        />
      </Field>
    </Section>
  );
}
