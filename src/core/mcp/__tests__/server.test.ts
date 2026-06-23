import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMcpServer, loadFilePrompts, candidateBuiltinTools } from "../server.js";
import { McpServerExposureConfigSchema } from "../schema.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-server-"));
}
const cfg = (o: Record<string, unknown> = {}) => McpServerExposureConfigSchema.parse(o);

describe("mathran-as-MCP-server (server.ts)", () => {
  let ws: string;
  beforeEach(() => {
    ws = tmp();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("candidate builtins include bash so the gate can deny it", () => {
    const names = candidateBuiltinTools(ws).map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
  });

  it("exposes only read tools by default (no write_file/edit_file/bash)", async () => {
    const { exposedTools } = await buildMcpServer({ workspace: ws, config: cfg() });
    const names = exposedTools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("bash");
  });

  it("exposes write tools when exposeMutating, still never bash", async () => {
    const { exposedTools } = await buildMcpServer({
      workspace: ws,
      config: cfg({ exposeMutating: true, allowedTools: ["read_file", "write_file", "bash"] }),
    });
    const names = exposedTools.map((t) => t.name);
    expect(names).toContain("write_file");
    expect(names).not.toContain("bash");
  });

  it("loads file prompts from .mathran/prompts/*.md", async () => {
    const pdir = path.join(ws, ".mathran", "prompts");
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "review.md"), "# Code review\nReview the diff.", "utf-8");
    const prompts = loadFilePrompts(ws, ws);
    expect(prompts.map((p) => p.name)).toContain("review");
    const review = prompts.find((p) => p.name === "review");
    expect(review?.description).toContain("Code review");
    const { prompts: built } = await buildMcpServer({ workspace: ws, config: cfg() });
    expect(built.map((p) => p.name)).toContain("review");
  });

  it("read_file tool round-trips through the server handler", async () => {
    fs.writeFileSync(path.join(ws, "hello.txt"), "hi there", "utf-8");
    const { exposedTools } = await buildMcpServer({ workspace: ws, config: cfg() });
    const readFile = exposedTools.find((t) => t.name === "read_file")!;
    const res = await readFile.execute({ path: "hello.txt" }, { workspace: ws });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hi there");
  });

  it("builds a real SDK Server instance", async () => {
    const { server } = await buildMcpServer({ workspace: ws, config: cfg() });
    expect(server).toBeTruthy();
    expect(typeof (server as any).connect).toBe("function");
  });

  it("respects exposePrompts:false", async () => {
    const pdir = path.join(ws, ".mathran", "prompts");
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, "x.md"), "# X", "utf-8");
    const { prompts } = await buildMcpServer({ workspace: ws, config: cfg({ exposePrompts: false }) });
    expect(prompts).toEqual([]);
  });
});
