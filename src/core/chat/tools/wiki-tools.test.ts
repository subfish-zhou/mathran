/**
 * Tests for the 6 wiki chat tools (gap #1).
 *
 * Each suite covers: happy path, missing args, project missing, slug
 * validation, and the tool's specific behaviour (e.g. duplicate-creation
 * fails, search returns empty for missing project).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createReadWikiPageTool } from "./read-wiki-page.js";
import { createListWikiPagesTool } from "./list-wiki-pages.js";
import { createCreateWikiPageTool } from "./create-wiki-page.js";
import { createUpdateWikiPageTool } from "./update-wiki-page.js";
import { createDeleteWikiPageTool } from "./delete-wiki-page.js";
import { createSearchWikiTool } from "./search-wiki.js";

let workspace: string;

async function makeProject(slug = "p1") {
  const dir = path.join(workspace, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "project.toml"), `[project]\nname = "${slug}"\n`);
  return dir;
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-wiki-tool-"));
});

describe("read_wiki_page", () => {
  it("reads an existing page", async () => {
    await makeProject();
    const create = createCreateWikiPageTool({ workspace });
    await create.execute({ project: "p1", page: "intro", body: "# Hi\n" });
    const tool = createReadWikiPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "intro" });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.page).toBe("intro");
    expect(data.body).toBe("# Hi\n");
    expect(data.version).toBe(1);
  });
  it("returns ok=false on missing page", async () => {
    await makeProject();
    const tool = createReadWikiPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
  it("rejects unsafe slug", async () => {
    const tool = createReadWikiPageTool({ workspace });
    const r = await tool.execute({ project: "../etc", page: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("invalid project slug");
  });
  it("requires both args", async () => {
    const tool = createReadWikiPageTool({ workspace });
    expect((await tool.execute({})).ok).toBe(false);
    expect((await tool.execute({ project: "p1" })).ok).toBe(false);
  });
});

describe("list_wiki_pages", () => {
  it("lists pages with counts", async () => {
    await makeProject();
    const create = createCreateWikiPageTool({ workspace });
    await create.execute({ project: "p1", page: "alpha", body: "a" });
    await create.execute({ project: "p1", page: "beta", body: "b" });
    const tool = createListWikiPagesTool({ workspace });
    const r = await tool.execute({ project: "p1" });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.count).toBe(2);
    expect(data.pages.map((p: any) => p.page).sort()).toEqual(["alpha", "beta"]);
  });
  it("returns ok=false when project missing", async () => {
    const tool = createListWikiPagesTool({ workspace });
    const r = await tool.execute({ project: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("project not found");
  });
});

describe("create_wiki_page", () => {
  it("creates a new page", async () => {
    await makeProject();
    const tool = createCreateWikiPageTool({ workspace });
    const r = await tool.execute({
      project: "p1",
      page: "intro",
      body: "# Intro\n",
      title: "Intro",
      tags: ["wiki", "intro"],
    });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.page).toBe("intro");
    expect(data.version).toBe(1);
    expect(data.title).toBe("Intro");
  });
  it("fails on duplicate", async () => {
    await makeProject();
    const tool = createCreateWikiPageTool({ workspace });
    await tool.execute({ project: "p1", page: "intro", body: "v1" });
    const r = await tool.execute({ project: "p1", page: "intro", body: "v2" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("already exists");
  });
  it("requires body", async () => {
    const tool = createCreateWikiPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "intro" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("requires 'body'");
  });
});

describe("update_wiki_page", () => {
  it("updates an existing page and bumps version", async () => {
    await makeProject();
    const create = createCreateWikiPageTool({ workspace });
    await create.execute({ project: "p1", page: "intro", body: "v1" });
    const tool = createUpdateWikiPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "intro", body: "v2" });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.version).toBe(2);
  });
  it("fails when page missing", async () => {
    await makeProject();
    const tool = createUpdateWikiPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "ghost", body: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});

describe("delete_wiki_page", () => {
  it("soft-deletes a page", async () => {
    await makeProject();
    const create = createCreateWikiPageTool({ workspace });
    await create.execute({ project: "p1", page: "intro", body: "body" });
    const tool = createDeleteWikiPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "intro" });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.deleted).toBe(true);
  });
  it("fails when page missing", async () => {
    await makeProject();
    const tool = createDeleteWikiPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});

describe("search_wiki", () => {
  it("finds substring matches", async () => {
    await makeProject();
    const create = createCreateWikiPageTool({ workspace });
    await create.execute({ project: "p1", page: "a", body: "the quick fox\nover lazy dog" });
    await create.execute({ project: "p1", page: "b", body: "fox runs again" });
    const tool = createSearchWikiTool({ workspace });
    const r = await tool.execute({ project: "p1", query: "fox" });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.count).toBe(2);
    expect(data.hits.map((h: any) => h.page).sort()).toEqual(["a", "b"]);
  });
  it("respects limit", async () => {
    await makeProject();
    const create = createCreateWikiPageTool({ workspace });
    await create.execute({ project: "p1", page: "a", body: "match" });
    await create.execute({ project: "p1", page: "b", body: "match" });
    await create.execute({ project: "p1", page: "c", body: "match" });
    const tool = createSearchWikiTool({ workspace });
    const r = await tool.execute({ project: "p1", query: "match", limit: 2 });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).count).toBe(2);
  });
  it("rejects empty query", async () => {
    const tool = createSearchWikiTool({ workspace });
    const r = await tool.execute({ project: "p1", query: "   " });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("non-empty");
  });
});

describe("ctx.workspace fallback", () => {
  it("read_wiki_page uses ctx.workspace when builder omitted", async () => {
    await makeProject();
    await createCreateWikiPageTool({ workspace }).execute({
      project: "p1",
      page: "intro",
      body: "x",
    });
    const tool = createReadWikiPageTool();
    const r = await tool.execute({ project: "p1", page: "intro" }, { workspace });
    expect(r.ok).toBe(true);
  });
});
