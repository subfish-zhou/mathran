/**
 * McpServersPanel (MCP client v1, read-only).
 *
 * Lists the configured Model Context Protocol servers and their live status:
 *
 *   <status-dot> <name>            <tool count>  <↻ reload>
 *   command: …                     [lastError if disconnected/disabled]
 *
 * Data flow:
 *   - Loads `GET /api/mcp/servers` on mount and polls every {@link POLL_MS} so a
 *     server that crashes/recovers in the background reflects without a refresh.
 *   - `↻` POSTs `…/reload` — the only mutation in v1 (no config editing). A
 *     `disabled` server (retries exhausted) gets a fresh connect attempt this way.
 *
 * Pure logic (status colour) lives in `../lib/mcp.ts` and is unit-tested there.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  MCP_STATUS_DOT,
  getMcpServers,
  reloadMcpServer,
  type McpServerRow,
} from "../lib/mcp.ts";

const POLL_MS = 5000;

export default function McpServersPanel(): JSX.Element {
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const reloadingAll = busy === "*";

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await getMcpServers(signal);
      setServers(res.servers);
      setWarnings(res.warnings);
      setLoaded(true);
    } catch {
      /* transient — keep the last good list */
    }
  }, []);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    const timer = setInterval(() => void refreshRef.current(ctrl.signal), POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  const onReload = useCallback(
    async (name: string) => {
      setBusy(name);
      await reloadMcpServer(name);
      await refresh();
      setBusy(null);
    },
    [refresh],
  );

  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="mcp-servers-panel">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">MCP servers</h1>
          <p className="text-xs text-slate-500">
            Model Context Protocol servers connected over stdio. Configure them in{" "}
            <code className="rounded bg-slate-100 px-1">.mathran/mcp.json</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onReload("all")}
          disabled={reloadingAll}
          className="shrink-0 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {reloadingAll ? "Reloading…" : "↻ Reload all"}
        </button>
      </div>

      {warnings.length > 0 && (
        <ul className="mb-4 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {loaded && servers.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
          No MCP servers configured. Add one to{" "}
          <code className="rounded bg-slate-100 px-1">.mathran/mcp.json</code>.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {servers.map((s) => {
            const dot = MCP_STATUS_DOT[s.status];
            const isBusy = busy === s.name;
            return (
              <li key={s.name} className="px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot.className}`}
                    title={dot.label}
                    aria-label={dot.label}
                  />
                  <span className="font-medium text-slate-700">{s.name}</span>
                  <span className="text-xs text-slate-400">({dot.label})</span>
                  <span className="ml-auto shrink-0 tabular-nums text-xs text-slate-400">
                    {s.toolCount} {s.toolCount === 1 ? "tool" : "tools"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void onReload(s.name)}
                    disabled={isBusy}
                    className="shrink-0 rounded px-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                    title="Reload"
                    aria-label={`Reload ${s.name}`}
                  >
                    {isBusy ? "…" : "↻"}
                  </button>
                </div>
                <div className="mt-1 pl-4 font-mono text-xs text-slate-400">
                  {s.command}
                </div>
                {s.lastError && (
                  <div className="mt-1 pl-4 text-xs text-red-500">
                    {s.lastError}
                    {s.status === "disabled" &&
                      ` (disabled after ${s.retries} retries — reload to retry)`}
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
