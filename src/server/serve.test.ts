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
