/**
 * Tests for `mathran serve` — the local-only Hono backend.
 *
 * The server is started on an ephemeral port (`port: 0`) bound to 127.0.0.1 and
 * driven over real `fetch`. The chat SSE path injects a fake LLM (via the
 * `chatSessionFactory` seam) so no real provider is ever contacted.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, defaultSessionFactory, buildScopedSystemPrompt, appendPersistentContext, type RunningServer } from "./serve.js";
import { ChatSession, AskUserPending } from "../core/chat/index.js";
import type { ConversationAnnotations } from "../core/chat/store.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../core/providers/llm.js";

/** A fake LLM that streams a fixed reply and then stops (no tool calls). */
function fakeLlm(reply: string): LLMProvider {
  return {
    async describe() {
      return { name: "fake" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          for (const ch of reply) {
            yield { type: "text", delta: ch };
          }
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
  };
}

let workspace: string;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-serve-"));
  // Seed a config.toml with a provider that has an inline key — to verify masking.
  await fs.writeFile(
    path.join(workspace, "config.toml"),
    [
      'defaultModel = "openai/gpt-4o"',
      "",
      "[providers.openai]",
      'kind = "openai"',
      'apiKey = "sk-secret-should-never-leak"',
      'defaultModel = "gpt-4o"',
      "",
      "[providers.ollama]",
      'kind = "ollama"',
      "",
    ].join("\n"),
    "utf-8",
  );

  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    chatSessionFactory: ({ model }) =>
      new ChatSession({ llm: fakeLlm("hi there"), model }),
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("serve binding", () => {
  it("binds to 127.0.0.1 and exposes the bound url", () => {
    expect(server.host).toBe("127.0.0.1");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.port).toBeGreaterThan(0);
  });
});

describe("GET /api/health", () => {
  it("returns ok + version + workspace", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.workspace).toBe(workspace);
  });
});

describe("projects REST", () => {
  it("lists empty, creates, then reads back", async () => {
    const empty = await (await fetch(`${base}/api/projects`)).json();
    expect(empty.projects).toEqual([]);

    const created = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "My First Project" }),
    });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project.slug).toBe("my-first-project");

    const list = await (await fetch(`${base}/api/projects`)).json();
    expect(list.projects.map((p: any) => p.slug)).toContain("my-first-project");

    const detail = await fetch(`${base}/api/projects/my-first-project`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.slug).toBe("my-first-project");
    expect((detailBody.project as any).project.name).toBe("My First Project");
    expect(detailBody.entries).toContain("wiki/");
  });

  it("404s an unknown project", async () => {
    const res = await fetch(`${base}/api/projects/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("rejects a project with no name", async () => {
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
  });
});

describe("wiki REST", () => {
  it("lists the auto-generated index page and reads it", async () => {
    const list = await (await fetch(`${base}/api/projects/my-first-project/wiki`)).json();
    expect(list.pages.map((p: any) => p.page)).toContain("index");

    const page = await (
      await fetch(`${base}/api/projects/my-first-project/wiki/index`)
    ).json();
    expect(page.page).toBe("index");
    expect(page.body).toContain("# My First Project");
    expect(page.frontmatter.title).toBe("My First Project");
  });

  it("writes a page via PUT and reads it back", async () => {
    const put = await fetch(`${base}/api/projects/my-first-project/wiki/notes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Some **notes** body." }),
    });
    expect(put.status).toBe(200);

    const page = await (
      await fetch(`${base}/api/projects/my-first-project/wiki/notes`)
    ).json();
    expect(page.body).toContain("Some **notes** body.");

    // The PUT must be reflected in the list.
    const list = await (await fetch(`${base}/api/projects/my-first-project/wiki`)).json();
    expect(list.pages.map((p: any) => p.page)).toContain("notes");
  });

  it("404s wiki for an unknown project", async () => {
    const res = await fetch(`${base}/api/projects/nope/wiki`);
    expect(res.status).toBe(404);
  });
});

