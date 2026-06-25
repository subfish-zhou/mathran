/**
 * Tests for the Copilot token resolver. These exercise the source-precedence
 * + caching logic without hitting the real `copilot_internal/v2/token`
 * endpoint — we stub `fetch` and the disk-state at temp paths.
 *
 * Coverage targets:
 *   1. env COPILOT_TOKEN  → returned verbatim, no exchange
 *   2. env COPILOT_GITHUB_TOKEN  → exchanged once, cached, reused
 *   3. fallback chain: env miss → sqlite hit (mocked via OPENCLAW_STATE_DIR)
 *   4. all sources fail → disk cache used as last resort
 *   5. every source fails AND cache stale → throws with attempt summary
 *
 * Concurrency note: Vitest runs files in parallel workers by default, but
 * tests inside one file run serially. We mutate `process.env` directly, so
 * any future change to file-level concurrency (`describe.concurrent`) would
 * need a per-test isolation helper. Today the simple beforeEach reset is
 * enough.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { resolveCopilotToken, _clearSessionCacheForTests } from "./copilot.js";

const ORIG_ENV = { ...process.env };
const SUPPRESSED_ENV_KEYS = [
  "COPILOT_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENCLAW_STATE_DIR",
  "HOME",
  "PATH",
] as const;

async function withTempState(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-copilot-test-"));
  // Point all path helpers (OpenClaw cache/sqlite AND ~/.copilot config) at
  // the empty temp dir so the resolver only sees what the test writes.
  process.env.OPENCLAW_STATE_DIR = dir;
  process.env.HOME = dir;
  // Mock `gh auth token` away — the real shell may have one set up.
  process.env.PATH = "/nonexistent-test-path-no-binaries";
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  _clearSessionCacheForTests();
  // Strip every Copilot-related env var so test isolation is real — the
  // test process inherits whatever the dev shell had set (e.g. real GH_TOKEN,
  // existing HOME pointing at a populated ~/.copilot/config.json).
  for (const k of SUPPRESSED_ENV_KEYS) {
    delete process.env[k];
  }
});

afterEach(() => {
  // Restore one key at a time. `process.env = {...}` creates a new object but
  // does NOT call into Node's internal env setter, so `os.homedir()` (which
  // reads internal env, not process.env) would still see the test's HOME.
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ORIG_ENV)) {
    if (v !== undefined) process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("resolveCopilotToken: (1) explicit COPILOT_TOKEN", () => {
  it("uses the env override and skips exchange entirely", async () => {
    process.env.COPILOT_TOKEN = "tid=abc;proxy-ep=proxy.individual.githubcopilot.com;exp=999";
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));

    const out = await resolveCopilotToken();
    expect(out.token).toBe(process.env.COPILOT_TOKEN);
    expect(out.baseUrl).toBe("https://api.individual.githubcopilot.com");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveCopilotToken: (2) env raw token + exchange", () => {
  it("exchanges a ghu_* env token and caches the result", async () => {
    await withTempState(async () => {
      process.env.COPILOT_GITHUB_TOKEN = "ghu_test_raw_token_123456789012345";
      const sessionToken = "tid=session;proxy-ep=proxy.individual.githubcopilot.com;exp=42";
      const expiresAtSec = Math.floor(Date.now() / 1000) + 1800;

      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ token: sessionToken, expires_at: expiresAtSec }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      const out1 = await resolveCopilotToken();
      expect(out1.token).toBe(sessionToken);
      expect(out1.expiresAt).toBeCloseTo(expiresAtSec * 1000, -2);
      // 2026-06-25: resolveCopilotToken now also fires a best-effort
      // `refreshCopilotModelsCacheFromBaseUrl(/models)` after a fresh
      // exchange, which adds a second fetch (the /token exchange + the
      // /models warm). It's intentionally fire-and-forget (`void …`)
      // so the second call lands asynchronously — wait one microtask
      // so it's observable in the spy count before asserting.
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Second call within the cache window should NOT trigger a third fetch
      // (cache hit avoids the exchange; without a re-exchange there's also
      // no new /models warm).
      const out2 = await resolveCopilotToken();
      expect(out2.token).toBe(sessionToken);
      await new Promise((r) => setTimeout(r, 0));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it("rejects a classic ghp_* env token and continues falling through", async () => {
    await withTempState(async (stateDir) => {
      // ghp_* is rejected by the validator, so the env source contributes
      // nothing and resolveCopilotToken should throw the "no sources" error
      // (since there's no disk cache either).
      process.env.GITHUB_TOKEN = "ghp_classic_pat_should_be_rejected_xx";
      const fetchSpy = vi.spyOn(global, "fetch");

      await expect(resolveCopilotToken()).rejects.toThrow(/Could not resolve/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

describe("resolveCopilotToken: (3) fallthrough when env exchange returns 404", () => {
  it("walks past a 404-failing env token to try the next source (sqlite)", async () => {
    await withTempState(async () => {
      process.env.COPILOT_GITHUB_TOKEN = "gho_low_scope_token_will_404_xxxxxxxxx";

      // The env gho_ exchange returns 404 every time; we have no other
      // live sources so resolveCopilotToken should throw with the env
      // failure recorded in the message. Use `mockResolvedValue` (not
      // Once) because we assert on the error message twice.
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      );

      await expect(resolveCopilotToken()).rejects.toThrow(/env:COPILOT_GITHUB_TOKEN/);
      await expect(resolveCopilotToken()).rejects.toThrow(/HTTP 404/);
      expect(fetchSpy).toHaveBeenCalled();
    });
  });
});

describe("resolveCopilotToken: (4) disk-cache fallback", () => {
  it("returns the disk-cached session token when no raw source succeeds", async () => {
    await withTempState(async (stateDir) => {
      const credsDir = path.join(stateDir, "credentials");
      await fs.mkdir(credsDir, { recursive: true });
      const cachedToken = "tid=cached;proxy-ep=proxy.individual.githubcopilot.com;exp=fresh";
      const expiresAt = Date.now() + 20 * 60_000; // 20 min ahead → usable
      await fs.writeFile(
        path.join(credsDir, "github-copilot.token.json"),
        JSON.stringify({
          token: cachedToken,
          expiresAt,
          integrationId: "vscode-chat",
          updatedAt: Date.now(),
        }),
      );

      const fetchSpy = vi.spyOn(global, "fetch");

      const out = await resolveCopilotToken();
      expect(out.token).toBe(cachedToken);
      expect(out.expiresAt).toBe(expiresAt);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("ignores a stale disk cache (expired or wrong integrationId)", async () => {
    await withTempState(async (stateDir) => {
      const credsDir = path.join(stateDir, "credentials");
      await fs.mkdir(credsDir, { recursive: true });
      await fs.writeFile(
        path.join(credsDir, "github-copilot.token.json"),
        JSON.stringify({
          token: "expired-token",
          expiresAt: Date.now() - 60_000, // already past
          integrationId: "vscode-chat",
        }),
      );

      await expect(resolveCopilotToken()).rejects.toThrow(/Could not resolve/);
    });
  });
});

describe("resolveCopilotToken: (5) error message lists what was tried", () => {
  it("names every source that was attempted in the failure message", async () => {
    await withTempState(async () => {
      process.env.COPILOT_GITHUB_TOKEN = "ghu_will_fail_xxxxxxxxxxxxxxxxxxxxxx";
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response("simulated network rejection", { status: 503 }),
      );

      const promise = resolveCopilotToken();
      await expect(promise).rejects.toThrow(/env:COPILOT_GITHUB_TOKEN.*HTTP 503/s);
      await expect(promise).rejects.toThrow(/openclaw models auth login-github-copilot/);
    });
  });
});
