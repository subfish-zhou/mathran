/**
 * Plan-mode SPA client (v0.16 §9 audit #2).
 *
 * Wraps the small REST surface exposed by `src/server/serve.ts`:
 *
 *   POST   /api/plans                  → `{ planId }` (202)
 *   GET    /api/plans/:planId/stream   → SSE: token / step / done / error
 *   GET    /api/plans/:planId          → `{ plan }` snapshot
 *   POST   /api/plans/:planId/accept   → `{ ok, location, plan }`
 *   POST   /api/plans/:planId/reject   → `{ ok, plan }`
 *
 * Kept tiny and dependency-free so PlanRunOverlay stays a thin shell over
 * these calls + the same `parseSSE` shape used by chat.
 */

export interface PlanRecord {
  id: string;
  objective: string;
  model: string;
  status: "draft" | "accepted" | "rejected";
  body: string;
  createdAt: string;
  updatedAt: string;
  acceptedEffortId: string | null;
}

export type PlanStreamEvent =
  | { type: "token"; delta: string }
  | { type: "step"; round: number; finishReason: string }
  | { type: "done"; planId: string; body: string; turns: number; truncated: boolean; aborted: boolean }
  | { type: "error"; message: string };

/** POST /api/plans → returns the planId so the caller can open /stream. */
export async function createPlanRun(opts: {
  objective: string;
  model?: string;
}): Promise<{ planId: string }> {
  const res = await fetch(`/api/plans`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      objective: opts.objective,
      ...(opts.model ? { model: opts.model } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`create plan failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as { planId: string };
}

/**
 * Open the plan SSE stream and yield typed events. Mirrors the loose
 * `parseSSE` reader that chat.ts uses — we keep these inline rather than
 * sharing a helper because the two endpoints emit slightly different
 * envelopes (chat: anonymous JSON frames; plan: `event:`-tagged frames).
 */
export async function* streamPlan(
  planId: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<PlanStreamEvent> {
  const init: RequestInit = {};
  if (opts.signal) init.signal = opts.signal;
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/stream`, init);
  if (!res.ok || !res.body) {
    throw new Error(`stream plan failed: HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        let payload: any;
        try {
          payload = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }
        switch (event) {
          case "token":
            yield { type: "token", delta: String(payload.delta ?? "") };
            break;
          case "step":
            yield {
              type: "step",
              round: Number(payload.round ?? 0),
              finishReason: String(payload.finishReason ?? "stop"),
            };
            break;
          case "done":
            yield {
              type: "done",
              planId: String(payload.planId ?? planId),
              body: String(payload.body ?? ""),
              turns: Number(payload.turns ?? 0),
              truncated: Boolean(payload.truncated),
              aborted: Boolean(payload.aborted),
            };
            break;
          case "error":
            yield { type: "error", message: String(payload.message ?? "unknown error") };
            break;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

export async function getPlan(planId: string): Promise<PlanRecord> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}`);
  if (!res.ok) throw new Error(`get plan failed: HTTP ${res.status}`);
  const json = (await res.json()) as { plan: PlanRecord };
  return json.plan;
}

export async function acceptPlan(
  planId: string,
): Promise<{ ok: boolean; location: string; plan: PlanRecord }> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/accept`, {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`accept plan failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as { ok: boolean; location: string; plan: PlanRecord };
}

export async function rejectPlan(
  planId: string,
): Promise<{ ok: boolean; plan: PlanRecord }> {
  const res = await fetch(`/api/plans/${encodeURIComponent(planId)}/reject`, {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`reject plan failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as { ok: boolean; plan: PlanRecord };
}
