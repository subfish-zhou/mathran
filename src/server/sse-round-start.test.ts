/**
 * v0.17 mathub parity W7 — server-side contract test for the
 * `round-start` SSE frame.
 *
 * The streaming variant of the goal-run endpoint
 * (`POST /api/goals/:id/run/stream`) emits exactly one `round-start`
 * frame at the top of every round, BEFORE any model tokens arrive. This
 * is the wire-protocol contract the SPA's `AgentStatusPanel` relies on
 * to render `🔄 Step N/MAX · ⏱ Xs` as soon as the round begins.
 *
 * Design notes:
 *   - We drive a real Hono server on an ephemeral port (matching
 *     `serve.test.ts` patterns).
 *   - We inject a fake LLM via `goalLlmFactory` so no real provider is
 *     contacted; the fake emits one token plus a `done` chunk per round.
 *   - We disable the bootstrap-plan stage at the request boundary by
 *     creating goals with a model that has no plan tooling configured —
 *     the stream endpoint still hard-codes `bootstrapPlan: "auto"` in
 *     production, but the fake LLM will simply re-stream the same canned
 *     reply for the bootstrap call, so we tolerate either 1 or 2 SSE
 *     "round-start"-like surfaces depending on whether the bootstrap
 *     opens a separate stream (it does not — `runPlan` happens before
 *     `runGoalRound` opens any ChatSession, so only one `round-start` is
 *     observed per `/run/stream` request).
 *   - For the multi-round assertion we issue N back-to-back
 *     `/run/stream` requests and assert the cumulative count of
 *     `round-start` frames equals N, with the `round` field on each
 *     frame monotonically increasing as `goal.stats.roundsRun + 1`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer } from "./serve.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../core/providers/llm.js";

/**
 * Fake LLM that emits a fixed reply per call. Calls counter is exposed
 * via closure so a test can verify how many model invocations happen.
 */
function scriptedLlm(reply: string): LLMProvider {
  return {
    async describe() {
      return { name: "fake-round-start" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "text", delta: reply };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

/** Read an SSE response body into a `{event, data}[]` list. */
async function drainSSE(res: Response): Promise<Array<{ event: string; data: any }>> {
  expect(res.body).toBeTruthy();
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Array<{ event: string; data: any }> = [];
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
      try {
        out.push({ event, data: JSON.parse(dataLines.join("\n")) });
      } catch {
        /* ignore unparseable trailing frame */
      }
    }
  }
  return out;
}

let workspace: string;
let server: { url: string; close: () => Promise<void> };
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-sse-roundstart-"));
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    goalLlmFactory: () => scriptedLlm("ok\nDONE: round complete"),
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

// We re-create a fresh goal per test so round counters always start at 1.
let goalId: string;
beforeEach(async () => {
  const res = await fetch(`${base}/api/goals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      objective: "Test the round-start frame.",
      // Cap rounds explicitly so we can assert `maxRounds` is forwarded
      // verbatim onto the SSE frame. The HTTP API field is `maxRounds`;
      // it lands on the goal record as `budget.roundsMax`.
      maxRounds: 4,
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  goalId = body.goal.id;
});

describe("POST /api/goals/:id/run/stream — round-start SSE contract (W7)", () => {
  it("emits exactly one `round-start` frame per request, with round=N+1 and maxRounds forwarded", async () => {
    const res = await fetch(`${base}/api/goals/${goalId}/run/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "kick off round 1" }),
    });
    expect(res.status).toBe(200);

    const frames = await drainSSE(res);
    const roundStarts = frames.filter((f) => f.event === "round-start");

    // Exactly one round-start per /run/stream invocation (one round per
    // request — the bootstrap-plan stage happens BEFORE the ChatSession
    // is opened, so it does not surface as its own round-start frame).
    expect(roundStarts.length).toBe(1);
    expect(roundStarts[0]!.data).toMatchObject({
      type: "round-start",
      round: 1,
      maxRounds: 4,
    });

    // round-start lands BEFORE the first token (contract: the SPA wants
    // "Step N/MAX" visible as soon as the round begins, not after the
    // first assistant text chunk).
    const firstRoundStartIdx = frames.findIndex((f) => f.event === "round-start");
    const firstTextIdx = frames.findIndex((f) => f.event === "text");
    expect(firstRoundStartIdx).toBeGreaterThanOrEqual(0);
    if (firstTextIdx !== -1) {
      expect(firstRoundStartIdx).toBeLessThan(firstTextIdx);
    }

    // The stream ends with a `result` frame carrying the same JSON
    // envelope the legacy `/run` endpoint returns.
    const last = frames[frames.length - 1]!;
    expect(last.event).toBe("result");
    expect(last.data.goal).toBeTruthy();
    expect(last.data.goal.id).toBe(goalId);
  });

  it("multi-round run: N requests produce N round-start frames with monotonically increasing `round`", async () => {
    const N = 3;
    const allRoundStarts: Array<{ event: string; data: any }> = [];

    for (let i = 0; i < N; i++) {
      const res = await fetch(`${base}/api/goals/${goalId}/run/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `kick off round ${i + 1}` }),
      });
      expect(res.status).toBe(200);
      const frames = await drainSSE(res);
      const roundStarts = frames.filter((f) => f.event === "round-start");
      expect(roundStarts.length).toBe(1);
      allRoundStarts.push(...roundStarts);
    }

    // We saw exactly N round-start frames across the N requests.
    expect(allRoundStarts.length).toBe(N);

    // Each frame's `round` field equals its 1-indexed position — the
    // runner sources this from `goal.stats.roundsRun + 1`, which the
    // store increments after each completed round.
    for (let i = 0; i < N; i++) {
      expect(allRoundStarts[i]!.data).toMatchObject({
        type: "round-start",
        round: i + 1,
        maxRounds: 4,
      });
    }
  });

  it("emits `round-start` even when the goal has no roundsMax cap (omits `maxRounds`)", async () => {
    // Fresh goal without `roundsMax` — the SSE frame should omit
    // `maxRounds` (or set it to undefined / null) rather than fabricate
    // a cap.
    const created = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "uncapped goal" }),
    });
    const { goal } = await created.json();
    expect(goal.id).toBeTruthy();

    const res = await fetch(`${base}/api/goals/${goal.id}/run/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const frames = await drainSSE(res);
    const roundStarts = frames.filter((f) => f.event === "round-start");
    expect(roundStarts.length).toBe(1);
    expect(roundStarts[0]!.data.type).toBe("round-start");
    expect(roundStarts[0]!.data.round).toBe(1);

    // When `roundsMax` is not set on the goal record, the SSE frame
    // should not carry a fabricated `maxRounds`. We accept either
    // `undefined` (key omitted by JSON.stringify) or `null` here, but
    // NOT a finite number.
    const max = roundStarts[0]!.data.maxRounds;
    expect(max === undefined || max === null).toBe(true);
  });
});
