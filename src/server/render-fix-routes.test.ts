import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerRenderFixRoutes } from "./render-fix-routes.js";

/**
 * Mock LLM via config.toml — writes a minimal config that resolves to a
 * `mock:` provider we register on the fly. Alternative would be to
 * mock ModelRouter directly, but stubbing at the config boundary keeps
 * the endpoint's real code path exercised.
 *
 * Actually simpler: use vi.mock on the ModelRouter class before the
 * endpoint imports it.
 */

vi.mock("../providers/index.js", () => {
  return {
    ModelRouter: class MockModelRouter {
      constructor(_config: unknown) {}
      async chat(req: { model: string; messages: unknown[] }) {
        // Read the desired mock response from a global set per test.
        const stub = (globalThis as unknown as { __mockLlmReply?: string }).__mockLlmReply;
        return {
          stream: async function* () {
            if (typeof stub === "string") {
              yield { type: "text" as const, delta: stub };
            }
            yield { type: "done" as const, usage: { promptTokens: 100, completionTokens: 50 } };
          },
        };
      }
    },
  };
});

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "render-fix-routes-test-"));
  // Write a minimal config.toml with a defaultModel so the endpoint doesn't
  // fail the no-model-configured guard.
  await fs.writeFile(
    path.join(dir, "config.toml"),
    'defaultModel = "azure/gpt55"\n\n[providers.azure]\nkind = "azure"\napiKey = "test"\nendpoint = "http://mock"\n',
    "utf8",
  );
  return dir;
}

function makeApp(workspace: string): Hono {
  const app = new Hono();
  registerRenderFixRoutes(app, workspace);
  return app;
}

function setMockReply(reply: string): void {
  (globalThis as unknown as { __mockLlmReply?: string }).__mockLlmReply = reply;
}

describe("POST /api/render-fix", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkTmp();
  });

  afterEach(() => {
    delete (globalThis as unknown as { __mockLlmReply?: string }).__mockLlmReply;
  });

  it("400 on non-JSON body", async () => {
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(400);
  });

  it("400 on missing originalReply", async () => {
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({ errors: [{ kind: "x", matched: "x", message: "x" }] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("400 on empty errors array", async () => {
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({ originalReply: "hi", errors: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("400 on malformed error entry", async () => {
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({ originalReply: "hi", errors: [{ kind: "x" }] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("413 on oversized reply", async () => {
    const app = makeApp(workspace);
    const big = "x".repeat(200 * 1024);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({
        originalReply: big,
        errors: [{ kind: "katex-inline", matched: "$x$", message: "err" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(413);
  });

  it("413 on too many errors", async () => {
    const app = makeApp(workspace);
    const errors = Array.from({ length: 15 }, (_, i) => ({
      kind: "katex-inline",
      matched: `$x${i}$`,
      message: "err",
    }));
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({ originalReply: "hi", errors }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(413);
  });

  it("returns patches when LLM returns valid fenced JSON", async () => {
    setMockReply(
      "Sure, here are the fixes:\n\n```json\n" +
        '[{"errorIndex": 0, "replacement": "$a + b = c$"}]\n' +
        "```\n\nDone.",
    );
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({
        originalReply: "The formula $\\brokenCmd{a}$ is wrong.",
        errors: [
          { kind: "katex-inline", matched: "$\\brokenCmd{a}$", message: "undefined control sequence" },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      patches?: Array<{ errorIndex: number; replacement: string }>;
      tokensIn?: number;
      tokensOut?: number;
    };
    expect(j.ok).toBe(true);
    expect(j.patches).toHaveLength(1);
    expect(j.patches![0]).toEqual({ errorIndex: 0, replacement: "$a + b = c$" });
    expect(j.tokensIn).toBe(100);
    expect(j.tokensOut).toBe(50);
  });

  it("returns ok:false when LLM returns non-JSON prose", async () => {
    setMockReply("Sorry, I can't fix that today.");
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({
        originalReply: "$\\brokenCmd{a}$",
        errors: [{ kind: "katex-inline", matched: "$\\brokenCmd{a}$", message: "err" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toBeDefined();
  });

  it("filters out invalid patch shapes (missing fields, wrong types)", async () => {
    setMockReply(
      '```json\n' +
        '[{"errorIndex": 0, "replacement": "$fix$"}, {"errorIndex": "not a num", "replacement": "y"}, {"replacement": "no idx"}, {"errorIndex": 42, "replacement": "out of range"}]\n' +
        '```',
    );
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({
        originalReply: "$\\bad{x}$",
        errors: [{ kind: "katex-inline", matched: "$\\bad{x}$", message: "err" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; patches?: Array<{ errorIndex: number; replacement: string }> };
    expect(j.ok).toBe(true);
    // Only the well-formed patch survives (errorIndex=0 is valid; others invalid).
    expect(j.patches).toHaveLength(1);
    expect(j.patches![0]).toEqual({ errorIndex: 0, replacement: "$fix$" });
  });

  it("returns ok:false when 0 patches survive filtering", async () => {
    setMockReply('```json\n[{"errorIndex": 99, "replacement": "x"}]\n```');
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({
        originalReply: "$x$",
        errors: [{ kind: "katex-inline", matched: "$x$", message: "err" }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toContain("0 usable patches");
  });

  it("handles multiple errors + multiple patches in one round-trip", async () => {
    setMockReply(
      '```json\n' +
        '[{"errorIndex": 0, "replacement": "$a$"}, {"errorIndex": 1, "replacement": "\\\\begin{tikzcd} A \\\\arrow[r] & B \\\\end{tikzcd}"}]\n' +
        '```',
    );
    const app = makeApp(workspace);
    const res = await app.request("/api/render-fix", {
      method: "POST",
      body: JSON.stringify({
        originalReply: "$\\bad1$ and \\begin{xy}A\\end{xy}",
        errors: [
          { kind: "katex-inline", matched: "$\\bad1$", message: "err" },
          { kind: "unrenderable-env", matched: "\\begin{xy}A\\end{xy}", message: "err" },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; patches?: Array<{ errorIndex: number; replacement: string }> };
    expect(j.ok).toBe(true);
    expect(j.patches).toHaveLength(2);
    expect(j.patches!.map((p) => p.errorIndex).sort()).toEqual([0, 1]);
  });
});
