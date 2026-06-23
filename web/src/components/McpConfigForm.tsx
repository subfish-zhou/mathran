/**
 * McpConfigForm (MCP v1.5 #5) — edit `.mathran/mcp.json` from the SPA.
 *
 * Lists the configured servers as editable rows (add / edit / delete), a
 * per-row "Test" button that try-connects without saving, and a single "Save"
 * that PUTs the whole array. The host re-validates every entry with zod, so a
 * bad config is rejected with inline `details` rather than corrupting the file.
 *
 * Secrets: env values arrive masked (`***`) and are sent back as-is to keep the
 * stored secret — the browser never sees plaintext.
 */

import { useCallback, useEffect, useState } from "react";

import {
  getMcpConfig,
  putMcpConfig,
  testMcpConnection,
  type McpServerConfigInput,
  type McpTestResult,
} from "../lib/mcp.ts";

function emptyServer(): McpServerConfigInput {
  return { name: "", transport: "stdio", command: "" };
}

export default function McpConfigForm(): JSX.Element {
  const [servers, setServers] = useState<McpServerConfigInput[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState<Record<number, McpTestResult | "running">>({});

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        const cfg = await getMcpConfig(ctrl.signal);
        setServers(cfg.servers);
      } catch {
        /* leave empty; the file may not exist yet */
      } finally {
        setLoaded(true);
      }
    })();
    return () => ctrl.abort();
  }, []);

  const patch = useCallback(
    (i: number, key: keyof McpServerConfigInput, value: unknown) => {
      setSaved(false);
      setServers((prev) => prev.map((s, j) => (j === i ? { ...s, [key]: value } : s)));
    },
    [],
  );

  const addRow = useCallback(() => {
    setSaved(false);
    setServers((prev) => [...prev, emptyServer()]);
  }, []);

  const removeRow = useCallback((i: number) => {
    setSaved(false);
    setServers((prev) => prev.filter((_, j) => j !== i));
  }, []);

  const onTest = useCallback(
    async (i: number) => {
      const server = servers[i];
      if (!server) return;
      setTests((p) => ({ ...p, [i]: "running" }));
      const result = await testMcpConnection(server);
      setTests((p) => ({ ...p, [i]: result }));
    },
    [servers],
  );

  const onSave = useCallback(async () => {
    setSaving(true);
    setErrors([]);
    setSaved(false);
    const res = await putMcpConfig(servers);
    setSaving(false);
    if (res.ok) {
      setSaved(true);
    } else {
      setErrors(res.details ?? [res.error ?? "save failed"]);
    }
  }, [servers]);

  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="mcp-config-form">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">MCP configuration</h1>
          <p className="text-xs text-slate-500">
            Edit{" "}
            <code className="rounded bg-slate-100 px-1">.mathran/mcp.json</code>. Secrets
            are masked — leave <code className="rounded bg-slate-100 px-1">***</code> to keep
            the stored value.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={addRow}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            + Add server
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={saving}
            className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {errors.length > 0 && (
        <ul className="mb-4 space-y-1 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
          {errors.map((e, i) => (
            <li key={i}>✕ {e}</li>
          ))}
        </ul>
      )}
      {saved && (
        <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          ✓ Saved — servers reloaded.
        </div>
      )}

      {loaded && servers.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
          No servers yet. Click <strong>+ Add server</strong> to create one.
        </div>
      ) : (
        <ul className="space-y-3">
          {servers.map((s, i) => {
            const isHttp = s.transport === "http";
            const test = tests[i];
            return (
              <li
                key={i}
                className="rounded-md border border-slate-200 bg-white p-3 text-sm"
                data-testid="mcp-config-row"
              >
                <div className="flex items-center gap-2">
                  <input
                    aria-label={`name-${i}`}
                    value={s.name}
                    placeholder="name"
                    onChange={(e) => patch(i, "name", e.target.value)}
                    className="w-40 rounded border border-slate-200 px-2 py-1 text-xs"
                  />
                  <select
                    aria-label={`transport-${i}`}
                    value={s.transport ?? "stdio"}
                    onChange={(e) => patch(i, "transport", e.target.value)}
                    className="rounded border border-slate-200 px-2 py-1 text-xs"
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                  </select>
                  <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
                    <input
                      type="checkbox"
                      aria-label={`disabled-${i}`}
                      checked={Boolean(s.disabled)}
                      onChange={(e) => patch(i, "disabled", e.target.checked)}
                    />
                    disabled
                  </label>
                  <button
                    type="button"
                    onClick={() => void onTest(i)}
                    className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
                  >
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    aria-label={`remove-${i}`}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-50"
                  >
                    ✕
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                  {isHttp ? (
                    <>
                      <input
                        aria-label={`url-${i}`}
                        value={s.url ?? ""}
                        placeholder="https://host/sse"
                        onChange={(e) => patch(i, "url", e.target.value)}
                        className="w-72 rounded border border-slate-200 px-2 py-1 font-mono text-xs"
                      />
                      <input
                        aria-label={`token-${i}`}
                        value={s.token ?? ""}
                        placeholder="auth token"
                        onChange={(e) => patch(i, "token", e.target.value)}
                        className="w-48 rounded border border-slate-200 px-2 py-1 font-mono text-xs"
                      />
                    </>
                  ) : (
                    <>
                      <input
                        aria-label={`command-${i}`}
                        value={s.command ?? ""}
                        placeholder="command (e.g. npx)"
                        onChange={(e) => patch(i, "command", e.target.value)}
                        className="w-48 rounded border border-slate-200 px-2 py-1 font-mono text-xs"
                      />
                      <input
                        aria-label={`args-${i}`}
                        value={(s.args ?? []).join(" ")}
                        placeholder="args (space-separated)"
                        onChange={(e) =>
                          patch(
                            i,
                            "args",
                            e.target.value.trim() === ""
                              ? []
                              : e.target.value.split(/\s+/),
                          )
                        }
                        className="w-72 rounded border border-slate-200 px-2 py-1 font-mono text-xs"
                      />
                    </>
                  )}
                </div>

                {test && (
                  <div
                    className={`mt-2 text-xs ${
                      test === "running"
                        ? "text-slate-400"
                        : test.ok
                          ? "text-emerald-600"
                          : "text-red-500"
                    }`}
                  >
                    {test === "running"
                      ? "Testing…"
                      : test.ok
                        ? `✓ connected — ${test.toolCount ?? 0} tools, ${test.promptCount ?? 0} prompts, ${test.resourceCount ?? 0} resources`
                        : `✕ ${test.error ?? "connection failed"}`}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
