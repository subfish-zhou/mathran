/**
 * Tests for `mathran serve` — the local-only Hono backend.
 *
 * The server is started on an ephemeral port (`port: 0`) bound to 127.0.0.1 and
 * driven over real `fetch`. The chat SSE path injects a fake LLM (via the
 * `chatSessionFactory` seam) so no real provider is ever contacted.
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
});