describe("providers + config (key masking)", () => {
  it("masks api keys in /api/providers", async () => {
    const res = await fetch(`${base}/api/providers`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("sk-secret-should-never-leak");
    const body = JSON.parse(text);
    expect(body.providers.openai.kind).toBe("openai");
    expect(body.providers.openai.key).toBe("set");
    expect(body.providers.ollama.key).toBe("missing");
    expect(body.defaultModel).toBe("openai/gpt-4o");
  });

  it("never leaks keys in /api/config", async () => {
    const res = await fetch(`${base}/api/config`);
    const text = await res.text();
    expect(text).not.toContain("sk-secret-should-never-leak");
    const body = JSON.parse(text);
    expect(body.defaultModel).toBe("openai/gpt-4o");
    expect(body.providers.openai).not.toHaveProperty("apiKey");
  });

  it("PUT /api/providers merges without clobbering other sections", async () => {
    const res = await fetch(`${base}/api/providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: { anthropic: { kind: "anthropic", apiKey: "sk-ant-xyz" } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers.anthropic.key).toBe("set");
    // Existing providers are preserved.
    expect(body.providers.openai.kind).toBe("openai");
    expect(body.providers.ollama.kind).toBe("ollama");

    // And the raw key landed on disk (write-through) but is still masked over HTTP.
    const raw = await fs.readFile(path.join(workspace, "config.toml"), "utf-8");
    expect(raw).toContain("sk-ant-xyz");
    expect(raw).toContain("sk-secret-should-never-leak");
  });

  it("GET /api/providers exposes baseUrl/endpoint/deployment/apiVersion (no secrets)", async () => {
    // Seed an azure entry + an openai entry with baseUrl so the form has
    // something to render.
    await fetch(`${base}/api/providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: {
          "azure-prod": {
            kind: "azure",
            apiKey: "sk-secret-azure",
            endpoint: "https://example.openai.azure.com",
            deployment: "gpt55",
            apiVersion: "2024-12-01-preview",
            defaultModel: "gpt55",
          },
        },
      }),
    });
    const res = await fetch(`${base}/api/providers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const azure = body.providers["azure-prod"];
    expect(azure.kind).toBe("azure");
    expect(azure.endpoint).toBe("https://example.openai.azure.com");
    expect(azure.deployment).toBe("gpt55");
    expect(azure.apiVersion).toBe("2024-12-01-preview");
    expect(azure.key).toBe("set");
    // Never leak the secret.
    expect(azure).not.toHaveProperty("apiKey");
    expect(JSON.stringify(body)).not.toContain("sk-secret-azure");
  });

  it("PUT /api/providers can create a brand-new provider entry", async () => {
    const res = await fetch(`${base}/api/providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: {
          "copilot-new": { kind: "copilot", defaultModel: "gpt-5.5" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers["copilot-new"].kind).toBe("copilot");
    expect(body.providers["copilot-new"].model).toBe("gpt-5.5");
  });

  it("PUT /api/providers rejects an unknown provider kind", async () => {
    const res = await fetch(`${base}/api/providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: { weirdo: { kind: "not-a-real-kind" } },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/kind/);
  });
});

describe("POST /api/chat (SSE)", () => {
  it("streams text deltas and a done frame from the injected session", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await res.text();
    const dataLines = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice("data:".length).trim()));

    const text = dataLines
      .filter((d) => d.type === "text")
      .map((d) => d.delta)
      .join("");
    expect(text).toBe("hi there");
    expect(dataLines.some((d) => d.type === "done")).toBe(true);
  });

  it("rejects a chat with no message", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});


describe("path-traversal hardening (BUG #5)", () => {
  it("rejects a project slug with `..`", async () => {
    const res = await fetch(`${base}/api/projects/${encodeURIComponent("../wiki")}/wiki`);
    expect(res.status).toBe(400);
  });

  it("rejects a wiki page slug with `..`", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/${encodeURIComponent("../wiki/index")}`,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a PUT with a traversal page slug", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/${encodeURIComponent("../../etc/passwd")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "PWNED" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects an absolute-path-style page slug", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/${encodeURIComponent("/etc/passwd")}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("ChatSessionStore (BUG #6)", () => {
  it("preserves history across two POST /api/chat calls with the same sessionId", async () => {
    // We use a fresh server with a session-aware fake that echoes the message
    // count seen in `req.messages` (filtered to user turns) so we can prove
    // multi-turn history flowed.
    let seenUserMessages = 0;
    const echoSession = new ChatSession({
      llm: {
        async describe() {
          return { name: "echo" };
        },
        async chat(req: LLMRequest): Promise<LLMResponse> {
          const userTurns = req.messages.filter((m) => m.role === "user").length;
          seenUserMessages = userTurns;
          return {
            async *stream(): AsyncIterable<LLMStreamChunk> {
              yield { type: "text", delta: `users=${userTurns}` };
              yield { type: "done", finishReason: "stop" };
            },
          };
        },
      },
      model: "echo",
    });

    const localServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      chatSessionFactory: () => echoSession,
    });
    try {
      const sessionId = "test-conversation-1";
      const post = (msg: string) =>
        fetch(`${localServer.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, sessionId }),
        });

      const r1 = await post("first");
      const t1 = await r1.text();
      expect(t1).toContain('"delta":"users=1"');

      const r2 = await post("second");
      const t2 = await r2.text();
      // Round 2 must see the round-1 user message + the round-1 assistant
      // reply + the round-2 user message → 2 user turns total.
      expect(t2).toContain('"delta":"users=2"');
      expect(seenUserMessages).toBe(2);
    } finally {
      await localServer.close();
    }
  });

  it("emits the session id on the first SSE frame", async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", sessionId: "abc-id" }),
    });
    const raw = await res.text();
    expect(raw).toMatch(/event:\s*session/);
    expect(raw).toContain('"sessionId":"abc-id"');
  });
});

// ─── v0.16 §1 ──────────────────────────────────────────────────────────────
// Re-run / Truncate were added because the original Re-run button just
// stuffed the prompt back into the composer (BUG #11 / subfish review
// 2026-06-20). These tests pin the behavior the SPA depends on: the server
// must truncate to the right anchor, replay history, and stream a fresh
// assistant turn over the same SSE envelope as POST /api/chat.
describe("POST /api/chat/:id/rerun (v0.16 §1)", () => {
  it("truncates to the Nth user message and streams a fresh reply", async () => {
    // A fake LLM that reports how many user turns it observed *and* which
    // assistant counter it should emit. Without explicit state we couldn't
    // tell a fresh rerun apart from the original turn.
    let assistantTurn = 0;
    const countingSession = new ChatSession({
      llm: {
        async describe() { return { name: "counter" }; },
        async chat(req: LLMRequest): Promise<LLMResponse> {
          const users = req.messages.filter((m) => m.role === "user").length;
          assistantTurn++;
          const turn = assistantTurn;
          return {
            async *stream(): AsyncIterable<LLMStreamChunk> {
              yield { type: "text", delta: `turn=${turn} users=${users}` };
              yield { type: "done", finishReason: "stop" };
            },
          };
        },
      },
      model: "counter",
    });

    const localServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      chatSessionFactory: () => countingSession,
    });
    try {
      const sessionId = "rerun-test-1";
      const post = (msg: string) =>
        fetch(`${localServer.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, sessionId }),
        });

      // Build up two turns: prompt #0 and prompt #1.
      const r1 = await post("first");
      expect(await r1.text()).toContain('"delta":"turn=1 users=1"');
      const r2 = await post("second");
      expect(await r2.text()).toContain('"delta":"turn=2 users=2"');

      // Re-run prompt #0. Server should drop everything from prompt #0
      // onward, replay nothing, then session.send("first") which makes
      // users=1 again. The assistant turn counter ticks to 3 (proving
      // the LLM was invoked fresh, not just rehydrated).
      const rerun = await fetch(
        `${localServer.url}/api/chat/${sessionId}/rerun`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userMessageIndex: 0 }),
        },
      );
      expect(rerun.status).toBe(200);
      const rerunText = await rerun.text();
      expect(rerunText).toContain('"delta":"turn=3 users=1"');
      expect(rerunText).toMatch(/event:\s*session/);
    } finally {
      await localServer.close();
    }
  });

  it("uses overrideText when provided (edit + resend flow)", async () => {
    let lastUserText = "";
    const captureSession = new ChatSession({
      llm: {
        async describe() { return { name: "capture" }; },
        async chat(req: LLMRequest): Promise<LLMResponse> {
          const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
          lastUserText = (lastUser?.content ?? "") as string;
          return {
            async *stream(): AsyncIterable<LLMStreamChunk> {
              yield { type: "text", delta: `saw=${lastUserText}` };
              yield { type: "done", finishReason: "stop" };
            },
          };
        },
      },
      model: "capture",
    });
    const localServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      chatSessionFactory: () => captureSession,
    });
    try {
      const sessionId = "rerun-test-2";
      const post = (msg: string) =>
        fetch(`${localServer.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, sessionId }),
        });
      await (await post("original prompt")).text();

      const rerun = await fetch(
        `${localServer.url}/api/chat/${sessionId}/rerun`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userMessageIndex: 0, overrideText: "edited prompt" }),
        },
      );
      expect(rerun.status).toBe(200);
      const text = await rerun.text();
      expect(text).toContain('"delta":"saw=edited prompt"');
      // Sanity check that we actually overrode it on the wire.
      expect(lastUserText).toBe("edited prompt");
    } finally {
      await localServer.close();
    }
  });

  it("400s when userMessageIndex is missing/negative", async () => {
    const res = await fetch(`${base}/api/chat/whatever/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("404s an unknown conversation", async () => {
    const res = await fetch(`${base}/api/chat/does-not-exist-12345/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userMessageIndex: 0 }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/chat/:id/truncate (v0.16 §1)", () => {
  it("mode=include drops the target user message and everything after", async () => {
    const session = new ChatSession({
      llm: {
        async describe() { return { name: "trunc" }; },
        async chat(req: LLMRequest): Promise<LLMResponse> {
          const users = req.messages.filter((m) => m.role === "user").length;
          return {
            async *stream(): AsyncIterable<LLMStreamChunk> {
              yield { type: "text", delta: `users=${users}` };
              yield { type: "done", finishReason: "stop" };
            },
          };
        },
      },
      model: "trunc",
    });
    const localServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      chatSessionFactory: () => session,
    });
    try {
      const sessionId = "trunc-test-1";
      const post = (msg: string) =>
        fetch(`${localServer.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, sessionId }),
        });
      await (await post("a")).text();
      await (await post("b")).text();
      await (await post("c")).text();

      // Drop user #1 ("b") and everything after. Should leave just the
      // user/assistant pair from prompt "a".
      const trunc = await fetch(
        `${localServer.url}/api/chat/${sessionId}/truncate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userMessageIndex: 1, mode: "include" }),
        },
      );
      expect(trunc.status).toBe(200);
      const body = (await trunc.json()) as { length: number; mode: string };
      expect(body.mode).toBe("include");
      // History should now be [user "a", assistant "users=1"] = length 2.
      expect(body.length).toBe(2);

      // The next send must see 1 prior user turn (just "a"), then +1 = 2.
      const r = await post("d");
      expect(await r.text()).toContain('"delta":"users=2"');
    } finally {
      await localServer.close();
    }
  });

  it("mode=after keeps the target user message and drops only what follows", async () => {
    const session = new ChatSession({
      llm: {
        async describe() { return { name: "trunc-after" }; },
        async chat(req: LLMRequest): Promise<LLMResponse> {
          const users = req.messages.filter((m) => m.role === "user").length;
          return {
            async *stream(): AsyncIterable<LLMStreamChunk> {
              yield { type: "text", delta: `users=${users}` };
              yield { type: "done", finishReason: "stop" };
            },
          };
        },
      },
      model: "trunc-after",
    });
    const localServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      chatSessionFactory: () => session,
    });
    try {
      const sessionId = "trunc-test-2";
      const post = (msg: string) =>
        fetch(`${localServer.url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: msg, sessionId }),
        });
      await (await post("a")).text();
      await (await post("b")).text();

      // mode=after on user #0 ("a"): keep "a", drop everything else.
      // Leaves just one user message in history, length 1.
      const trunc = await fetch(
        `${localServer.url}/api/chat/${sessionId}/truncate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userMessageIndex: 0, mode: "after" }),
        },
      );
      expect(trunc.status).toBe(200);
      const body = (await trunc.json()) as { length: number; mode: string };
      expect(body.mode).toBe("after");
      expect(body.length).toBe(1);
    } finally {
      await localServer.close();
    }
  });
});

// ─── v0.16 §2: annotations sidecar (React / Pin / Note / Reply) ──────────────
describe("Annotations sidecar (v0.16 §2)", () => {
  it("GET returns an empty sidecar for a fresh conversation", async () => {
    const res = await fetch(`${base}/api/chat/never-touched/annotations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationAnnotations;
    expect(body.version).toBe(1);
    expect(body.byBubbleIdx).toEqual({});
  });

  it("PATCH merges fields and GET round-trips them", async () => {
    const id = "ann-test-1";
    // PATCH a couple of fields on bubble 3.
    const r1 = await fetch(`${base}/api/chat/${id}/annotations/3`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true, note: "think harder" }),
    });
    expect(r1.status).toBe(200);

    // Then PATCH again to add reactions without losing the previous fields.
    const r2 = await fetch(`${base}/api/chat/${id}/annotations/3`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reactions: { "❤": 1, "🔥": 1 } }),
    });
    expect(r2.status).toBe(200);

    const r3 = await fetch(`${base}/api/chat/${id}/annotations`);
    const body = (await r3.json()) as ConversationAnnotations;
    expect(body.byBubbleIdx["3"]).toEqual({
      pinned: true,
      note: "think harder",
      reactions: { "❤": 1, "🔥": 1 },
    });
  });

  it("PATCH with null clears individual fields", async () => {
    const id = "ann-test-2";
    await fetch(`${base}/api/chat/${id}/annotations/0`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true, note: "keep me" }),
    });
    await fetch(`${base}/api/chat/${id}/annotations/0`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: null }),
    });
    const get = await fetch(`${base}/api/chat/${id}/annotations`);
    const body = (await get.json()) as ConversationAnnotations;
    expect(body.byBubbleIdx["0"]).toEqual({ note: "keep me" });
  });

  it("PATCH that empties the record drops the bubble key entirely", async () => {
    const id = "ann-test-3";
    await fetch(`${base}/api/chat/${id}/annotations/5`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    await fetch(`${base}/api/chat/${id}/annotations/5`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: null }),
    });
    const get = await fetch(`${base}/api/chat/${id}/annotations`);
    const body = (await get.json()) as ConversationAnnotations;
    expect(body.byBubbleIdx["5"]).toBeUndefined();
  });

  it("POST /react toggles an emoji on and off", async () => {
    const id = "ann-test-4";
    // First click: add 1.
    const r1 = await fetch(`${base}/api/chat/${id}/annotations/2/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "👍" }),
    });
    const b1 = (await r1.json()) as { reactions: Record<string, number> };
    expect(b1.reactions).toEqual({ "👍": 1 });

    // Second click: remove.
    const r2 = await fetch(`${base}/api/chat/${id}/annotations/2/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "👍" }),
    });
    const b2 = (await r2.json()) as { reactions: Record<string, number> };
    expect(b2.reactions).toEqual({});
  });

  it("POST /react rejects missing emoji and non-thumb emojis (v0.16 §4)", async () => {
    const r1 = await fetch(`${base}/api/chat/ann-test-5/annotations/0/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400);

    // Anything that isn't 👍 / 👎 is rejected, including the previously-
    // allowed picker emojis like ❤️. Keeps the UX intent enforced server-side.
    const r2 = await fetch(`${base}/api/chat/ann-test-5/annotations/0/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "❤️" }),
    });
    expect(r2.status).toBe(400);

    const r3 = await fetch(`${base}/api/chat/ann-test-5/annotations/0/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "x".repeat(100) }),
    });
    expect(r3.status).toBe(400);
  });

  it("POST /react accepts 👍 and 👎 (v0.16 §4)", async () => {
    const up = await fetch(`${base}/api/chat/ann-thumb/annotations/0/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(up.status).toBe(200);
    const down = await fetch(`${base}/api/chat/ann-thumb/annotations/0/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "👎" }),
    });
    expect(down.status).toBe(200);
  });

  it("truncate prunes annotations at-and-beyond pruneFromBubbleIdx", async () => {
    const id = "ann-prune-trunc";
    // Seed history so /truncate has something to bite on.
    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", sessionId: id }),
    }).then((r) => r.text());

    // Drop annotations on bubble 0, 1, 2.
    for (const idx of [0, 1, 2]) {
      await fetch(`${base}/api/chat/${id}/annotations/${idx}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      });
    }

    // Truncate to user message #0, telling the server to wipe bubbles >=1.
    const trunc = await fetch(`${base}/api/chat/${id}/truncate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userMessageIndex: 0,
        mode: "after",
        pruneFromBubbleIdx: 1,
      }),
    });
    expect(trunc.status).toBe(200);

    const get = await fetch(`${base}/api/chat/${id}/annotations`);
    const body = (await get.json()) as ConversationAnnotations;
    expect(body.byBubbleIdx["0"]).toEqual({ pinned: true });
    expect(body.byBubbleIdx["1"]).toBeUndefined();
    expect(body.byBubbleIdx["2"]).toBeUndefined();
  });
});


describe("wiki versioning (T1-A)", () => {
  beforeAll(async () => {
    // Create a wiki page we can version.
    await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "v1 body" }),
    });
  });

  it("first write yields version=1 with no history", async () => {
    const page = await (await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page`)).json();
    expect(page.version).toBe(1);
    expect(page.body).toBe("v1 body");
    const hist = await (await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page/history`)).json();
    expect(hist.versions).toEqual([]);
  });

  it("second write yields version=2 and surfaces v1 in history", async () => {
    await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "v2 body" }),
    });
    const page = await (await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page`)).json();
    expect(page.version).toBe(2);
    expect(page.body).toBe("v2 body");
    const hist = await (await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page/history`)).json();
    expect(hist.versions.length).toBe(1);
    expect(hist.versions[0].version).toBe(1);
  });

  it("can read a specific old version verbatim", async () => {
    const v1 = await (
      await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page/history/1`)
    ).json();
    expect(v1.version).toBe(1);
    expect(v1.body).toBe("v1 body");
  });

  it("rejects a history fetch with non-integer or zero version", async () => {
    const a = await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page/history/abc`);
    expect(a.status).toBe(400);
    const b = await fetch(`${base}/api/projects/my-first-project/wiki/versioned-page/history/0`);
    expect(b.status).toBe(400);
  });

  it("persists parent + sortOrder on PUT and surfaces them on list", async () => {
    await fetch(`${base}/api/projects/my-first-project/wiki/child-page`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "child", parent: "index", sortOrder: 5, title: "Child Page" }),
    });
    const list = await (await fetch(`${base}/api/projects/my-first-project/wiki`)).json();
    const child = list.pages.find((p: any) => p.page === "child-page");
    expect(child.parent).toBe("index");
    expect(child.sortOrder).toBe(5);
    expect(child.title).toBe("Child Page");
  });

  it("rejects a traversal-style parent slug", async () => {
    const res = await fetch(`${base}/api/projects/my-first-project/wiki/bad-parent`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x", parent: "../etc/passwd" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("wiki diff (GAP #10)", () => {
  beforeAll(async () => {
    // Build up a page with 3 distinct bodies so we can diff v1↔v2, v2↔current,
    // and v1↔current.
    await fetch(`${base}/api/projects/my-first-project/wiki/diff-target`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "line a\nline b\nline c\n" }),
    });
    await fetch(`${base}/api/projects/my-first-project/wiki/diff-target`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "line a\nline b changed\nline c\n" }),
    });
    await fetch(`${base}/api/projects/my-first-project/wiki/diff-target`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "line a\nline b changed\nline c\nline d added\n" }),
    });
  });

  it("defaults to diffing latest history version against current", async () => {
    const res = await fetch(`${base}/api/projects/my-first-project/wiki/diff-target/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe("diff-target");
    // Latest history snapshot is v2 (current=v3 was just written, v2 is in .history).
    expect(body.from.version).toBe(2);
    expect(body.to.version).toBe("current");
    expect(body.patch).toMatch(/\+line d added/);
    expect(body.patch).not.toMatch(/-line b changed/);
  });

  it("diffs two explicit history versions", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/diff-target/diff?from=1&to=2`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from.label).toBe("v1");
    expect(body.to.label).toBe("v2");
    expect(body.patch).toMatch(/-line b/);
    expect(body.patch).toMatch(/\+line b changed/);
  });

  it("accepts to=current explicitly", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/diff-target/diff?from=1&to=current`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from.version).toBe(1);
    expect(body.to.version).toBe("current");
    expect(body.patch).toMatch(/\+line b changed/);
    expect(body.patch).toMatch(/\+line d added/);
  });

  it("returns an empty patch when from==to", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/diff-target/diff?from=current&to=current`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // createTwoFilesPatch with identical inputs still returns header lines but
    // no +/- body lines.
    expect(body.patch).not.toMatch(/^\+[^+]/m);
    expect(body.patch).not.toMatch(/^-[^-]/m);
  });

  it("404s when the page does not exist", async () => {
    const res = await fetch(`${base}/api/projects/my-first-project/wiki/no-such-page/diff`);
    expect(res.status).toBe(404);
  });

  it("404s when a referenced version does not exist", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/diff-target/diff?from=999&to=current`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects malformed version params", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/diff-target/diff?from=abc&to=current`,
    );
    expect(res.status).toBe(400);
  });

  it("rejects traversal-style page slug", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/wiki/${encodeURIComponent("../etc/passwd")}/diff`,
    );
    expect(res.status).toBe(400);
  });
});


describe("effort REST (T1-B)", () => {
  it("starts with no efforts", async () => {
    const list = await (await fetch(`${base}/api/projects/my-first-project/efforts`)).json();
    expect(list.efforts).toEqual([]);
  });

  it("creates an effort with valid type", async () => {
    const res = await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Twin Primes", type: "PROOF_ATTEMPT", description: "Try a sieve" }),
    });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.slug).toBe("twin-primes");
    expect(r.metadata.type).toBe("PROOF_ATTEMPT");
  });

  it("rejects bogus effort type", async () => {
    const res = await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "X", type: "BOGUS" }),
    });
    expect(res.status).toBe(400);
  });

  it("reads back metadata via /effort/:effortSlug", async () => {
    const r = await (await fetch(`${base}/api/projects/my-first-project/effort/twin-primes`)).json();
    expect(r.effort.title).toBe("Twin Primes");
    expect(r.effort.status).toBe("DRAFT");
  });

  it("PATCH updates status + title", async () => {
    const res = await fetch(`${base}/api/projects/my-first-project/effort/twin-primes`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "PROMISING", title: "Twin Primes (v2)" }),
    });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.effort.status).toBe("PROMISING");
    expect(r.effort.title).toBe("Twin Primes (v2)");
  });

  it("document r/w + snapshot + versions list end-to-end", async () => {
    // document write
    await fetch(`${base}/api/projects/my-first-project/effort/twin-primes/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ document: "# Twin Primes\n\nDraft" }),
    });
    const doc1 = await (
      await fetch(`${base}/api/projects/my-first-project/effort/twin-primes/document`)
    ).json();
    expect(doc1.document).toContain("Twin Primes");

    // snapshot
    const snap = await (
      await fetch(`${base}/api/projects/my-first-project/effort/twin-primes/snapshot`, {
        method: "POST",
      })
    ).json();
    expect(snap.version).toBe(1);

    const versions = await (
      await fetch(`${base}/api/projects/my-first-project/effort/twin-primes/versions`)
    ).json();
    expect(versions.versions).toEqual([1]);
  });

  it("file r/w with nested path", async () => {
    await fetch(
      `${base}/api/projects/my-first-project/effort/twin-primes/files/proofs/sieve.lean`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "theorem t : 1 = 1 := by rfl" }),
      },
    );
    const r = await (
      await fetch(`${base}/api/projects/my-first-project/effort/twin-primes/files/proofs/sieve.lean`)
    ).json();
    expect(r.content).toContain("rfl");

    const list = await (
      await fetch(`${base}/api/projects/my-first-project/effort/twin-primes/files`)
    ).json();
    expect(list.files).toContain("proofs/sieve.lean");
  });

  it("rejects file path traversal on PUT", async () => {
    const res = await fetch(
      `${base}/api/projects/my-first-project/effort/twin-primes/files/${encodeURIComponent("../escape.txt")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "PWNED" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("404s the effort for an unknown slug", async () => {
    const res = await fetch(`${base}/api/projects/my-first-project/effort/no-such-thing`);
    expect(res.status).toBe(404);
  });
});

describe("effort status state-machine + relations (GAP #9)", () => {
  let effSlug: string;
  let targetSlug: string;

  beforeAll(async () => {
    // Create two efforts we can drive transitions / edges on.
    const r1 = await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Gap9 Source", type: "PROOF_ATTEMPT" }),
    });
    const j1 = await r1.json();
    effSlug = j1.slug;
    const r2 = await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Gap9 Target", type: "FORMALIZATION" }),
    });
    const j2 = await r2.json();
    targetSlug = j2.slug;
  });

  it("valid transition DRAFT → PROPOSED writes statusHistory", async () => {
    const r = await fetch(`${base}/api/projects/my-first-project/effort/${effSlug}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "PROPOSED" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.metadata.status).toBe("PROPOSED");
    expect(body.entry.from).toBe("DRAFT");
    expect(body.entry.to).toBe("PROPOSED");
  });

  it("invalid transition returns 400 with the allowed list", async () => {
    const r = await fetch(`${base}/api/projects/my-first-project/effort/${effSlug}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "VERIFIED" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.allowed).toBeDefined();
    expect(body.error).toMatch(/invalid transition/);
  });

  it("bogus 'to' returns 400 with the EFFORT_STATUSES list", async () => {
    const r = await fetch(`${base}/api/projects/my-first-project/effort/${effSlug}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "NOPE" }),
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/'to' must be one of/);
  });

  it("DEAD_END requires reason", async () => {
    // Drive a fresh effort through PROPOSED then DEAD_END w/o reason.
    const create = await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "DeadEnd Source", type: "PROOF_ATTEMPT" }),
    });
    const { slug } = await create.json();
    const fail = await fetch(`${base}/api/projects/my-first-project/effort/${slug}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "DEAD_END" }),
    });
    expect(fail.status).toBe(400);
    const ok = await fetch(`${base}/api/projects/my-first-project/effort/${slug}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "DEAD_END", reason: "hits a wall" }),
    });
    expect(ok.status).toBe(200);
  });

  it("add + list + delete a depends_on edge", async () => {
    const add = await fetch(
      `${base}/api/projects/my-first-project/effort/${effSlug}/relations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: targetSlug, type: "depends_on", description: "smoke" }),
      },
    );
    expect(add.status).toBe(201);
    const { relation } = await add.json();
    expect(relation.id).toBeTruthy();

    const list = await fetch(
      `${base}/api/projects/my-first-project/effort/${effSlug}/relations`,
    );
    const j = await list.json();
    expect(j.relations.some((e: any) => e.id === relation.id)).toBe(true);

    const incoming = await fetch(
      `${base}/api/projects/my-first-project/effort/${targetSlug}/dependents`,
    );
    const ji = await incoming.json();
    expect(ji.dependents.some((e: any) => e.id === relation.id)).toBe(true);

    const graph = await fetch(`${base}/api/projects/my-first-project/efforts/graph`);
    const jg = await graph.json();
    expect(jg.edges.some((e: any) => e.id === relation.id)).toBe(true);

    const del = await fetch(
      `${base}/api/projects/my-first-project/effort/${effSlug}/relations/${relation.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);
  });

  it("rejects an invalid relation type", async () => {
    const r = await fetch(
      `${base}/api/projects/my-first-project/effort/${effSlug}/relations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: targetSlug, type: "bogus" }),
      },
    );
    expect(r.status).toBe(400);
  });

  it("rejects self-relation", async () => {
    const r = await fetch(
      `${base}/api/projects/my-first-project/effort/${effSlug}/relations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: effSlug, type: "depends_on" }),
      },
    );
    expect(r.status).toBe(400);
  });

  it("404s a relation against a missing target effort", async () => {
    const r = await fetch(
      `${base}/api/projects/my-first-project/effort/${effSlug}/relations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "no-such-effort", type: "depends_on" }),
      },
    );
    expect(r.status).toBe(404);
  });

  it("SUPERSEDED auto-wires a supersedes relation", async () => {
    // Fresh source effort + target so this test is self-contained.
    const s1 = await (await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Supr Source", type: "PROOF_ATTEMPT" }),
    })).json();
    const s2 = await (await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Supr Target", type: "PROOF_ATTEMPT" }),
    })).json();
    const tr = await fetch(
      `${base}/api/projects/my-first-project/effort/${s1.slug}/status`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "SUPERSEDED", supersededBy: s2.slug, reason: "v2" }),
      },
    );
    expect(tr.status).toBe(200);
    const edges = await (await fetch(
      `${base}/api/projects/my-first-project/effort/${s1.slug}/relations`,
    )).json();
    expect(edges.relations.some((e: any) => e.to === s2.slug && e.type === "supersedes")).toBe(true);
  });
});


describe("scoped chat (T1-C)", () => {
  /** Drive the SSE stream and return the parsed `data:` payloads. */
  async function postChat(url: string, payload: any): Promise<any[]> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice("data:".length).trim()));
  }

  it("global-chat: send + list + read + persist + drop", async () => {
    const conversationId = "global-conv-1";
    const events = await postChat(`${base}/api/global-chat`, {
      message: "hello global",
      conversationId,
    });
    const session = events.find((e) => e.scope);
    expect(session.scope.kind).toBe("global");

    const list = await (await fetch(`${base}/api/global-chat`)).json();
    expect(list.conversations.map((c: any) => c.id)).toContain(conversationId);

    const detail = await (
      await fetch(`${base}/api/global-chat/${conversationId}`)
    ).json();
    expect(detail.history.some((m: any) => m.role === "user" && m.content === "hello global")).toBe(true);
    expect(detail.history.some((m: any) => m.role === "assistant")).toBe(true);

    // On disk: jsonl persists.
    const onDisk = await fs.readFile(
      path.join(workspace, ".mathran/global-chat", `${conversationId}.jsonl`),
      "utf-8",
    );
    expect(onDisk).toContain("hello global");

    // Drop
    const drop = await fetch(`${base}/api/global-chat/${conversationId}`, { method: "DELETE" });
    expect(drop.status).toBe(200);
    const after = await (await fetch(`${base}/api/global-chat/${conversationId}`)).json();
    expect(after.error).toBeTruthy();
  });

  it("project chat lives under the project's own jsonl, separate from global", async () => {
    const cid = "project-conv-1";
    await postChat(`${base}/api/projects/my-first-project/chat`, {
      message: "hi project",
      conversationId: cid,
    });
    // Disk:
    const onDisk = await fs.readFile(
      path.join(workspace, "projects/my-first-project/chat", `${cid}.jsonl`),
      "utf-8",
    );
    expect(onDisk).toContain("hi project");

    // Listing the project scope sees it; global does not.
    const projList = await (await fetch(`${base}/api/projects/my-first-project/chat`)).json();
    expect(projList.conversations.map((c: any) => c.id)).toContain(cid);
    const globList = await (await fetch(`${base}/api/global-chat`)).json();
    expect(globList.conversations.map((c: any) => c.id)).not.toContain(cid);
  });

  it("effort chat lives under the effort's own jsonl, separate from project + global", async () => {
    // Create an effort under my-first-project first.
    await fetch(`${base}/api/projects/my-first-project/efforts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Effort Alpha", type: "PROOF_ATTEMPT" }),
    });
    const cid = "effort-conv-1";
    const events = await postChat(
      `${base}/api/projects/my-first-project/effort/effort-alpha/chat`,
      { message: "hi effort", conversationId: cid },
    );
    expect(events[0].scope.kind).toBe("effort");
    expect(events[0].scope.effortSlug).toBe("effort-alpha");

    const onDisk = await fs.readFile(
      path.join(
        workspace,
        "projects/my-first-project/efforts/effort-alpha/chat",
        `${cid}.jsonl`,
      ),
      "utf-8",
    );
    expect(onDisk).toContain("hi effort");
  });

  it("multi-turn history persists across separate POSTs (BUG #6 still holds)", async () => {
    const cid = "multi-turn-1";
    await postChat(`${base}/api/global-chat`, {
      message: "I like snow mountains",
      conversationId: cid,
    });
    const detail = await (await fetch(`${base}/api/global-chat/${cid}`)).json();
    expect(detail.history.filter((m: any) => m.role === "user").length).toBe(1);

    await postChat(`${base}/api/global-chat`, {
      message: "what did I just say?",
      conversationId: cid,
    });
    const after = await (await fetch(`${base}/api/global-chat/${cid}`)).json();
    expect(after.history.filter((m: any) => m.role === "user").length).toBe(2);
  });

  it("rejects effort chat for an effort under an unknown project", async () => {
    const res = await fetch(`${base}/api/projects/no-such-project/effort/x/chat`);
    expect(res.status).toBe(404);
  });

  it("legacy /api/chat still streams (back-compat with v0.1.0-alpha)", async () => {
    const events = await postChat(`${base}/api/chat`, {
      message: "legacy hello",
      sessionId: "legacy-1",
    });
    expect(events.find((e) => e.type === "done")).toBeTruthy();
  });

  it("v0.5 §2 Gap #6: project-scoped POST resolves workspace to <ws>/projects/<slug>", async () => {
    // Spin up an isolated server whose chatSessionFactory captures the
    // options it was called with. This is the simplest way to assert that
    // serve.ts threads a scope-narrowed workspace through to ChatSession
    // (without exercising real fs tools or a real LLM).
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-serve-scope-"));
    // Seed config + project dir so the project-chat scope check passes.
    await fs.writeFile(path.join(ws, "config.toml"), 'defaultModel = "openai/gpt-4o"\n', "utf-8");
    await fs.mkdir(path.join(ws, "projects", "scoped-proj"), { recursive: true });

    const captured: Array<{ scope?: any; model?: string }> = [];
    const localServer = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace: ws,
      chatSessionFactory: (opts) => {
        captured.push({ scope: opts.scope, model: opts.model });
        return new ChatSession({
          llm: fakeLlm("scoped"),
          model: opts.model,
        });
      },
    });
    try {
      const res = await fetch(`${localServer.url}/api/projects/scoped-proj/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi", conversationId: "scope-c1" }),
      });
      expect(res.status).toBe(200);
      await res.text(); // drain SSE stream

      // Factory must have been invoked with the project scope.
      expect(captured.length).toBeGreaterThan(0);
      const call = captured[0];
      expect(call.scope).toEqual({ kind: "project", projectSlug: "scoped-proj" });
    } finally {
      await localServer.close();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("v0.5 §2 Gap #6: default factory wires full 6-builtin toolkit + scope-narrowed workspace", async () => {
    // White-box check: the default factory must produce a ChatSession whose
    // workspace is the scope-narrowed dir (so fs builtins land inside
    // <ws>/projects/<slug>/, not at <ws>/), AND whose builtin toolkit
    // matches the CLI chat/goal surface (6 tools).
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-serve-scope-"));
    await fs.writeFile(path.join(ws, "config.toml"), 'defaultModel = "openai/gpt-4o"\n', "utf-8");
    await fs.mkdir(path.join(ws, "projects", "toolsproj"), { recursive: true });
    try {
      const factory = defaultSessionFactory(ws);
      const session = factory({
        scope: { kind: "project", projectSlug: "toolsproj" },
      });
      // The session must own write_file/read_file/bash/edit_file/search/read_file_summary.
      const tools = (session as any).tools as Array<{ name: string }>;
      const names = new Set(tools.map((t) => t.name));
      for (const expected of ["lean_check", "bash", "read_file", "write_file", "edit_file", "search", "read_file_summary"]) {
        expect(names.has(expected), `expected tool ${expected} in default factory output (got: ${[...names].join(",")})`).toBe(true);
      }
      // The session's workspace must be the project dir.
      expect((session as any).workspace).toBe(path.join(ws, "projects", "toolsproj"));

      // Effort scope narrows further.
      const effSession = factory({
        scope: { kind: "effort", projectSlug: "toolsproj", effortSlug: "effort-x" },
      });
      expect((effSession as any).workspace).toBe(
        path.join(ws, "projects", "toolsproj", "efforts", "effort-x"),
      );

      // Global scope falls back to workspace root.
      const globSession = factory({ scope: { kind: "global" } });
      expect((globSession as any).workspace).toBe(ws);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

describe("goal REST (GAP #11)", () => {
  it("POST /api/goals creates a goal record", async () => {
    const res = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: "test goal",
        budgetTokens: 5000,
        maxRounds: 3,
      }),
    });
    expect(res.status).toBe(201);
    const { goal } = await res.json();
    expect(goal.id).toBeTruthy();
    expect(goal.objective).toBe("test goal");
    expect(goal.scope).toEqual({ kind: "global" });
    expect(goal.budget.tokensMax).toBe(5000);
    expect(goal.budget.roundsMax).toBe(3);
    expect(goal.status).toBe("active");
  });

  it("POST /api/goals 400s on missing objective", async () => {
    const res = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/goals 400s on bad scope shape", async () => {
    const res = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "x", scope: { kind: "effort", projectSlug: "p" } }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/goals 400s on traversal slug in scope", async () => {
    const res = await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "x", scope: { kind: "project", projectSlug: "../escape" } }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/goals lists active+paused by default; ?all=1 shows ended", async () => {
    // Make two goals, cancel one.
    const r1 = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "alive" }),
    })).json();
    const r2 = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "cancelme" }),
    })).json();
    await fetch(`${base}/api/goals/${r2.goal.id}/cancel`, { method: "POST" });

    const defaultList = await (await fetch(`${base}/api/goals`)).json();
    const ids = defaultList.goals.map((g: any) => g.id);
    expect(ids).toContain(r1.goal.id);
    expect(ids).not.toContain(r2.goal.id);

    const allList = await (await fetch(`${base}/api/goals?all=1`)).json();
    const allIds = allList.goals.map((g: any) => g.id);
    expect(allIds).toContain(r1.goal.id);
    expect(allIds).toContain(r2.goal.id);
  });

  it("GET /api/goals/:id round-trips", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "round-trip" }),
    })).json();
    const r = await (await fetch(`${base}/api/goals/${goal.id}`)).json();
    expect(r.goal.id).toBe(goal.id);
  });

  it("GET /api/goals/:id 404s missing goal", async () => {
    const res = await fetch(`${base}/api/goals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`);
    expect(res.status).toBe(404);
  });

  it("pause + cancel happy path; double-cancel rejected", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "pause-me" }),
    })).json();

    const paused = await (await fetch(`${base}/api/goals/${goal.id}/pause`, {
      method: "POST",
    })).json();
    expect(paused.goal.status).toBe("paused");

    // Re-pausing rejected.
    const rePause = await fetch(`${base}/api/goals/${goal.id}/pause`, { method: "POST" });
    expect(rePause.status).toBe(400);

    // Cancel a different goal (cancel of paused is rejected by "already-ended" guard? no — only ended states.)
    // Our guard: cancel is allowed on active and paused, rejected on complete/failed/cancelled/exhausted.
    const cancelled = await (await fetch(`${base}/api/goals/${goal.id}/cancel`, {
      method: "POST",
    })).json();
    expect(cancelled.goal.status).toBe("cancelled");

    const reCancel = await fetch(`${base}/api/goals/${goal.id}/cancel`, { method: "POST" });
    expect(reCancel.status).toBe(400);
  });

  it("POST /api/goals/:id/run rejects an ended goal", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "ended" }),
    })).json();
    await fetch(`${base}/api/goals/${goal.id}/cancel`, { method: "POST" });
    const res = await fetch(`${base}/api/goals/${goal.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─── v0.16 §3: thread / by-conversation endpoints ────────────────────────
describe("Goal thread endpoints (v0.16 §3)", () => {
  it("GET /api/goals/by-conversation/:id 404s on a plain (non-goal) chat", async () => {
    const res = await fetch(`${base}/api/goals/by-conversation/never-created-conv`);
    expect(res.status).toBe(404);
  });

  it("GET /api/goals/by-conversation finds the owning goal once a round runs", async () => {
    const created = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: "unit test goal",
        scope: { kind: "global" },
        model: "echo",
      }),
    })).json();
    expect(created.goal?.id).toBeTruthy();
    await fetch(`${base}/api/goals/${created.goal.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    const after = await (await fetch(`${base}/api/goals/${created.goal.id}`)).json();
    const convId = after.goal.conversationIds[0];
    expect(convId).toBeTruthy();

    const lookup = await fetch(`${base}/api/goals/by-conversation/${convId}`);
    expect(lookup.status).toBe(200);
    const body = await lookup.json();
    expect(body.goalId).toBe(created.goal.id);
  });

  it("GET /api/goals/:id/thread returns goal + history + subGoals (empty)", async () => {
    const created = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: "thread shape test",
        scope: { kind: "global" },
        model: "echo",
      }),
    })).json();
    await fetch(`${base}/api/goals/${created.goal.id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    const res = await fetch(`${base}/api/goals/${created.goal.id}/thread`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.goal.id).toBe(created.goal.id);
    expect(body.primaryConversationId).toBeTruthy();
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.subGoals).toEqual([]);
  });

  it("GET /api/goals/:id/thread 404s on unknown id", async () => {
    const res = await fetch(`${base}/api/goals/does-not-exist/thread`);
    expect(res.status).toBe(404);
  });
});

