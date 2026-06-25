/**
 * ProvidersPanel — `/settings` page.
 *
 * Backed by GET /api/providers (masked: no plaintext keys) and PUT /api/providers
 * (merges fields into config.toml; only fields submitted by the form are
 * written, so empty API-key inputs preserve the existing secret).
 *
 * Features:
 *  - Edit the default model
 *  - Per-provider rows showing key status + kind + (azure-specific) endpoint /
 *    deployment / apiVersion + baseUrl (openai/ollama) + per-provider default
 *    model
 *  - "Add provider" form for wiring a new entry into config.toml without
 *    hand-editing TOML
 *
 * Plaintext API keys are NEVER returned by the API. The form only shows a
 * password placeholder; saving a blank value keeps the existing secret.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ProvidersResponse } from "../lib/api.ts";
import { useCopilotModels } from "../lib/copilot-models.ts";
import ModelComboBox from "./ModelComboBox.tsx";

interface DraftRow {
  kind: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

const VALID_KINDS = ["openai", "anthropic", "azure", "copilot", "ollama"] as const;

function emptyDraft(kind: string): DraftRow {
  return {
    kind,
    apiKey: "",
    model: "",
    baseUrl: "",
    endpoint: "",
    deployment: "",
    apiVersion: "",
  };
}

export default function ProvidersPanel() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [defaultModel, setDefaultModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // 2026-06-25 — real Copilot model list for the default-model datalist.
  const copilotModels = useCopilotModels();

  // "Add provider" form state. Toggled from a button below the rows.
  const [newKey, setNewKey] = useState("");
  const [newKind, setNewKind] = useState<string>("openai");
  const [adding, setAdding] = useState(false);

  async function refresh() {
    setError(null);
    try {
      const res = await api.getProviders();
      setData(res);
      setDefaultModel(res.defaultModel ?? "");
      const init: Record<string, DraftRow> = {};
      for (const [k, v] of Object.entries(res.providers)) {
        init[k] = {
          kind: v.kind,
          apiKey: "",
          model: v.model ?? "",
          baseUrl: v.baseUrl ?? "",
          endpoint: v.endpoint ?? "",
          deployment: v.deployment ?? "",
          apiVersion: v.apiVersion ?? "",
        };
      }
      setDrafts(init);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function updateField<K extends keyof DraftRow>(key: string, field: K, value: DraftRow[K]) {
    setDrafts((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));
  }

  function addProviderRow() {
    const trimmedKey = newKey.trim();
    if (!trimmedKey) return;
    if (!/^[a-z][a-z0-9._-]*$/i.test(trimmedKey)) {
      setError(`Provider key "${trimmedKey}" must be alphanumeric (with . _ -).`);
      return;
    }
    if (drafts[trimmedKey]) {
      setError(`Provider "${trimmedKey}" already exists.`);
      return;
    }
    setError(null);
    setDrafts((d) => ({ ...d, [trimmedKey]: emptyDraft(newKind) }));
    setNewKey("");
    setAdding(false);
  }

  async function save() {
    setError(null);
    setStatus("Saving…");
    const providers: Record<string, Record<string, unknown>> = {};
    for (const [key, draft] of Object.entries(drafts)) {
      const entry: Record<string, unknown> = {};
      // Newly-added rows must carry a kind; existing rows only emit fields
      // the user actually changed (kept simple by always sending kind for
      // new rows and the four optional fields whenever non-blank).
      const isNew = !data?.providers?.[key];
      if (isNew) entry.kind = draft.kind;
      // Only send a key when the user typed one — never echo stored secrets.
      if (draft.apiKey.trim()) entry.apiKey = draft.apiKey.trim();
      if (draft.model.trim()) entry.defaultModel = draft.model.trim();
      if (draft.baseUrl.trim()) entry.baseUrl = draft.baseUrl.trim();
      if (draft.endpoint.trim()) entry.endpoint = draft.endpoint.trim();
      if (draft.deployment.trim()) entry.deployment = draft.deployment.trim();
      if (draft.apiVersion.trim()) entry.apiVersion = draft.apiVersion.trim();
      if (Object.keys(entry).length > 0) providers[key] = entry;
    }
    try {
      const payload: { providers?: typeof providers; defaultModel?: string } = { providers };
      if (defaultModel.trim()) payload.defaultModel = defaultModel.trim();
      await api.saveProviders(payload);
      setStatus("Saved.");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }

  function rowKindHint(kind: string): string[] {
    if (kind === "azure") return ["endpoint", "deployment", "apiVersion"];
    if (kind === "openai") return ["baseUrl"];
    if (kind === "ollama") return ["baseUrl"];
    return [];
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <Link
          to="/settings"
          className="mb-3 inline-block text-xs text-slate-500 underline hover:text-slate-700"
        >
          ← Settings
        </Link>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Providers
          </h2>
          <div className="flex items-center gap-3">
            {status && <span className="text-xs text-slate-400">{status}</span>}
            <button
              onClick={save}
              className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white"
            >
              Save
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        <div className="mb-6 rounded-md border border-slate-200 bg-white p-4">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Default model
          </label>
          <ModelComboBox
            value={defaultModel}
            onChange={setDefaultModel}
            options={copilotModels.models}
            placeholder="copilot/gpt-5.5"
            className="w-full"
          />
          <p className="mt-1 text-xs text-slate-400">
            Format: <code>provider/model</code> (e.g. <code>copilot/gpt-5.5</code>,{" "}
            <code>copilot/claude-opus-4.8</code>, <code>openai/gpt-4o</code>).
          </p>
        </div>

        {!data && <p className="text-sm text-slate-400">Loading…</p>}
        {data && Object.keys(drafts).length === 0 && (
          <p className="mb-4 text-sm text-slate-400">
            No providers configured yet. Click <em>Add provider</em> below to wire one.
          </p>
        )}

        <div className="space-y-4">
          {Object.entries(drafts).map(([key, draft]) => {
            const info = data?.providers?.[key];
            const hint = rowKindHint(draft.kind);
            const isNew = !info;
            return (
              <div key={key} className="rounded-md border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <span className="font-mono text-sm font-semibold">{key}</span>
                    <span className="ml-2 text-xs text-slate-400">kind: {draft.kind}</span>
                    {isNew && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                        new (not yet saved)
                      </span>
                    )}
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      info?.key === "set"
                        ? "bg-green-100 text-green-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    key {info?.key ?? "missing"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-500">
                      API key {info?.key === "set" && "(leave blank to keep)"}
                    </label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={draft.apiKey}
                      onChange={(e) => updateField(key, "apiKey", e.target.value)}
                      placeholder="••••••••"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-500">Default model</label>
                    <input
                      value={draft.model}
                      onChange={(e) => updateField(key, "model", e.target.value)}
                      placeholder="model id"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500"
                    />
                  </div>
                  {hint.includes("endpoint") && (
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">Endpoint</label>
                      <input
                        value={draft.endpoint}
                        onChange={(e) => updateField(key, "endpoint", e.target.value)}
                        placeholder="https://….openai.azure.com"
                        className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500"
                      />
                    </div>
                  )}
                  {hint.includes("deployment") && (
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">Deployment</label>
                      <input
                        value={draft.deployment}
                        onChange={(e) => updateField(key, "deployment", e.target.value)}
                        placeholder="gpt55"
                        className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500"
                      />
                    </div>
                  )}
                  {hint.includes("apiVersion") && (
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">API version</label>
                      <input
                        value={draft.apiVersion}
                        onChange={(e) => updateField(key, "apiVersion", e.target.value)}
                        placeholder="2024-12-01-preview"
                        className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500"
                      />
                    </div>
                  )}
                  {hint.includes("baseUrl") && (
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">Base URL</label>
                      <input
                        value={draft.baseUrl}
                        onChange={(e) => updateField(key, "baseUrl", e.target.value)}
                        placeholder={
                          draft.kind === "ollama"
                            ? "http://localhost:11434"
                            : "https://api.openai.com/v1"
                        }
                        className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500"
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 rounded-md border border-dashed border-slate-300 bg-white p-4">
          {adding ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-slate-500">Provider key</label>
                <input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="e.g. azure-eastus2"
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">Kind</label>
                <select
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value)}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
                >
                  {VALID_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <button
                onClick={addProviderRow}
                disabled={!newKey.trim()}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Add
              </button>
              <button
                onClick={() => {
                  setAdding(false);
                  setNewKey("");
                }}
                className="text-xs text-slate-500 underline hover:text-slate-700"
              >
                cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="text-sm font-medium text-slate-700 hover:underline"
            >
              + Add provider
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
