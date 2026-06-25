/**
 * Hook to fetch the real list of copilot models from the backend.
 *
 * `GET /api/copilot/models` returns `{ source: "live" | "fallback", models: string[] }`.
 * The hook returns the raw list (sorted, no provider prefix) plus a
 * `source` flag the caller can use to surface "this is just our hardcoded
 * snapshot, not your actual Copilot subscription".
 *
 * Cached per-mount; not refetched unless the component remounts. Good
 * enough for a datalist — model availability only changes at Copilot
 * subscription boundaries.
 *
 * Why a separate hook (not inline in each picker): three components
 * (ChatPanel, SettingsPanel, ProvidersPanel) all want the same list, and
 * the prior hardcoded `<option>` blocks drifted between them.
 */

import { useEffect, useState } from "react";

export interface CopilotModelsResult {
  source: "live" | "fallback" | "loading" | "error";
  models: string[];
}

export function useCopilotModels(): CopilotModelsResult {
  const [state, setState] = useState<CopilotModelsResult>({
    source: "loading",
    models: [],
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/copilot/models");
        if (!res.ok) {
          if (!cancelled) setState({ source: "error", models: [] });
          return;
        }
        const data = (await res.json()) as { source?: string; models?: unknown };
        const models = Array.isArray(data.models)
          ? (data.models.filter((m): m is string => typeof m === "string"))
          : [];
        const source: CopilotModelsResult["source"] =
          data.source === "live" ? "live" : "fallback";
        if (!cancelled) setState({ source, models });
      } catch {
        if (!cancelled) setState({ source: "error", models: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

/**
 * Prepend the `copilot/` provider prefix to each bare model name so the
 * resulting strings drop straight into the ModelRouter input format.
 */
export function asCopilotModelStrings(models: string[]): string[] {
  return models.map((m) => `copilot/${m}`);
}
