/**
 * Tests for the #3 Background Agents REST surface:
 *   - GET  /api/subagents/active
 *   - POST /api/subagents/:id/cancel
 *
 * We drive the shared process-local background registry directly (no LLM, no
 * real subagent run) and hit the endpoints over a real fetch.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import {
  globalBackgroundRegistry,
  _resetGlobalBackgroundRegistryForTests,
} from "../core/subagent/index.js";

let workspace: string;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-subagents-routes-"));
  await fs.writeFile(path.join(workspace, "config.toml"), "", "utf-8");
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    chatSessionFactory: () => {
      throw new Error("chat session factory should not be called in route tests");
    },
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  // The endpoints read the *singleton*, so reset between tests for isolation.
  _resetGlobalBackgroundRegistryForTests();
});

describe("GET /api/subagents/active", () => {
  it("returns kinds + an empty active list when nothing is running", async () => {
    const res = await fetch(`${base}/api/subagents/active`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kinds: string[]; active: unknown[] };
    expect(Array.isArray(body.kinds)).toBe(true);
    expect(body.kinds).toContain("search");
    expect(body.active).toEqual([]);
  });

  it("lists running background subagents with their public fields", async () => {
    const reg = globalBackgroundRegistry();
    reg.register({ type: "research", parentConversationId: "conv-1", taskSummary: "prove it" });
    reg.register({ type: "search", parentConversationId: "conv-2", taskSummary: "grep it" });

    const res = await fetch(`${base}/api/subagents/active`);
    const body = (await res.json()) as { active: any[] };
    expect(body.active).toHaveLength(2);
    const r = body.active.find((s) => s.type === "research");
    expect(r).toMatchObject({
      mode: "background",
      status: "running",
      parentConversationId: "conv-1",
      taskSummary: "prove it",
    });
    expect(r.id).toMatch(/^bg-[0-9a-f]{8}$/);
  });
});

describe("POST /api/subagents/:id/cancel", () => {
  it("cancels a running subagent → 200 + status cancelled, signal aborts", async () => {
    const reg = globalBackgroundRegistry();
    const { record, signal } = reg.register({
      type: "research",
      parentConversationId: "conv-1",
      taskSummary: "long run",
    });

    const res = await fetch(`${base}/api/subagents/${record.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body).toMatchObject({ ok: true, status: "cancelled" });
    expect(signal.aborted).toBe(true);
    expect(reg.get(record.id)!.status).toBe("cancelled");
  });

  it("unknown id → 404", async () => {
    const res = await fetch(`${base}/api/subagents/bg-deadbeef/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("already-terminal id → 409", async () => {
    const reg = globalBackgroundRegistry();
    const { record } = reg.register({
      type: "search",
      parentConversationId: "conv-1",
      taskSummary: "quick",
    });
    reg.cancelSubagent(record.id);
    const res = await fetch(`${base}/api/subagents/${record.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});