// ─── v0.16 §9 audit #6: active-plan endpoint for the goal drawer ────────────
describe("GET /api/goals/:goalId/plan (v0.16 §9 audit #6)", () => {
  it("400s on a malformed goal id (no traversal)", async () => {
    const res = await fetch(`${base}/api/goals/..%2Fetc/plan`);
    // The router applies the safe-id regex before touching the filesystem,
    // so the response is a JSON 400, not a 404 / silent disk error.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid goalId/);
  });

  it("404s on an unknown but well-formed goal id", async () => {
    const res = await fetch(`${base}/api/goals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/plan`);
    expect(res.status).toBe(404);
  });

  it("returns hasPlan=false when the goal exists but no plan file was written", async () => {
    // Created goal has no .plan.md on disk (no round has run; bootstrap
    // wouldn't have fired yet anyway because /api/goals doesn't drive one).
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "plan endpoint: no file yet" }),
    })).json();

    const res = await fetch(`${base}/api/goals/${goal.id}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasPlan).toBe(false);
    expect(body.planPath).toBeNull();
    expect(body.body).toBeNull();
    expect(body.steps).toEqual([]);
  });

  it("returns parsed steps when a plan file is on disk", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "plan endpoint: seeded plan" }),
    })).json();

    // Seed a plan file directly on disk — same path layout the runner uses.
    // We hand-craft a body covering both "done" and "todo" markers across
    // two sections to verify the parser numbers items globally (not per
    // section) as documented in src/core/goal/plan.ts.
    const planRel = path.join(".mathran", "goals", `${goal.id}.plan.md`);
    const planAbs = path.join(workspace, planRel);
    await fs.mkdir(path.dirname(planAbs), { recursive: true });
    await fs.writeFile(
      planAbs,
      [
        "# Plan",
        "",
        "## Steps",
        "",
        "- [x] read the spec",
        "- [ ] write the code",
        "",
        "## Acceptance",
        "",
        "- [ ] tests pass",
        "",
      ].join("\n"),
      "utf-8",
    );

    const res = await fetch(`${base}/api/goals/${goal.id}/plan`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasPlan).toBe(true);
    expect(typeof body.body).toBe("string");
    expect(body.body).toContain("## Steps");
    expect(body.body).toContain("## Acceptance");
    // Path is workspace-relative, not absolute.
    expect(body.planPath).toBe(planRel);
    // Global 1-based indexing across both sections.
    expect(body.steps).toHaveLength(3);
    expect(body.steps[0]).toMatchObject({ index: 1, status: "done", text: "read the spec" });
    expect(body.steps[1]).toMatchObject({ index: 2, status: "todo", text: "write the code" });
    expect(body.steps[2]).toMatchObject({ index: 3, status: "todo", text: "tests pass" });
  });
});

describe("POST /api/goals/:id/interrupt (v0.2 §7)", () => {
  it("aborts an in-flight round and returns 200, leaving the goal active", async () => {
    // A provider that streams one chunk then blocks until the round is aborted.
    const slowLlm: LLMProvider = {
      async describe() {
        return { name: "slow" };
      },
      async chat(): Promise<LLMResponse> {
        return {
          stream() {
            return (async function* () {
              yield { type: "text", delta: "thinking" } as LLMStreamChunk;
              await new Promise<void>(() => {});
              yield { type: "done", finishReason: "stop" } as LLMStreamChunk;
            })();
          },
        };
      },
    };

    const local = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      goalLlmFactory: () => slowLlm,
    });
    try {
      const { goal } = await (await fetch(`${local.url}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "long running" }),
      })).json();

      // Kick off the round but don't await — it will block in the slow stream.
      const runPromise = fetch(`${local.url}/api/goals/${goal.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      // Wait until the round has registered its AbortController, then interrupt.
      let interrupt!: Response;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        interrupt = await fetch(`${local.url}/api/goals/${goal.id}/interrupt`, { method: "POST" });
        if (interrupt.status === 200) break;
      }
      expect(interrupt.status).toBe(200);
      expect(await interrupt.json()).toMatchObject({ interrupted: true });

      // The blocked round now unwinds and reports the abort.
      const runRes = await runPromise;
      expect(runRes.status).toBe(200);
      expect(await runRes.json()).toMatchObject({ aborted: true });

      // Goal status is left active (NOT failed) so it can be resumed.
      const after = await (await fetch(`${local.url}/api/goals/${goal.id}`)).json();
      expect(after.goal.status).toBe("active");
    } finally {
      await local.close();
    }
  });

  it("returns 404 when there is no in-flight round", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "idle" }),
    })).json();
    const res = await fetch(`${base}/api/goals/${goal.id}/interrupt`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// v0.17 W8: GoalRunStatusPanel support — status projection, abort flag,
// resume, and heartbeat stamping. These endpoints power the status panel
// that the SPA polls every ~3s while a goal-loop is active.
describe("goal status + abort/resume (v0.17 W8)", () => {
  it("GET /api/goals/:id/status returns the projected status payload", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: "projected status fields",
        scope: "global",
        budgetTokens: 5000,
        maxRounds: 8,
      }),
    })).json();

    const res = await fetch(`${base}/api/goals/${goal.id}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: goal.id,
      objective: "projected status fields",
      status: "active",
      round: 0,
      roundsMax: 8,
      tokensUsed: 0,
      tokensMax: 5000,
      toolCount: 0,
      resumeCount: 0,
      abortRequested: false,
    });
    // Heartbeat hasn't been stamped yet (no round has run) so it's null.
    expect(body.heartbeatAt).toBeNull();
    expect(body.latestSummary).toBeNull();
  });

  it("GET /api/goals/:id/status 404s on unknown goal", async () => {
    const res = await fetch(
      `${base}/api/goals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/status`,
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/goals/:id/status 400s on a path-traversing id", async () => {
    const res = await fetch(`${base}/api/goals/..%2Fetc/status`);
    expect(res.status).toBe(400);
  });

  it("runner stamps heartbeatAt at the top of every round", async () => {
    // Use a dedicated server with a fake LLM so the heartbeat test
    // doesn't depend on the real ModelRouter (which would fail with the
    // dummy `sk-secret` key seeded in the outer beforeAll).
    const local = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      goalLlmFactory: () => fakeLlm("ok"),
    });
    try {
      const { goal } = await (await fetch(`${local.url}/api/goals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "heartbeat round", scope: "global" }),
      })).json();
      const before = Date.now();
      const runRes = await fetch(`${local.url}/api/goals/${goal.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(runRes.status).toBe(200);
      const status = await (
        await fetch(`${local.url}/api/goals/${goal.id}/status`)
      ).json();
      expect(typeof status.heartbeatAt).toBe("number");
      // Heartbeat is stamped at the top of the round; the window we accept
      // is generous so a slow CI host can't flake the test.
      expect(status.heartbeatAt).toBeGreaterThanOrEqual(before - 1000);
      expect(status.heartbeatAt).toBeLessThanOrEqual(Date.now() + 1000);
      // latestSummary is best-effort — the fake LLM emits a single token
      // but the runner may finish the round before any `text` step lands
      // depending on plan-bootstrap behaviour. We only assert the field
      // is present in the response payload.
      expect("latestSummary" in status).toBe(true);
    } finally {
      await local.close();
    }
  });

  it("POST /api/goals/:id/abort sets meta.abortRequested + reports inflight: false when idle", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "abort idle goal", scope: "global" }),
    })).json();

    const abort = await fetch(`${base}/api/goals/${goal.id}/abort`, {
      method: "POST",
    });
    expect(abort.status).toBe(200);
    const abortBody = await abort.json();
    expect(abortBody).toMatchObject({ aborted: true, inflight: false });
    expect(abortBody.goal.meta?.abortRequested).toBe(true);

    // GET status reflects the flag; the goal is still "active" (not
    // terminal) but the panel will see abortRequested === true.
    const status = await (await fetch(`${base}/api/goals/${goal.id}/status`)).json();
    expect(status.abortRequested).toBe(true);
    expect(status.status).toBe("active");
  });

  it("POST /api/goals/:id/abort 404s on unknown id", async () => {
    const res = await fetch(
      `${base}/api/goals/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/abort`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/goals/:id/abort 400s on a path-traversing id", async () => {
    const res = await fetch(`${base}/api/goals/..%2Fetc/abort`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/goals/:id/resume clears abortRequested cleanly", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "resume after abort", scope: "global" }),
    })).json();

    // Abort before any round runs.
    await fetch(`${base}/api/goals/${goal.id}/abort`, { method: "POST" });
    let status = await (await fetch(`${base}/api/goals/${goal.id}/status`)).json();
    expect(status.abortRequested).toBe(true);

    // Resume clears the flag.
    const resume = await fetch(`${base}/api/goals/${goal.id}/resume`, {
      method: "POST",
    });
    expect(resume.status).toBe(200);
    const resumeBody = await resume.json();
    expect(resumeBody.goal.meta?.abortRequested).toBe(false);

    // GET status confirms the flag is cleared.
    status = await (await fetch(`${base}/api/goals/${goal.id}/status`)).json();
    expect(status.abortRequested).toBe(false);
  });

  it("POST /api/goals/:id/resume rejects terminal statuses", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "resume terminal", scope: "global" }),
    })).json();
    await fetch(`${base}/api/goals/${goal.id}/cancel`, { method: "POST" });
    const res = await fetch(`${base}/api/goals/${goal.id}/resume`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/goals/:id/resume flips paused goals back to active", async () => {
    const { goal } = await (await fetch(`${base}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "resume paused", scope: "global" }),
    })).json();
    await fetch(`${base}/api/goals/${goal.id}/pause`, { method: "POST" });
    const before = await (await fetch(`${base}/api/goals/${goal.id}`)).json();
    expect(before.goal.status).toBe("paused");

    const resume = await fetch(`${base}/api/goals/${goal.id}/resume`, {
      method: "POST",
    });
    expect(resume.status).toBe(200);
    const resumeBody = await resume.json();
    expect(resumeBody.goal.status).toBe("active");
  });
});

describe("POST /api/global-chat/:id/compact (v0.2 §5)", () => {
  it("returns 404 for an unknown conversation", async () => {
    const res = await fetch(`${base}/api/global-chat/no-such-conv/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 + stats for a real conversation", async () => {
    // Seed a conversation with enough turns to compact.
    const cid = "compact-rest-1";
    // Use the global-chat POST to create one turn. The fake LLM streams "hi there".
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/api/global-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `q${i}`, conversationId: cid }),
      });
      expect(res.status).toBe(200);
      // Drain the SSE stream so the server-side flush completes before next POST.
      await res.text();
    }
    const res = await fetch(`${base}/api/global-chat/${cid}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepRecentRounds: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stats).toBeTruthy();
    expect(typeof body.stats.originalTokenCount).toBe("number");
    expect(typeof body.stats.newTokenCount).toBe("number");
    // We had 4 user rounds; keep 1 → drop at least the remaining 3.
    expect(body.stats.droppedRoundCount).toBeGreaterThanOrEqual(3);
  });
});

describe("GET /api/global-chat/:id/usage (v0.3 §19)", () => {
  it("returns zeroed stats for an empty / unknown conversation", async () => {
    const res = await fetch(`${base}/api/global-chat/no-such-usage-conv/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toBe(0);
    expect(body.messages).toBe(0);
    expect(typeof body.contextWindow).toBe("number");
    expect(body.contextWindow).toBeGreaterThan(0);
    expect(body.percentage).toBe(0);
    expect(body.warning).toBeNull();
  });

  it("returns reasonable numbers for a conversation with content", async () => {
    // Seed a conversation through global-chat (fake LLM streams "hi there").
    const cid = "usage-rest-1";
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/global-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: `hello world ${i}`, conversationId: cid }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    const res = await fetch(`${base}/api/global-chat/${cid}/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toBeGreaterThan(0);
    expect(body.messages).toBeGreaterThanOrEqual(6); // 3 user + 3 assistant at least
    expect(typeof body.contextWindow).toBe("number");
    // percentage matches tokens / contextWindow (within rounding tolerance).
    expect(body.percentage).toBeCloseTo((body.tokens / body.contextWindow) * 100, 1);
    // Tiny conversation → no warning.
    expect(body.warning).toBeNull();
  });

  it("honors the model query hint when picking contextWindow", async () => {
    // TODO-2 §5.6 / C7 — resolveContextWindow now delegates to the
    // copilot-models-cache, which returns the REAL cap from copilot's
    // /models endpoint (with a hardcoded fallback snapshot). gpt-4o's
    // real cap is 64K, NOT the previously-hardcoded 128K guess.
    const a = await fetch(
      `${base}/api/global-chat/no-such-usage-conv/usage?model=gpt-4o`,
    );
    expect(a.status).toBe(200);
    const aBody = await a.json();
    expect(aBody.contextWindow).toBe(64_000);

    // claude-3-5-sonnet isn't in the snapshot table → falls through to
    // the 200K default for unknown models (sensible mid-range).
    const b = await fetch(
      `${base}/api/global-chat/no-such-usage-conv/usage?model=claude-3-5-sonnet-20240620`,
    );
    expect(b.status).toBe(200);
    const bBody = await b.json();
    expect(bBody.contextWindow).toBe(200_000);
  });

  it("rejects an invalid conversation id", async () => {
    // Slug containing path-separator-ish chars must fail isSafeSlug.
    const res = await fetch(`${base}/api/global-chat/_leading-underscore/usage`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid conversation id/i);
  });
});

describe("persistent context injection (v0.15 §1)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-persist-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns base prompt unchanged when MEMORY.md/AGENTS.md are absent", () => {
    const out = buildScopedSystemPrompt(undefined, tmp);
    expect(out).toContain("You are mathran");
    expect(out).not.toContain("# Persistent context");
  });

  it("appends MEMORY.md content under a labeled section", async () => {
    await fs.writeFile(path.join(tmp, "MEMORY.md"), "# my long-term memory\n\n- prefer concise answers\n");
    const out = buildScopedSystemPrompt(undefined, tmp);
    expect(out).toContain("# Persistent context");
    expect(out).toContain("## MEMORY.md (workspace root)");
    expect(out).toContain("prefer concise answers");
  });

  it("appends both MEMORY.md and AGENTS.md when both exist", async () => {
    await fs.writeFile(path.join(tmp, "MEMORY.md"), "mem alpha");
    await fs.writeFile(path.join(tmp, "AGENTS.md"), "agents beta");
    const out = buildScopedSystemPrompt(undefined, tmp);
    expect(out).toContain("mem alpha");
    expect(out).toContain("agents beta");
    expect(out.indexOf("MEMORY.md")).toBeLessThan(out.indexOf("AGENTS.md"));
  });

  it("truncates files larger than 64 KiB with a marker", async () => {
    const big = "x".repeat(64 * 1024 + 5000);
    await fs.writeFile(path.join(tmp, "MEMORY.md"), big);
    const out = buildScopedSystemPrompt(undefined, tmp);
    expect(out).toContain("... [truncated at");
    // Pull out the LONGEST contiguous run of 'x' chars (the embedded
    // file body) and assert that was capped at 64 KiB — robust against
    // any future system-prompt fragment additions that change
    // `out.length`. We use a global regex + reduce so a stray single
    // 'x' character anywhere else in the prompt doesn't shadow the
    // real run we care about.
    const xRuns = out.match(/x+/g) ?? [];
    expect(xRuns.length).toBeGreaterThan(0);
    const longest = xRuns.reduce((a, b) => (a.length >= b.length ? a : b));
    expect(longest.length).toBe(64 * 1024);
  });

  it("ignores zero-byte files", async () => {
    await fs.writeFile(path.join(tmp, "MEMORY.md"), "");
    const out = buildScopedSystemPrompt(undefined, tmp);
    expect(out).not.toContain("# Persistent context");
  });

  it("silently survives a workspace dir that doesn't exist", () => {
    const out = buildScopedSystemPrompt(undefined, path.join(tmp, "nope"));
    expect(out).toContain("You are mathran");
    expect(out).not.toContain("# Persistent context");
  });

  it("preserves the scope hint (project) even when context is appended", async () => {
    await fs.writeFile(path.join(tmp, "MEMORY.md"), "recall me");
    const out = buildScopedSystemPrompt({ kind: "project", projectSlug: "my-proj" }, tmp);
    expect(out).toContain('chatting inside project "my-proj"');
    expect(out).toContain("recall me");
  });

  it("appendPersistentContext is idempotent on missing files", () => {
    const base = "You are X.";
    const out = appendPersistentContext(base, path.join(tmp, "absent"), undefined);
    expect(out).toBe(base);
  });
});

describe("plan REST (v0.16 §9 audit #2)", () => {
  /**
   * Fake LLM that streams a realistic plan-mode markdown reply (one plan
   * with every required section) and then finishes. Used to exercise the
   * POST → SSE → accept happy path end-to-end without touching a real
   * provider.
   */
  function planLlm(reply: string): LLMProvider {
    return {
      async describe() { return { name: "fake-plan" }; },
      async chat(_req: LLMRequest): Promise<LLMResponse> {
        return {
          async *stream(): AsyncIterable<LLMStreamChunk> {
            // Chunk every 16 chars so we can observe multiple `token` frames.
            const step = 16;
            for (let i = 0; i < reply.length; i += step) {
              yield { type: "text", delta: reply.slice(i, i + step) };
            }
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
          // ignore unparseable trailing frame
        }
      }
    }
    return out;
  }

  const PLAN_MD = [
    "# Plan",
    "",
    "## Approach",
    "Stub out the parser, then wire it up.",
    "",
    "## Steps",
    "- [ ] Sketch the API",
    "- [ ] Implement",
    "- [ ] Add tests",
    "",
    "## Key files",
    "- src/foo.ts",
    "- src/bar.ts",
    "",
    "## Risks",
    "- Might break BUG #42.",
    "",
    "## Acceptance",
    "- [ ] `npm test` is green.",
    "",
  ].join("\n");

  it("POST → SSE → done → accept saves the plan", async () => {
    const local = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      goalLlmFactory: () => planLlm(PLAN_MD),
    });
    try {
      const created = await fetch(`${local.url}/api/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "Plan the world." }),
      });
      expect(created.status).toBe(202);
      const { planId } = (await created.json()) as { planId: string };
      expect(planId).toMatch(/^plan-[a-z0-9]+$/);

      const stream = await fetch(`${local.url}/api/plans/${planId}/stream`);
      expect(stream.status).toBe(200);
      const frames = await drainSSE(stream);
      const eventTypes = frames.map((f) => f.event);
      expect(eventTypes).toContain("token");
      expect(eventTypes).toContain("step");
      expect(eventTypes[eventTypes.length - 1]).toBe("done");

      const doneFrame = frames[frames.length - 1]!;
      expect(doneFrame.data.planId).toBe(planId);
      expect(doneFrame.data.aborted).toBe(false);
      expect(doneFrame.data.body).toContain("## Approach");
      expect(doneFrame.data.body).toContain("## Acceptance");

      const fetched = await (await fetch(`${local.url}/api/plans/${planId}`)).json();
      expect(fetched.plan.status).toBe("draft");
      expect(fetched.plan.body).toContain("## Steps");

      const accept = await fetch(`${local.url}/api/plans/${planId}/accept`, { method: "POST" });
      expect(accept.status).toBe(200);
      const acceptJson = (await accept.json()) as { ok: boolean; location: string; plan: any };
      expect(acceptJson.ok).toBe(true);
      expect(acceptJson.plan.status).toBe("accepted");
      expect(acceptJson.location).toContain(".mathran/plans/");
      expect(acceptJson.location).toContain(planId);

      // Double-accept is idempotent (still 200, still accepted).
      const reAccept = await fetch(`${local.url}/api/plans/${planId}/accept`, { method: "POST" });
      expect(reAccept.status).toBe(200);
    } finally {
      await local.close();
    }
  });

  it("POST → SSE → done → reject moves the plan to rejected", async () => {
    const local = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace,
      goalLlmFactory: () => planLlm(PLAN_MD),
    });
    try {
      const created = await fetch(`${local.url}/api/plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "Reject me." }),
      });
      const { planId } = (await created.json()) as { planId: string };
      await drainSSE(await fetch(`${local.url}/api/plans/${planId}/stream`));

      const reject = await fetch(`${local.url}/api/plans/${planId}/reject`, { method: "POST" });
      expect(reject.status).toBe(200);
      const { ok, plan } = (await reject.json()) as { ok: boolean; plan: any };
      expect(ok).toBe(true);
      expect(plan.status).toBe("rejected");

      // Cannot accept a rejected plan.
      const accept = await fetch(`${local.url}/api/plans/${planId}/accept`, { method: "POST" });
      expect(accept.status).toBe(400);
    } finally {
      await local.close();
    }
  });

  it("POST /api/plans 400s on missing objective", async () => {
    const res = await fetch(`${base}/api/plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objective: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/plans/:id 404s for unknown plan", async () => {
    const res = await fetch(`${base}/api/plans/plan-deadbe`);
    expect(res.status).toBe(404);
  });

  it("GET /api/plans/:id 400s on a malformed id (no traversal)", async () => {
    const res = await fetch(`${base}/api/plans/..%2Fetc`);
    // path-parsing varies but the validator rejects both shapes.
    expect([400, 404]).toContain(res.status);
  });

  it("GET /api/plans/:id/stream 404s when no run is in flight", async () => {
    const res = await fetch(`${base}/api/plans/plan-nostream/stream`);
    expect(res.status).toBe(404);
  });
});

