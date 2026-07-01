import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerTikzRoutes } from "./tikz-routes.js";
import { tikzHash } from "../core/tikz-render/index.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "tikz-routes-test-"));
}

function makeApp(workspace: string): Hono {
  const app = new Hono();
  registerTikzRoutes(app, workspace);
  return app;
}

describe("POST /api/render/tikz", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkTmp();
  });

  it("400 on non-JSON body", async () => {
    const app = makeApp(workspace);
    const res = await app.request("/api/render/tikz", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(400);
  });

  it("400 on missing source", async () => {
    const app = makeApp(workspace);
    const res = await app.request("/api/render/tikz", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/source/i);
  });

  it("400 on empty source", async () => {
    const app = makeApp(workspace);
    const res = await app.request("/api/render/tikz", {
      method: "POST",
      body: JSON.stringify({ source: "   " }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("413 on oversized source", async () => {
    const app = makeApp(workspace);
    const big = "\\begin{tikzcd}" + "x".repeat(40000) + "\\end{tikzcd}";
    const res = await app.request("/api/render/tikz", {
      method: "POST",
      body: JSON.stringify({ source: big }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(413);
  });

  it("returns cached SVG when disk cache exists", async () => {
    // Seed the cache so we don't have to spin up WASM.
    const source = "\\begin{tikzcd}\n  A \\arrow[r] & B\n\\end{tikzcd}";
    const hash = tikzHash(source);
    const cacheDir = path.join(workspace, ".mathran", "tikz-cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const fakeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>cached</text></svg>`;
    await fs.writeFile(path.join(cacheDir, `${hash}.svg`), fakeSvg, "utf8");

    const app = makeApp(workspace);
    const res = await app.request("/api/render/tikz", {
      method: "POST",
      body: JSON.stringify({ source }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      ok: boolean;
      svg?: string;
      hash: string;
      fromCache?: boolean;
    };
    expect(j.ok).toBe(true);
    expect(j.fromCache).toBe(true);
    expect(j.svg).toBe(fakeSvg);
    expect(j.hash).toBe(hash);
  });

  it("passes options through the pipeline (hash depends on them)", async () => {
    // Seed cache for source + specific options combo. Different options
    // → different hash → cache miss (would fall through to WASM but we
    // don't invoke it here; just confirm the requested hash differs).
    const source = "\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}";
    const cacheDir = path.join(workspace, ".mathran", "tikz-cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const hashArrows = tikzHash(source, { tikzLibraries: "arrows" });
    const hashCalc = tikzHash(source, { tikzLibraries: "calc" });
    expect(hashArrows).not.toBe(hashCalc);
    await fs.writeFile(
      path.join(cacheDir, `${hashArrows}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg"><text>arrows</text></svg>`,
      "utf8",
    );

    const app = makeApp(workspace);
    const res = await app.request("/api/render/tikz", {
      method: "POST",
      body: JSON.stringify({ source, options: { tikzLibraries: "arrows" } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; hash: string; svg?: string };
    expect(j.ok).toBe(true);
    expect(j.hash).toBe(hashArrows);
    expect(j.svg).toContain("arrows");
  });
});
