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
});
