/**
 * v0.17 mathub parity W11 — HTTP contract tests for the goal-autonomy
 * config endpoints (`/api/scopes/:scopeId/goal-autonomy`).
 *
 * Drives a real Hono server on an ephemeral port (matches the
 * `serve.test.ts` pattern). We override HOME via env so the "global"
 * layer writes into the per-test temp dir, not the real user home.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import { ChatSession } from "../core/chat/index.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../core/providers/llm.js";

function noopLlm(): LLMProvider {
  return {
    async describe() {
      return { name: "fake-autonomy" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

let workspace: string;
let fakeHome: string;
let prevHome: string | undefined;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-w11-ws-"));
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-w11-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  // smol-toml needs a valid config; an empty file works.
  await fs.writeFile(path.join(workspace, "config.toml"), "", "utf-8");
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    chatSessionFactory: ({ model }) =>
      new ChatSession({ llm: noopLlm(), model }),
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(fakeHome, { recursive: true, force: true });
});

beforeEach(async () => {
  // Reset both layers between tests.
  await fs.rm(path.join(workspace, ".mathran", "goal-autonomy.json"), { force: true });
  await fs.rm(path.join(fakeHome, ".mathran", "goal-autonomy.json"), { force: true });
});

describe("GET /api/scopes/:scopeId/goal-autonomy", () => {
  it("returns DEFAULT + null layers when nothing on disk", async () => {
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.global).toBeNull();
    expect(j.project).toBeNull();
    expect(j.effective.autonomyLevel).toBe("balanced");
    // goal-defaults-timer (commit 1/7) bumped these:
    //   defaultMaxRounds: 12  → 200
    //   defaultTokensCap: absent → 12_800_000
    expect(j.effective.defaultMaxRounds).toBe(200);
    expect(j.defaults.defaultMaxRounds).toBe(200);
    expect(j.effective.defaultTokensCap).toBe(12_800_000);
    expect(j.defaults.defaultTokensCap).toBe(12_800_000);
  });

  it("rejects an invalid scopeId with 400", async () => {
    const res = await fetch(`${base}/api/scopes/not~a~real~thing/goal-autonomy`);
    expect(res.status).toBe(400);
  });

  it("accepts scopeId = project~slug", async () => {
    const res = await fetch(`${base}/api/scopes/project~foo/goal-autonomy`);
    expect(res.status).toBe(200);
  });

  it("accepts scopeId = effort~slug~slug", async () => {
    const res = await fetch(`${base}/api/scopes/effort~foo~bar/goal-autonomy`);
    expect(res.status).toBe(200);
  });

  it("rejects scopeId containing traversal", async () => {
    const res = await fetch(`${base}/api/scopes/project~..~etc/goal-autonomy`);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/scopes/:scopeId/goal-autonomy", () => {
  it("writes the global layer and GET reflects it", async () => {
    const patch = { scope: "global", patch: { autonomyLevel: "aggressive", defaultMaxRounds: 25 } };
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.global?.autonomyLevel).toBe("aggressive");
    expect(j.global?.defaultMaxRounds).toBe(25);
    expect(j.effective.autonomyLevel).toBe("aggressive");

    // The file should land at the fake-HOME location.
    const txt = await fs.readFile(path.join(fakeHome, ".mathran", "goal-autonomy.json"), "utf-8");
    expect(JSON.parse(txt).autonomyLevel).toBe("aggressive");
  });

  it("project layer overrides global layer field-by-field", async () => {
    await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        patch: { autonomyLevel: "aggressive", defaultMaxRounds: 50 },
      }),
    });
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", patch: { autonomyLevel: "conservative" } }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.effective.autonomyLevel).toBe("conservative"); // project overrides
    expect(j.effective.defaultMaxRounds).toBe(50);          // inherited from global
  });

  it("rejects an invalid autonomyLevel with 400", async () => {
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", patch: { autonomyLevel: "yolo" } }),
    });
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toMatch(/autonomyLevel/);
  });

  it("rejects defaultMaxRounds < 1 with 400", async () => {
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", patch: { defaultMaxRounds: 0 } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects summaryIntervalMs < 60_000 with 400", async () => {
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", patch: { summaryIntervalMs: 30_000 } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing 'scope' field", async () => {
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patch: { autonomyLevel: "aggressive" } }),
    });
    expect(res.status).toBe(400);
  });

  it("partial PATCH preserves prior fields", async () => {
    await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "global",
        patch: { autonomyLevel: "aggressive", defaultMaxRounds: 25 },
      }),
    });
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", patch: { enabled: false } }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.global?.autonomyLevel).toBe("aggressive"); // preserved
    expect(j.global?.defaultMaxRounds).toBe(25);        // preserved
    expect(j.global?.enabled).toBe(false);              // updated
  });
});

describe("DELETE /api/scopes/:scopeId/goal-autonomy", () => {
  it("deletes the project layer and falls back to global", async () => {
    await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", patch: { autonomyLevel: "aggressive" } }),
    });
    await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", patch: { autonomyLevel: "conservative" } }),
    });
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy?scope=project`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.project).toBeNull();
    expect(j.effective.autonomyLevel).toBe("aggressive");
  });

  it("rejects DELETE without a valid 'scope' query", async () => {
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  it("DELETE on an absent layer is a no-op (200)", async () => {
    const res = await fetch(`${base}/api/scopes/global/goal-autonomy?scope=project`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/goals defaults", () => {
  it("uses defaultMaxRounds when caller omits maxRounds", async () => {
    // Set a non-default budget in the global layer.
    await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", patch: { defaultMaxRounds: 7, defaultTokensCap: 11_111 } }),
    });
    const res = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "test goal", model: "openai/gpt-4o" }),
    });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.goal.budget.roundsMax).toBe(7);
    expect(j.goal.budget.tokensMax).toBe(11_111);
  });

  it("caller-supplied maxRounds wins over autonomy default", async () => {
    await fetch(`${base}/api/scopes/global/goal-autonomy`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", patch: { defaultMaxRounds: 7 } }),
    });
    const res = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "test goal", model: "openai/gpt-4o", maxRounds: 99 }),
    });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.goal.budget.roundsMax).toBe(99);
  });
});
