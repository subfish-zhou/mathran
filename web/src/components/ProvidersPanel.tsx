import { useEffect, useState } from "react";
import { api, type ProvidersResponse } from "../lib/api.ts";

interface DraftRow {
  apiKey: string;
  model: string;
}

export default function ProvidersPanel() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [defaultModel, setDefaultModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const res = await api.getProviders();
      setData(res);
      setDefaultModel(res.defaultModel ?? "");
      const init: Record<string, DraftRow> = {};
      for (const [k, v] of Object.entries(res.providers)) {
        init[k] = { apiKey: "", model: v.model ?? "" };
      }
      setDrafts(init);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function save() {
    if (!data) return;
    setError(null);
    setStatus("Saving…");
    const providers: Record<string, Record<string, unknown>> = {};
    for (const [key, draft] of Object.entries(drafts)) {
      const entry: Record<string, unknown> = {};
      // Only send a key when the user typed one — never echo stored secrets.
      if (draft.apiKey.trim()) entry.apiKey = draft.apiKey.trim();
      if (draft.model.trim()) entry.defaultModel = draft.model.trim();
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

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
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
          <input
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            placeholder="copilot/gpt-5.5"
            className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500"
          />
        </div>

        {!data && <p className="text-sm text-slate-400">Loading…</p>}
        {data && Object.keys(data.providers).length === 0 && (
          <p className="text-sm text-slate-400">No providers configured in config.toml.</p>
        )}

        <div className="space-y-4">
          {data &&
            Object.entries(data.providers).map(([key, info]) => (
              <div key={key} className="rounded-md border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <span className="font-mono text-sm font-semibold">{key}</span>
                    <span className="ml-2 text-xs text-slate-400">kind: {info.kind}</span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      info.key === "set"
                        ? "bg-green-100 text-green-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    key {info.key}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs text-slate-500">
                      API key {info.key === "set" && "(leave blank to keep)"}
                    </label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={drafts[key]?.apiKey ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [key]: { ...d[key], apiKey: e.target.value },
                        }))
                      }
                      placeholder="••••••••"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-slate-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-500">Default model</label>
                    <input
                      value={drafts[key]?.model ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({
                          ...d,
                          [key]: { ...d[key], model: e.target.value },
                        }))
                      }
                      placeholder="model id"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm outline-none focus:border-slate-500"
                    />
                  </div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
