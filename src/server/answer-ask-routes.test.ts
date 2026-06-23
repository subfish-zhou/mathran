/**
 * Focused tests for POST /api/chat/:id/answer-ask edge cases — specifically
 * the v0.17 W14 fix that turns a missing pendingAsk slot into a 200 ignored
 * response instead of a hard 404.
 *
 * Rationale: goal-mode runner auto-resolves `ask_user`, so the SPA can
 * end up POSTing /answer-ask against a session that never had pending
 * state (typically because a sidecar slot leaked from a previous
 * pre-goal chat round). A 404 here surfaced as a user-visible error;
 * 200 + { ignored: true } lets the SPA silently drop the inline answer
 * box.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";

let workspace: string;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "mathran-answer-ask-routes-"),
  );
  await fs.writeFile(
    path.join(workspace, "config.toml"),
    [
      'defaultModel = "openai/gpt-4o"',
      "",
      "[providers.openai]",
      'kind = "openai"',
      'apiKey = "sk-test"',
      'defaultModel = "gpt-4o"',
      "",
    ].join("\n"),
    "utf-8",
  );
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("POST /api/chat/:id/answer-ask (no-pending tolerance, v0.17 W14)", () => {
  it("200s with { ok, ignored, reason } when there is no pendingAsk slot", async () => {
    // Brand-new conversation id, no prior /api/chat round → no
    // pendingAsk slot on disk. Previously this returned 404 with
    // 'no pending ask_user for this conversation'; we now silently
    // tolerate the stale-sidecar shape.
    const res = await fetch(`${base}/api/chat/fresh-conv-a/answer-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "anything" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ignored: boolean;
      reason: string;
    };
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toMatch(/no pending ask_user/);
  });

  it("200 ignored is idempotent — second POST returns the same shape", async () => {
    // Same id, second hit: the route should still see no pending slot
    // and respond with the ignored shape. (No state mutation on the
    // ignored path, so this is a defensive contract for the SPA.)
    const id = "fresh-conv-b";
    const first = await fetch(`${base}/api/chat/${id}/answer-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "first" }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { ignored: boolean };
    expect(firstBody.ignored).toBe(true);

    const second = await fetch(`${base}/api/chat/${id}/answer-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "second" }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      ok: boolean;
      ignored: boolean;
    };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.ignored).toBe(true);
  });

  it("400 on empty answer still wins over 200 ignored — validation runs first", async () => {
    // The validation guard fires before we even look at the sidecar,
    // so an empty answer must still 400 to keep the SPA's input UX
    // honest (don't let a stale tab smuggle in a no-op reply).
    const res = await fetch(`${base}/api/chat/whatever-id/answer-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "   " }),
    });
    expect(res.status).toBe(400);
  });
});
