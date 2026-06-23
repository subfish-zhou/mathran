/**
 * Tests for the `verify_page` chat tool (gap #5).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createVerifyPageTool } from "./verify-page.js";
import { createWikiPage, readWikiPage } from "../../wiki/store.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../providers/llm.js";

let workspace: string;

async function makeProject(slug = "p1") {
  const dir = path.join(workspace, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "project.toml"), `[project]\nname = "${slug}"\n`);
}

/**
 * Fake LLM that returns one canned text per call, chosen by inspecting the
 * system prompt: extract calls get `extract`, score calls get `score`.
 */
class FakeLLM implements LLMProvider {
  constructor(
    private readonly replies: { extract: string; score: string },
  ) {}
  async describe() {
    return { name: "fake" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    const sys = (req.messages.find((m) => m.role === "system")?.content ?? "") as string;
    const text = /enumerate|list every distinct/i.test(sys)
      ? this.replies.extract
      : this.replies.score;
    return {
      async *stream() {
        yield { type: "text", delta: text } as any;
        yield { type: "done", finishReason: "stop" } as any;
      },
    } as LLMResponse;
  }
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-verify-tool-"));
});

describe("createVerifyPageTool", () => {
  it("writes verification frontmatter with an aggregate score and issues", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "concept", "Pi is exactly 3. e is about 2.718.\n");

    const llm = new FakeLLM({
      extract: JSON.stringify(["Pi is exactly 3", "e is about 2.718"]),
      score: JSON.stringify([
        { claim: "Pi is exactly 3", score: 0, issue: "Pi is irrational (~3.14159)." },
        { claim: "e is about 2.718", score: 1, issue: "" },
      ]),
    });

    const tool = createVerifyPageTool({ workspace, llm, model: "test-model" });
    const r = await tool.execute({ project: "p1", page: "concept" });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.score).toBeCloseTo(0.5, 5);
    expect(parsed.claims).toBe(2);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toContain("Pi is exactly 3");

    const page = await readWikiPage(workspace, "p1", "concept");
    expect(page?.frontmatter.verification?.score).toBeCloseTo(0.5, 5);
    expect(page?.frontmatter.verification?.issues).toHaveLength(1);
    expect(typeof page?.frontmatter.verification?.verifiedAt).toBe("string");
  });

  it("records score=1 with no issues when no claims are found", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "empty", "Just a heading.\n");
    const llm = new FakeLLM({ extract: "[]", score: "[]" });
    const tool = createVerifyPageTool({ workspace, llm, model: "m" });
    const r = await tool.execute({ project: "p1", page: "empty" });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.score).toBe(1);
    expect(parsed.claims).toBe(0);
    const page = await readWikiPage(workspace, "p1", "empty");
    expect(page?.frontmatter.verification?.score).toBe(1);
  });

  it("returns ok=false when the page does not exist", async () => {
    await makeProject();
    const llm = new FakeLLM({ extract: "[]", score: "[]" });
    const tool = createVerifyPageTool({ workspace, llm, model: "m" });
    const r = await tool.execute({ project: "p1", page: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });

  it("returns ok=false when no LLM provider is configured", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "x", "body\n");
    const tool = createVerifyPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("LLM provider");
  });

  it("rejects invalid slugs", async () => {
    const llm = new FakeLLM({ extract: "[]", score: "[]" });
    const tool = createVerifyPageTool({ workspace, llm, model: "m" });
    const r = await tool.execute({ project: "../bad", page: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("invalid project slug");
  });

  it("tolerates fenced/markdown-wrapped JSON from the LLM", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "c2", "Claim body.\n");
    const llm = new FakeLLM({
      extract: '```json\n["a claim"]\n```',
      score: '```json\n[{"claim":"a claim","score":0.8,"issue":""}]\n```',
    });
    const tool = createVerifyPageTool({ workspace, llm, model: "m" });
    const r = await tool.execute({ project: "p1", page: "c2" });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.score).toBeCloseTo(0.8, 5);
    expect(parsed.issues).toHaveLength(0);
  });
});
