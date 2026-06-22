/**
 * Integration tests for the SPA slash-command HTTP surface
 * (`src/server/slash-routes.ts`). Driven over real `fetch` against an
 * ephemeral 127.0.0.1 server with a fake LLM (no provider contacted).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import { ChatSession } from "../core/chat/index.js";
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk } from "../core/providers/llm.js";

function fakeLlm(reply: string): LLMProvider {
  return {
    async describe() {
      return { name: "fake" };
    },
    async chat(_req: LLMRequest): Promise<LLMResponse> {
      return {
        async *stream(): AsyncIterable<LLMStreamChunk> {
          yield { type: "text", delta: reply };
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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-slash-"));
  // Seed a custom command (workspace layer) + one that shadows a builtin.
  const cmdDir = path.join(workspace, ".mathran", "commands");
  await fs.mkdir(cmdDir, { recursive: true });
  await fs.writeFile(
    path.join(cmdDir, "explain.md"),
    "---\ndescription: Explain a topic simply\n---\nExplain $ARGUMENTS in simple terms",
    "utf-8",
  );
  await fs.writeFile(
    path.join(cmdDir, "skills.md"),
    "this shadows the builtin /skills and must be dropped",
    "utf-8",
  );
  // Seed a workspace-layer skill so GET /api/skills returns something.
  const skillDir = path.join(workspace, ".mathran", "skills", "prover");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: prover\ndescription: Prove lemmas\n---\nbody",
    "utf-8",
  );

  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    chatSessionFactory: ({ model }) => new ChatSession({ llm: fakeLlm("hi"), model }),
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("GET /api/slash/commands", () => {
  it("returns builtin commands including the nine new ones", async () => {
    const res = await fetch(`${base}/api/slash/commands`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.builtin.map((b: any) => b.name);
    for (const n of ["plan", "compact", "context", "review", "effort", "cd", "diff", "agents", "skills"]) {
      expect(names).toContain(n);
    }
  });

  it("returns custom commands with body, dropping builtin-shadowing ones", async () => {
    const res = await fetch(`${base}/api/slash/commands`);
    const body = await res.json();
    const explain = body.custom.find((c: any) => c.name === "explain");
    expect(explain).toBeTruthy();
    expect(explain.body).toBe("Explain $ARGUMENTS in simple terms");
    expect(explain.description).toBe("Explain a topic simply");
    // /skills custom shadows a builtin → dropped + warned.
    expect(body.custom.find((c: any) => c.name === "skills")).toBeUndefined();
    expect(body.warnings.join(" ")).toMatch(/shadows a builtin/);
  });
});

describe("GET /api/skills", () => {
  it("lists three-layer skills", async () => {
    const res = await fetch(`${base}/api/skills`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const prover = body.skills.find((s: any) => s.name === "prover");
    expect(prover).toMatchObject({ name: "prover", layer: "workspace", description: "Prove lemmas" });
  });
});

describe("GET /api/subagents/active", () => {
  it("lists available kinds and an active array", async () => {
    const res = await fetch(`${base}/api/subagents/active`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.kinds)).toBe(true);
    expect(body.kinds).toContain("search");
    expect(Array.isArray(body.active)).toBe(true);
  });
});

describe("GET /api/chat/:cid/context", () => {
  it("returns zeroed usage for an unknown conversation", async () => {
    const res = await fetch(`${base}/api/chat/unknown-conv/context`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toBe(0);
    expect(typeof body.maxTokens).toBe("number");
    expect(body.percentage).toBe(0);
  });

  it("rejects an unsafe conversation id", async () => {
    const res = await fetch(`${base}/api/chat/..%2Fetc/context`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/chat/:cid/slash", () => {
  it("sets reasoning effort", async () => {
    const res = await fetch(`${base}/api/chat/conv-effort/slash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "effort", args: "high" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, effort: "high" });
  });

  it("rejects an invalid effort level", async () => {
    const res = await fetch(`${base}/api/chat/conv-effort/slash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "effort", args: "turbo" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns the review stub prompt", async () => {
    const res = await fetch(`${base}/api/chat/conv-review/slash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "review" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, action: "send" });
    expect(body.prompt.toLowerCase()).toContain("review");
  });

  it("rejects an unknown server-side command", async () => {
    const res = await fetch(`${base}/api/chat/conv-x/slash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "skills" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires a command", async () => {
    const res = await fetch(`${base}/api/chat/conv-x/slash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
