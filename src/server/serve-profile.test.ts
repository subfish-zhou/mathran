/**
 * Permission Profiles (C-1 §2) — `mathran serve --profile` wiring tests.
 *
 * Verifies:
 *   1. startServer({ profile: "ci" }) resolves and exposes the name on
 *      RunningServer.profile.
 *   2. settings.json#profile is honoured when no flag is passed.
 *   3. An unknown profile name is logged to stderr (warn-and-ignore) and
 *      RunningServer.profile is undefined.
 *
 * Note: this test focuses on the resolution + propagation seams, not on the
 * end-to-end SSE chat path. The autoApprovePattern and hardReject behaviour
 * are exhaustively covered by the profile-{integration,hard-reject-precedence}
 * tests and approval-broker-auto-approve.test.ts; once those pass the only
 * remaining thing to pin down here is "did `startServer` plumb the option
 * through to its session factory".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import { ChatSession } from "../core/chat/index.js";

let workspace: string;
let servers: RunningServer[] = [];

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-serve-profile-"));
  // Minimal config.toml so loadConfig doesn't blow up if the factory seam ever
  // falls through (it shouldn't for these tests — we always inject a factory).
  await fs.writeFile(
    path.join(workspace, "config.toml"),
    'defaultModel = "openai/gpt-4o"\n',
    "utf-8",
  );
});

afterEach(async () => {
  for (const s of servers) {
    try {
      await s.close();
    } catch {
      /* ignore */
    }
  }
  servers = [];
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("startServer --profile (C-1 §2)", () => {
  it("exposes the resolved profile name on RunningServer when --profile=ci", async () => {
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      profile: "ci",
      chatSessionFactory: ({ model }) => new ChatSession({ llm: fakeLlm(), model }),
    });
    servers.push(server);
    expect(server.profile).toBe("ci");
  });

  it("honours settings.json#profile when no --profile flag is passed", async () => {
    await fs.mkdir(path.join(workspace, ".mathran"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".mathran", "settings.json"),
      JSON.stringify({ profile: "review" }),
      "utf-8",
    );

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      chatSessionFactory: ({ model }) => new ChatSession({ llm: fakeLlm(), model }),
    });
    servers.push(server);
    expect(server.profile).toBe("review");
  });

  it("an unknown profile is logged and ignored (RunningServer.profile undefined)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      profile: "no-such-profile",
      chatSessionFactory: ({ model }) => new ChatSession({ llm: fakeLlm(), model }),
    });
    servers.push(server);
    expect(server.profile).toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    const allMsgs = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allMsgs).toMatch(/no-such-profile/);
    errSpy.mockRestore();
  });

  it("explicit --profile beats settings.json#profile", async () => {
    await fs.mkdir(path.join(workspace, ".mathran"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".mathran", "settings.json"),
      JSON.stringify({ profile: "review" }),
      "utf-8",
    );

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      profile: "dev",
      chatSessionFactory: ({ model }) => new ChatSession({ llm: fakeLlm(), model }),
    });
    servers.push(server);
    expect(server.profile).toBe("dev");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function fakeLlm() {
  return {
    async describe() {
      return { name: "fake" };
    },
    async chat() {
      return {
        async *stream() {
          yield { type: "text" as const, delta: "ok" };
          yield { type: "done" as const, finishReason: "stop" as const };
        },
      };
    },
  };
}
