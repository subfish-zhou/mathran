import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { startServer, type RunningServer } from "./serve.js";
import type { LLMProvider, LLMRequest, LLMResponse, LLMStreamChunk } from "../core/providers/llm.js";

function fakeLlm(): LLMProvider {
  return {
    async describe() {
      return { name: "fake" };
    },
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const prompt = req.messages.map((m) => m.content).join("\n");
      const reply = prompt.includes("identifying key concepts")
        ? JSON.stringify({ concepts: [{ name: "sieve" }], search_queries: ["sieve theory"] })
        : "> [AI-GENERATED] generated.\n\n# Page\n\n## A\n\n## B\n\n## C\nbody";
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
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-initapi-"));
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    workspace,
    goalLlmFactory: () => fakeLlm(),
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function waitForStatus(runId: string, want: string, timeoutMs = 4000): Promise<any> {
  const start = Date.now();
  let last: any = null;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${base}/api/agent/init-project/${runId}`);
    if (res.ok) {
      last = await res.json();
      if (last.run.status === want) return last;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

describe("POST /api/agent/init-project", () => {
  it("rejects a body without problem.title", async () => {
    const res = await fetch(`${base}/api/agent/init-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ problem: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts problem + seedReferences + aiInit and returns runId + projectSlug", async () => {
    const res = await fetch(`${base}/api/agent/init-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem: { title: "Goldbach Conjecture", description: "Every even > 2 is a sum of two primes.", tags: ["number-theory"] },
        seedReferences: ["arXiv:1234.5678"],
        aiInit: { enableWiki: true, enableWorkspace: true, searchDepth: "quick" },
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.projectSlug).toBe("goldbach-conjecture");
    expect(body.runId).toMatch(/^run-/);
    expect(body.aiAssisted).toBe(true);

    const ledger = await waitForStatus(body.runId, "completed");
    expect(ledger.run.status).toBe("completed");
    // ≥4 phase lines
    expect(ledger.phases.length).toBeGreaterThanOrEqual(4);

    // wiki/index.md is LLM-generated, non-empty
    const index = await fs.readFile(
      path.join(workspace, "projects", "goldbach-conjecture", "wiki", "index.md"),
      "utf-8",
    );
    expect(index).toContain("AI-GENERATED");
    expect(index.length).toBeGreaterThan(50);

    // run.json status completed
    const runJson = JSON.parse(
      await fs.readFile(
        path.join(workspace, "projects", "goldbach-conjecture", ".mathran", "agent-runs", body.runId, "run.json"),
        "utf-8",
      ),
    );
    expect(runJson.status).toBe("completed");
  });

  it("Skip AI degrades to plain scaffold (runId null)", async () => {
    const res = await fetch(`${base}/api/agent/init-project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        problem: { title: "Skip AI Project" },
        seedReferences: [],
        aiInit: { enableWiki: false, enableWorkspace: false, searchDepth: "standard" },
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.runId).toBeNull();
    expect(body.aiAssisted).toBe(false);
    // Scaffold still exists
    const stat = await fs.stat(path.join(workspace, "projects", "skip-ai-project", "wiki", "index.md"));
    expect(stat.isFile()).toBe(true);
  });
});

describe("GET /api/agent/init-project/:runId", () => {
  it("returns 400 for a malformed runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/not-a-run`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown runId", async () => {
    const res = await fetch(`${base}/api/agent/init-project/run-deadbeefcafe`);
    expect(res.status).toBe(404);
  });
});