// ─── ask_user serve flow (v0.16 §11) ────────────────────────────────────
// End-to-end on the wire: a model that calls `ask_user` triggers the
// serve resolver's `AskUserPending`, the SSE stream emits `ask_user`
// then closes, the sidecar carries `pendingAsk`, and POST /answer-ask
// resumes the round with the reply substituted for the tool result.
describe("POST /api/chat + /:id/answer-ask (v0.16 §11)", () => {
  // Two-turn LLM: round 1 calls ask_user; round 2 echoes the reply it
  // saw in the tool message so we can prove the placeholder was patched
  // before the resume hit the provider.
  function askingLlm(): LLMProvider {
    let turn = 0;
    return {
      async describe() {
        return { name: "asking" };
      },
      async chat(req: LLMRequest): Promise<LLMResponse> {
        const t = turn++;
        return {
          async *stream(): AsyncIterable<LLMStreamChunk> {
            if (t === 0) {
              yield {
                type: "tool-call",
                id: "ask_call_1",
                name: "ask_user",
                argsDelta: '{"question":"Which file?"}',
              };
              yield { type: "done", finishReason: "tool_calls" };
              return;
            }
            // Round 2: surface whatever reply the server fed back as a
            // tool message so the test can assert the patch happened.
            const toolMsg = req.messages.find(
              (m) => m.role === "tool" && m.toolCallId === "ask_call_1",
            );
            yield { type: "text", delta: `you said: ${toolMsg?.content ?? "<none>"}` };
            yield { type: "done", finishReason: "stop" };
          },
        };
      },
    };
  }

  function parseSSE(raw: string): Array<{ event?: string; data: any }> {
    const out: Array<{ event?: string; data: any }> = [];
    for (const block of raw.split(/\n\n+/)) {
      const lines = block.split("\n");
      let event: string | undefined;
      let dataLine: string | undefined;
      for (const l of lines) {
        if (l.startsWith("event:")) event = l.slice("event:".length).trim();
        else if (l.startsWith("data:")) dataLine = l.slice("data:".length).trim();
      }
      if (dataLine === undefined) continue;
      try {
        out.push({ event, data: JSON.parse(dataLine) });
      } catch {
        out.push({ event, data: dataLine });
      }
    }
    return out;
  }

  it("first round emits ask_user + persists pendingAsk; answer-ask resumes with the reply patched in", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-serve-ask-"));
    await fs.writeFile(
      path.join(ws, "config.toml"),
      'defaultModel = "openai/gpt-4o"\n',
      "utf-8",
    );
    const local = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace: ws,
      // Mint the session with the serve-mode ask_user resolver wired in
      // (matches the default factory path; this test asserts behaviour
      // independent of which factory built the session).
      chatSessionFactory: ({ model }) =>
        new ChatSession({
          llm: askingLlm(),
          model,
          builtinTools: {
            ask_user: {
              resolver: async (question, { callId }) => {
                throw new AskUserPending({ question, callId });
              },
            },
          },
        }),
    });
    try {
      const conversationId = "ask-int-1";
      const r1 = await fetch(`${local.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "go", sessionId: conversationId }),
      });
      expect(r1.status).toBe(200);
      const evts1 = parseSSE(await r1.text());
      const askEv = evts1.find((e) => e.event === "ask_user");
      expect(askEv).toBeDefined();
      expect(askEv!.data.question).toBe("Which file?");
      expect(askEv!.data.id).toBe("ask_call_1");
      // No error frame and no done frame — the stream paused intentionally.
      expect(evts1.find((e) => e.event === "error")).toBeUndefined();
      expect(evts1.find((e) => e.event === "done")).toBeUndefined();

      // Sidecar must carry pendingAsk so a reload would re-render the box.
      const annResp = await fetch(
        `${local.url}/api/chat/${conversationId}/annotations`,
      );
      expect(annResp.status).toBe(200);
      const ann = (await annResp.json()) as any;
      expect(ann.pendingAsk).toMatchObject({
        question: "Which file?",
        callId: "ask_call_1",
        toolCallId: "ask_call_1",
      });

      // Reply. Resume should swap the placeholder for the reply text and
      // surface a text delta that quotes it back.
      const r2 = await fetch(
        `${local.url}/api/chat/${conversationId}/answer-ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "src/foo.lean", callId: "ask_call_1" }),
        },
      );
      expect(r2.status).toBe(200);
      const evts2 = parseSSE(await r2.text());
      const text = evts2
        .filter((e) => e.event === "text")
        .map((e) => e.data.delta)
        .join("");
      expect(text).toBe("you said: src/foo.lean");
      expect(evts2.find((e) => e.event === "done")).toBeDefined();

      // pendingAsk must be cleared after a successful resume.
      const annResp2 = await fetch(
        `${local.url}/api/chat/${conversationId}/annotations`,
      );
      const ann2 = (await annResp2.json()) as any;
      expect(ann2.pendingAsk).toBeUndefined();
    } finally {
      await local.close();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  it("200 ignored when there is no pendingAsk slot (stale sidecar tolerance)", async () => {
    // v0.17 W14: goal-mode auto-resolves ask_user; a 404 here is
    // almost always a stale sidecar from a pre-goal chat round, so
    // /answer-ask now 200s with `ignored: true` instead of erroring.
    const res = await fetch(`${base}/api/chat/never-asked/answer-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "hi" }),
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

  it("400s on an empty answer", async () => {
    const res = await fetch(`${base}/api/chat/whatever/answer-ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("409s when a stale tab submits an answer with a different callId", async () => {
    // Trigger an ask, then POST answer-ask with the wrong callId so the
    // server can prove its mismatch guard fires (without overwriting
    // pending state).
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-serve-ask409-"));
    await fs.writeFile(
      path.join(ws, "config.toml"),
      'defaultModel = "openai/gpt-4o"\n',
      "utf-8",
    );
    const local = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace: ws,
      chatSessionFactory: ({ model }) =>
        new ChatSession({
          llm: askingLlm(),
          model,
          builtinTools: {
            ask_user: {
              resolver: async (question, { callId }) => {
                throw new AskUserPending({ question, callId });
              },
            },
          },
        }),
    });
    try {
      const conversationId = "ask-stale-1";
      const r1 = await fetch(`${local.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "go", sessionId: conversationId }),
      });
      await r1.text(); // drain

      const r2 = await fetch(
        `${local.url}/api/chat/${conversationId}/answer-ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            answer: "stale tab guess",
            callId: "someone_elses_call_id",
          }),
        },
      );
      expect(r2.status).toBe(409);
      const body = (await r2.json()) as any;
      expect(body.expectedCallId).toBe("ask_call_1");
    } finally {
      await local.close();
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v0.19 Codex parity — server-side ask_user timeout auto-resolve.
//
// When the model emits `ask_user({ timeoutSeconds })`, the server persists
// pendingAsk with `timeoutSeconds`/`timeoutAt` AND schedules a
// `setTimeout(ms)` that auto-resolves the pending ask by patching the
// placeholder tool message and driving session.resume(). If the user
// POSTs /answer-ask before the timer fires, the timer is cancelled.
// ---------------------------------------------------------------------------
describe("POST /api/chat ask_user (v0.19 Codex parity — timeout auto-resolve)", () => {
  // Same two-turn LLM pattern as the v0.16 §11 e2e test above, but the
  // model emits all four structured fields. Round 2 echoes back the
  // reply it saw so we can assert what the server fed into the resume.
  function structuredAskingLlm(opts: {
    options?: string[];
    default?: string;
    timeoutSeconds?: number;
    allowCustom?: boolean;
  }): LLMProvider {
    let turn = 0;
    return {
      async describe() {
        return { name: "structured-asking" };
      },
      async chat(req: LLMRequest): Promise<LLMResponse> {
        const t = turn++;
        return {
          async *stream(): AsyncIterable<LLMStreamChunk> {
            if (t === 0) {
              const argv: Record<string, unknown> = { question: "Which file?" };
              if (opts.options !== undefined) argv.options = opts.options;
              if (opts.default !== undefined) argv.default = opts.default;
              if (opts.timeoutSeconds !== undefined) argv.timeoutSeconds = opts.timeoutSeconds;
              if (opts.allowCustom !== undefined) argv.allowCustom = opts.allowCustom;
              yield {
                type: "tool-call",
                id: "ask_t_1",
                name: "ask_user",
                argsDelta: JSON.stringify(argv),
              };
              yield { type: "done", finishReason: "tool_calls" };
              return;
            }
            const toolMsg = req.messages.find(
              (m) => m.role === "tool" && m.toolCallId === "ask_t_1",
            );
            yield {
              type: "text",
              delta: `resumed-with: ${toolMsg?.content ?? "<none>"}`,
            };
            yield { type: "done", finishReason: "stop" };
          },
        };
      },
    };
  }

  function parseSSE(raw: string): Array<{ event?: string; data: any }> {
    const out: Array<{ event?: string; data: any }> = [];
    for (const block of raw.split(/\n\n+/)) {
      const lines = block.split("\n");
      let event: string | undefined;
      let dataLine: string | undefined;
      for (const l of lines) {
        if (l.startsWith("event:")) event = l.slice("event:".length).trim();
        else if (l.startsWith("data:")) dataLine = l.slice("data:".length).trim();
      }
      if (dataLine === undefined) continue;
      try {
        out.push({ event, data: JSON.parse(dataLine) });
      } catch {
        out.push({ event, data: dataLine });
      }
    }
    return out;
  }

  // Spin up a fresh server with the structured asking LLM + the same
  // serve-style AskUserPending throw the prod resolver does. Returns
  // the running server and a cleanup fn the test must call in a finally.
  async function spinStructured(opts: {
    options?: string[];
    default?: string;
    timeoutSeconds?: number;
    allowCustom?: boolean;
  }) {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-serve-askt-"));
    await fs.writeFile(
      path.join(ws, "config.toml"),
      'defaultModel = "openai/gpt-4o"\n',
      "utf-8",
    );
    const local = await startServer({
      host: "127.0.0.1",
      port: 0,
      workspace: ws,
      chatSessionFactory: ({ model }) =>
        new ChatSession({
          llm: structuredAskingLlm(opts),
          model,
          builtinTools: {
            ask_user: {
              // Mirror serve.ts's serve resolver: forward every structured
              // field from the resolver ctx into AskUserPending so the
              // catch block can persist them on the sidecar.
              resolver: async (question, ctx) => {
                throw new AskUserPending({
                  question,
                  callId: ctx.callId,
                  ...(ctx.options !== undefined ? { options: ctx.options } : {}),
                  ...(ctx.default !== undefined ? { default: ctx.default } : {}),
                  ...(ctx.timeoutSeconds !== undefined
                    ? { timeoutSeconds: ctx.timeoutSeconds }
                    : {}),
                  ...(ctx.allowCustom !== undefined
                    ? { allowCustom: ctx.allowCustom }
                    : {}),
                });
              },
            },
          },
        }),
    });
    return {
      local,
      cleanup: async () => {
        await local.close();
        await fs.rm(ws, { recursive: true, force: true });
      },
    };
  }

  it("ask_user SSE event + sidecar carry the v0.19 structured fields", async () => {
    const { local, cleanup } = await spinStructured({
      options: ["a.ts", "b.ts"],
      default: "a.ts",
      timeoutSeconds: 60,
      allowCustom: false,
    });
    try {
      const conversationId = "ask-v19-1";
      const r1 = await fetch(`${local.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "go", sessionId: conversationId }),
      });
      expect(r1.status).toBe(200);
      const evts = parseSSE(await r1.text());
      const askEv = evts.find((e) => e.event === "ask_user");
      expect(askEv).toBeDefined();
      expect(askEv!.data.question).toBe("Which file?");
      expect(askEv!.data.options).toEqual(["a.ts", "b.ts"]);
      expect(askEv!.data.default).toBe("a.ts");
      expect(askEv!.data.timeoutSeconds).toBe(60);
      expect(askEv!.data.allowCustom).toBe(false);

      const ann = (await (
        await fetch(`${local.url}/api/chat/${conversationId}/annotations`)
      ).json()) as any;
      expect(ann.pendingAsk).toBeDefined();
      expect(ann.pendingAsk.options).toEqual(["a.ts", "b.ts"]);
      expect(ann.pendingAsk.default).toBe("a.ts");
      expect(ann.pendingAsk.timeoutSeconds).toBe(60);
      expect(ann.pendingAsk.allowCustom).toBe(false);
      expect(typeof ann.pendingAsk.timeoutAt).toBe("number");
      expect(ann.pendingAsk.timeoutAt).toBeGreaterThan(ann.pendingAsk.ts);
    } finally {
      await cleanup();
    }
  });

  it("server-side timeout auto-resolves pending ask with `default` after timeoutSeconds*1000 ms", async () => {
    // Use timeoutSeconds=1 so the test stays fast. With the fire-and-
    // forget timer, we poll the sidecar + history until the pending
    // slot clears + the tool message gets patched.
    const { local, cleanup } = await spinStructured({
      default: "auto-foo.ts",
      timeoutSeconds: 1,
    });
    try {
      const conversationId = "ask-v19-timeout-default";
      const r1 = await fetch(`${local.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "go", sessionId: conversationId }),
      });
      expect(r1.status).toBe(200);
      await r1.text(); // drain

      // Sanity: pendingAsk is present right after.
      const annPre = (await (
        await fetch(`${local.url}/api/chat/${conversationId}/annotations`)
      ).json()) as any;
      expect(annPre.pendingAsk).toBeDefined();

      // Wait for the timer to fire + clear the slot. Bound the wait so a
      // broken timer fails fast rather than hanging the suite.
      const deadline = Date.now() + 20000;  // Bumped from 8s for CI/load flake (audit 2026-06-24).
      let cleared = false;
      while (Date.now() < deadline) {
        const ann = (await (
          await fetch(`${local.url}/api/chat/${conversationId}/annotations`)
        ).json()) as any;
        if (!ann.pendingAsk) {
          cleared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(cleared).toBe(true);

      // Poll the history too — there's a small async gap between sidecar
      // clear and history patch under load. (audit 2026-06-24 added this
      // second-stage poll to fix recurring flake on parallel test runs.)
      let patched: { role: string; content: string; toolCallId?: string } | undefined;
      const patchDeadline = Date.now() + 5000;
      while (Date.now() < patchDeadline) {
        const hist = (await (
          await fetch(`${local.url}/api/chat/${conversationId}`)
        ).json()) as { history: Array<{ role: string; content: string; toolCallId?: string }> };
        patched = hist.history.find(
          (m) => m.role === "tool" && m.toolCallId === "ask_t_1",
        );
        if (patched && patched.content === "auto-foo.ts") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(patched).toBeDefined();
      expect(patched!.content).toBe("auto-foo.ts");
      // The model's round-2 echo lands as an assistant text message.
      const hist2 = (await (
        await fetch(`${local.url}/api/chat/${conversationId}`)
      ).json()) as { history: Array<{ role: string; content: string; toolCallId?: string }> };
      const echoed = hist2.history.find(
        (m) => m.role === "assistant" && m.content.includes("resumed-with: auto-foo.ts"),
      );
      expect(echoed).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("server-side timeout falls back to canned reply when `default` is absent", async () => {
    const { local, cleanup } = await spinStructured({
      // No default — server-side timer should patch with the canned
      // ASK_USER_GOAL_AUTO_REPLY constant.
      timeoutSeconds: 1,
    });
    try {
      const conversationId = "ask-v19-timeout-canned";
      const r1 = await fetch(`${local.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "go", sessionId: conversationId }),
      });
      expect(r1.status).toBe(200);
      await r1.text();

      const deadline = Date.now() + 20000;  // Bumped from 15s — flake recurred even at 15 under parallel vitest forks (audit 2026-06-24).
      let cleared = false;
      while (Date.now() < deadline) {
        const ann = (await (
          await fetch(`${local.url}/api/chat/${conversationId}/annotations`)
        ).json()) as any;
        if (!ann.pendingAsk) {
          cleared = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(cleared).toBe(true);

      const hist = (await (
        await fetch(`${local.url}/api/chat/${conversationId}`)
      ).json()) as { history: Array<{ role: string; content: string; toolCallId?: string }> };
      const patched = hist.history.find(
        (m) => m.role === "tool" && m.toolCallId === "ask_t_1",
      );
      expect(patched).toBeDefined();
      // The canned reply lives in ASK_USER_GOAL_AUTO_REPLY — match the
      // distinctive "no human available" phrase rather than importing
      // the constant just for the assertion.
      expect(patched!.content.toLowerCase()).toContain("no human available");
    } finally {
      await cleanup();
    }
  });

  it("user POST /answer-ask wins the race: timer is cancelled, reply is used", async () => {
    // Wider timeout window so the user's reply lands well before the
    // timer would fire. After resume completes, we check that the
    // history reflects the user's reply, NOT the canned fallback /
    // default. Then we wait past the would-be deadline to confirm the
    // timer didn't re-resolve a second time.
    const { local, cleanup } = await spinStructured({
      default: "TIMER-FALLBACK",
      timeoutSeconds: 2,
    });
    try {
      const conversationId = "ask-v19-race";
      const r1 = await fetch(`${local.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "go", sessionId: conversationId }),
      });
      expect(r1.status).toBe(200);
      await r1.text();

      // User replies promptly.
      const r2 = await fetch(
        `${local.url}/api/chat/${conversationId}/answer-ask`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "USER-WINS.ts", callId: "ask_t_1" }),
        },
      );
      expect(r2.status).toBe(200);
      const evts2 = parseSSE(await r2.text());
      const text = evts2
        .filter((e) => e.event === "text")
        .map((e) => e.data.delta)
        .join("");
      expect(text).toContain("USER-WINS.ts");
      expect(text).not.toContain("TIMER-FALLBACK");

      // Wait past the original deadline. A cancelled timer must NOT
      // double-patch the now-resolved message (which would corrupt history).
      await new Promise((r) => setTimeout(r, 2500));
      const hist = (await (
        await fetch(`${local.url}/api/chat/${conversationId}`)
      ).json()) as { history: Array<{ role: string; content: string; toolCallId?: string }> };
      const patched = hist.history.find(
        (m) => m.role === "tool" && m.toolCallId === "ask_t_1",
      );
      expect(patched).toBeDefined();
      expect(patched!.content).toBe("USER-WINS.ts");
    } finally {
      await cleanup();
    }
  });
});
