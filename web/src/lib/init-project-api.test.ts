import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("api.initProjectAi", () => {
  it("POSTs problem + aiInit to /api/agent/init-project and returns the slug/runId", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 202,
      async text() {
        return JSON.stringify({ projectSlug: "twin-primes", runId: "run-abc123abc123", aiAssisted: true });
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const res = await api.initProjectAi("Twin Primes", { searchDepth: "deep", seedReferences: ["arXiv:1311.1234"] });
    expect(res.projectSlug).toBe("twin-primes");
    expect(res.runId).toBe("run-abc123abc123");

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0]!;
    expect(url).toBe("/api/agent/init-project");
    const body = JSON.parse(init.body as string);
    expect(body.problem.title).toBe("Twin Primes");
    expect(body.aiInit.enableWiki).toBe(true);
    expect(body.aiInit.searchDepth).toBe("deep");
    expect(body.seedReferences).toEqual(["arXiv:1311.1234"]);
  });

  it("defaults to standard depth and empty seeds", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 202,
      async text() {
        return JSON.stringify({ projectSlug: "x", runId: "run-000000000000", aiAssisted: true });
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await api.initProjectAi("X");
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string);
    expect(body.aiInit.searchDepth).toBe("standard");
    expect(body.seedReferences).toEqual([]);
  });

  it("passes useSpine through to aiInit when provided", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 202,
      async text() {
        return JSON.stringify({ projectSlug: "y", runId: "run-111111111111", aiAssisted: true });
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await api.initProjectAi("Y", { useSpine: true });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string);
    expect(body.aiInit.useSpine).toBe(true);
  });

  it("omits useSpine from aiInit when not provided", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 202,
      async text() {
        return JSON.stringify({ projectSlug: "z", runId: "run-222222222222", aiAssisted: true });
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await api.initProjectAi("Z");
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string);
    expect("useSpine" in body.aiInit).toBe(false);
  });
});

describe("api.getInitRun", () => {
  it("GETs the run ledger and returns it", async () => {
    const ledger = {
      run: {
        runId: "run-abc123abc123",
        agentType: "init-project",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      phases: [{ phase: "explore_graph", event: "start", at: "2026-01-01T00:00:01.000Z" }],
      checkpoint: null,
      logs: [],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(ledger);
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const res = await api.getInitRun("run-abc123abc123");
    expect(res.run.runId).toBe("run-abc123abc123");
    expect(res.phases[0]!.phase).toBe("explore_graph");
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]![0]).toBe("/api/agent/init-project/run-abc123abc123");
  });
});

describe("api.resumeInitRun", () => {
  it("POSTs an empty body when no checkpoint is given", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 202,
      async text() {
        return JSON.stringify({ ok: true });
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await api.resumeInitRun("run-abc123abc123");
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0]!;
    expect(url).toBe("/api/agent/init-project/run-abc123abc123/resume");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("POSTs the checkpoint when provided", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 202,
      async text() {
        return JSON.stringify({ ok: true });
      },
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await api.resumeInitRun("run-abc123abc123", { checkpoint: "build_spine" });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const body = JSON.parse(calls[0]![1].body as string);
    expect(body.checkpoint).toBe("build_spine");
  });
});
