/**
 * GoalAutonomyCard — per-scope persistent defaults for goal-loop
 * behaviour (v0.17 mathub parity W11).
 *
 * Renders a compact, collapsible card above the goal status panel that
 * lets the user pin:
 *
 *   • `autonomyLevel`      — manual / conservative / balanced / aggressive
 *   • `defaultMaxRounds`   — the round cap used when no maxRounds is given
 *   • `defaultTokensCap?`  — optional total-token fallback
 *   • `enabled`            — gate for any auto-promote flow
 *   • `summaryGranularity` + `summaryIntervalMs` — forward-compat fields
 *                             the runner doesn't consume yet but the UI
 *                             can already capture so we don't have to
 *                             ship another migration for them.
 *
 * The card always edits ONE layer at a time (`project` or `global`)
 * picked via a small radio at the top. Each row shows:
 *
 *   • the current value as edited
 *   • a tiny badge telling the user which layer the EFFECTIVE value
 *     actually comes from right now (project / global / default) so it
 *     is unambiguous what wins
 *   • a "clear" affordance for the editing layer when the layer has its
 *     own value (sends `undefined` so the field is removed from that
 *     layer and falls through to the next)
 *
 * Writes are debounced (commit-on-blur for numeric/text inputs, eager
 * for radio / select) and surface a small saving / saved indicator.
 *
 * The card is intentionally optional — it only renders when the parent
 * ChatPanel passes `goalAutonomyEnabled` (gated by feature flag); the
 * load itself is a single GET on mount, so an absent card costs nothing.
 */

import { useCallback, useEffect, useState } from "react";
import type { ChatScopeSpec } from "../lib/api.ts";
import {
  AUTONOMY_LEVEL_HINT,
  AUTONOMY_LEVEL_LABEL,
  type AutonomyLevel,
  type GoalAutonomyConfig,
  type GoalAutonomyLayer,
  type GoalAutonomyResponse,
  type StoredGoalAutonomyLayer,
  type SummaryGranularity,
  deleteGoalAutonomyLayer as apiDelete,
  fetchGoalAutonomy as apiFetch,
  patchGoalAutonomy as apiPatch,
} from "../lib/goal-autonomy.ts";

const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  "manual",
  "conservative",
  "balanced",
  "aggressive",
] as const;

const GRANULARITIES: readonly SummaryGranularity[] = [
  "realtime",
  "hourly",
  "daily",
] as const;

const MIN_SUMMARY_INTERVAL_MS = 60_000;

interface Props {
  scope: ChatScopeSpec;
  /** Default collapsed; controlled if provided. */
  initiallyOpen?: boolean;
}

/** Decide which layer the effective value came from, per-field. */
function fieldSource(
  field: keyof GoalAutonomyConfig,
  project: StoredGoalAutonomyLayer | null,
  global: StoredGoalAutonomyLayer | null,
): "project" | "global" | "default" {
  if (project && field in project) return "project";
  if (global && field in global) return "global";
  return "default";
}

function SourceBadge({ source }: { source: "project" | "global" | "default" }) {
  const cls =
    source === "project"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : source === "global"
        ? "border-sky-200 bg-sky-50 text-sky-700"
        : "border-slate-200 bg-slate-50 text-slate-500";
  return (
    <span
      className={`rounded border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wide ${cls}`}
      title={`Effective value comes from the ${source} layer`}
    >
      {source}
    </span>
  );
}

export function GoalAutonomyCard({ scope, initiallyOpen = false }: Props) {
  const [open, setOpen] = useState(initiallyOpen);
  const [data, setData] = useState<GoalAutonomyResponse | null>(null);
  const [editLayer, setEditLayer] = useState<GoalAutonomyLayer>("project");
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "saving" }
    | { kind: "saved"; at: number }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const r = await apiFetch(scope);
      setData(r);
      setStatus({ kind: "idle" });
    } catch (err: any) {
      setStatus({ kind: "error", msg: err?.message ?? String(err) });
    }
  }, [scope]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const patch = useCallback(
    async (p: Partial<GoalAutonomyConfig>) => {
      setStatus({ kind: "saving" });
      try {
        const r = await apiPatch(scope, editLayer, p);
        setData(r);
        setStatus({ kind: "saved", at: Date.now() });
      } catch (err: any) {
        setStatus({ kind: "error", msg: err?.message ?? String(err) });
      }
    },
    [scope, editLayer],
  );

  const clearField = useCallback(
    async (field: keyof GoalAutonomyConfig) => {
      // Send `undefined` — the server treats it as "remove this key from
      // the layer", so the effective value falls through to the next
      // layer.
      await patch({ [field]: undefined } as Partial<GoalAutonomyConfig>);
    },
    [patch],
  );

  const resetLayer = useCallback(async () => {
    setStatus({ kind: "saving" });
    try {
      const r = await apiDelete(scope, editLayer);
      setData(r);
      setStatus({ kind: "saved", at: Date.now() });
    } catch (err: any) {
      setStatus({ kind: "error", msg: err?.message ?? String(err) });
    }
  }, [scope, editLayer]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-100"
        title="Configure default goal-loop behaviour for this scope"
      >
        <span className="font-medium">Goal autonomy</span>
        <span className="ml-2 text-slate-400">click to expand…</span>
      </button>
    );
  }

  const eff = data?.effective ?? null;
  const project = data?.project ?? null;
  const global = data?.global ?? null;
  const editing = editLayer === "project" ? project : global;

  return (
    <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">Goal autonomy</span>
        <span className="text-slate-400">·</span>
        <span className="text-slate-500">editing:</span>
        <label className="flex items-center gap-1 text-slate-700">
          <input
            type="radio"
            name="goal-autonomy-layer"
            checked={editLayer === "project"}
            onChange={() => setEditLayer("project")}
            className="h-3 w-3"
          />
          project
        </label>
        <label className="flex items-center gap-1 text-slate-700">
          <input
            type="radio"
            name="goal-autonomy-layer"
            checked={editLayer === "global"}
            onChange={() => setEditLayer("global")}
            className="h-3 w-3"
          />
          global
        </label>
        <div className="ml-auto flex items-center gap-2">
          <StatusPill status={status} />
          <button
            type="button"
            onClick={() => void resetLayer()}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-600 hover:bg-slate-50"
            title={`Delete the ${editLayer} layer file so every field falls back`}
            disabled={!editing}
          >
            reset {editLayer}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-600 hover:bg-slate-50"
            aria-label="Collapse goal autonomy card"
          >
            ×
          </button>
        </div>
      </div>

      {data === null ? (
        <div className="mt-2 text-slate-500">
          {status.kind === "error" ? `Error: ${status.msg}` : "Loading…"}
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {/* enabled */}
          <label className="flex items-center gap-2 text-slate-700">
            <input
              type="checkbox"
              checked={
                editing && "enabled" in editing
                  ? Boolean(editing.enabled)
                  : Boolean(eff?.enabled)
              }
              onChange={(e) => void patch({ enabled: e.target.checked })}
              className="h-3 w-3"
            />
            <span className="font-medium">Enabled</span>
            <SourceBadge source={fieldSource("enabled", project, global)} />
            <ClearButton
              visible={Boolean(editing && "enabled" in editing)}
              onClick={() => void clearField("enabled")}
            />
          </label>

          {/* autonomyLevel */}
          <label className="flex items-center gap-2 text-slate-700">
            <span className="font-medium">Autonomy</span>
            <select
              value={
                editing && "autonomyLevel" in editing
                  ? editing.autonomyLevel
                  : (eff?.autonomyLevel ?? "balanced")
              }
              onChange={(e) =>
                void patch({ autonomyLevel: e.target.value as AutonomyLevel })
              }
              className="rounded border border-slate-300 px-1 py-0.5 text-xs focus:border-amber-500 focus:outline-none"
            >
              {AUTONOMY_LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  {AUTONOMY_LEVEL_LABEL[lv]}
                </option>
              ))}
            </select>
            <SourceBadge
              source={fieldSource("autonomyLevel", project, global)}
            />
            <ClearButton
              visible={Boolean(editing && "autonomyLevel" in editing)}
              onClick={() => void clearField("autonomyLevel")}
            />
          </label>

          {/* defaultMaxRounds */}
          <label className="flex items-center gap-2 text-slate-700">
            <span className="font-medium">Default max rounds</span>
            <input
              type="number"
              min={1}
              defaultValue={
                editing && "defaultMaxRounds" in editing
                  ? editing.defaultMaxRounds
                  : (eff?.defaultMaxRounds ?? 200)
              }
              key={`maxr-${editLayer}-${editing?.updatedAt ?? 0}`}
              onBlur={(e) => {
                const n = Number(e.currentTarget.value);
                if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
                  void patch({ defaultMaxRounds: n });
                }
              }}
              className="w-16 rounded border border-slate-300 px-1 py-0.5 text-xs focus:border-amber-500 focus:outline-none"
            />
            <SourceBadge
              source={fieldSource("defaultMaxRounds", project, global)}
            />
            <ClearButton
              visible={Boolean(editing && "defaultMaxRounds" in editing)}
              onClick={() => void clearField("defaultMaxRounds")}
            />
          </label>

          {/* defaultTokensCap (optional) */}
          <label className="flex items-center gap-2 text-slate-700">
            <span className="font-medium">Default tokens cap</span>
            <input
              type="number"
              min={1}
              defaultValue={
                editing && "defaultTokensCap" in editing
                  ? editing.defaultTokensCap
                  : (eff?.defaultTokensCap ?? "")
              }
              placeholder="—"
              key={`tok-${editLayer}-${editing?.updatedAt ?? 0}`}
              onBlur={(e) => {
                const txt = e.currentTarget.value.trim();
                if (txt === "") {
                  // Empty = clear the field on the editing layer.
                  void clearField("defaultTokensCap");
                  return;
                }
                const n = Number(txt);
                if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
                  void patch({ defaultTokensCap: n });
                }
              }}
              className="w-24 rounded border border-slate-300 px-1 py-0.5 text-xs focus:border-amber-500 focus:outline-none"
            />
            <SourceBadge
              source={fieldSource("defaultTokensCap", project, global)}
            />
          </label>

          {/* summary granularity */}
          <label className="flex items-center gap-2 text-slate-700">
            <span className="font-medium">Summary granularity</span>
            <select
              value={
                editing && "summaryGranularity" in editing
                  ? editing.summaryGranularity
                  : (eff?.summaryGranularity ?? "realtime")
              }
              onChange={(e) =>
                void patch({
                  summaryGranularity: e.target.value as SummaryGranularity,
                })
              }
              className="rounded border border-slate-300 px-1 py-0.5 text-xs focus:border-amber-500 focus:outline-none"
            >
              {GRANULARITIES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <SourceBadge
              source={fieldSource("summaryGranularity", project, global)}
            />
            <ClearButton
              visible={Boolean(editing && "summaryGranularity" in editing)}
              onClick={() => void clearField("summaryGranularity")}
            />
          </label>

          {/* summary interval (in minutes — server takes ms) */}
          <label className="flex items-center gap-2 text-slate-700">
            <span className="font-medium">Summary interval</span>
            <input
              type="number"
              min={1}
              defaultValue={Math.max(
                1,
                Math.round(
                  ((editing && "summaryIntervalMs" in editing
                    ? editing.summaryIntervalMs
                    : (eff?.summaryIntervalMs ?? 30 * 60 * 1000)) ??
                    30 * 60 * 1000) / 60_000,
                ),
              )}
              key={`int-${editLayer}-${editing?.updatedAt ?? 0}`}
              onBlur={(e) => {
                const mins = Number(e.currentTarget.value);
                if (Number.isFinite(mins) && mins >= 1) {
                  void patch({
                    summaryIntervalMs: Math.max(
                      MIN_SUMMARY_INTERVAL_MS,
                      Math.round(mins) * 60_000,
                    ),
                  });
                }
              }}
              className="w-16 rounded border border-slate-300 px-1 py-0.5 text-xs focus:border-amber-500 focus:outline-none"
            />
            <span className="text-slate-500">min</span>
            <SourceBadge
              source={fieldSource("summaryIntervalMs", project, global)}
            />
            <ClearButton
              visible={Boolean(editing && "summaryIntervalMs" in editing)}
              onClick={() => void clearField("summaryIntervalMs")}
            />
          </label>
        </div>
      )}

      {eff && (
        <div className="mt-2 text-[11px] text-slate-500">
          <span className="font-medium">Effective:</span> {AUTONOMY_LEVEL_LABEL[eff.autonomyLevel]}
          {" · "}
          {eff.defaultMaxRounds} rounds
          {typeof eff.defaultTokensCap === "number" && eff.defaultTokensCap > 0
            ? ` · ${eff.defaultTokensCap.toLocaleString()} tokens`
            : ""}
          {" · "}
          <span className="italic">{AUTONOMY_LEVEL_HINT[eff.autonomyLevel]}</span>
        </div>
      )}
    </div>
  );
}

/** Tiny inline "x" to clear a single layer field. */
function ClearButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-slate-400 hover:text-slate-700"
      title="Clear this field on the editing layer"
      aria-label="Clear field"
    >
      ×
    </button>
  );
}

function StatusPill({
  status,
}: {
  status:
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "saving" }
    | { kind: "saved"; at: number }
    | { kind: "error"; msg: string };
}) {
  if (status.kind === "idle") return null;
  if (status.kind === "loading")
    return <span className="text-slate-500">loading…</span>;
  if (status.kind === "saving")
    return <span className="text-slate-500">saving…</span>;
  if (status.kind === "saved")
    return <span className="text-emerald-700">saved</span>;
  return (
    <span className="text-rose-700" title={status.msg}>
      error
    </span>
  );
}

export default GoalAutonomyCard;
