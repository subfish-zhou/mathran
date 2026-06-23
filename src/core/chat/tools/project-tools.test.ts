/**
 * Tests for the project + doc-page chat tools (gap #1).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createListProjectsTool } from "./list-projects.js";
import { createReadProjectMetadataTool } from "./read-project-metadata.js";
import { createUpdateProjectMetadataTool } from "./update-project-metadata.js";
import { createListDocPagesTool } from "./list-doc-pages.js";
import { createReadDocPageTool } from "./read-doc-page.js";
import { createCreateDocPageTool } from "./create-doc-page.js";
import { createUpdateDocPageTool } from "./update-doc-page.js";

let workspace: string;

async function makeProject(slug: string, tomlBody?: string) {
  const dir = path.join(workspace, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "project.toml"),
    tomlBody ?? `[project]\nname = "${slug}"\n`,
  );
  return dir;
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-project-tool-"));
});

describe("list_projects", () => {
  it("returns count + sorted slugs", async () => {
    await makeProject("zeta", `[project]\nname = "Z"\n`);
    await makeProject("alpha");
    const tool = createListProjectsTool({ workspace });
    const r = await tool.execute({});
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.count).toBe(2);
    expect(data.projects.map((p: any) => p.slug)).toEqual(["alpha", "zeta"]);
  });
  it("empty workspace returns 0", async () => {
    const tool = createListProjectsTool({ workspace });
    const r = await tool.execute({});
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).count).toBe(0);
  });
});

describe("read_project_metadata", () => {
  it("returns slug + project + entries", async () => {
    await makeProject("p1");
    await fs.mkdir(path.join(workspace, "projects/p1/wiki"));
    const tool = createReadProjectMetadataTool({ workspace });
    const r = await tool.execute({ project: "p1" });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.slug).toBe("p1");
    expect(data.entries).toContain("wiki/");
  });
  it("ok=false for missing project", async () => {
    const tool = createReadProjectMetadataTool({ workspace });
    const r = await tool.execute({ project: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});

describe("update_project_metadata", () => {
  it("updates description + tags", async () => {
    await makeProject("p1");
    const tool = createUpdateProjectMetadataTool({ workspace });
    const r = await tool.execute({ project: "p1", description: "abc", tags: ["x", "y"] });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.project.description).toBe("abc");
    expect(data.project.tags).toEqual(["x", "y"]);
  });
  it("ok=false when project missing", async () => {
    const tool = createUpdateProjectMetadataTool({ workspace });
    const r = await tool.execute({ project: "ghost", name: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
  it("ok=false when no patch fields", async () => {
    await makeProject("p1");
    const tool = createUpdateProjectMetadataTool({ workspace });
    const r = await tool.execute({ project: "p1" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("no recognised fields");
  });
});

describe("doc page lifecycle", () => {
  it("create + list + read + update", async () => {
    await makeProject("p1");
    const create = createCreateDocPageTool({ workspace });
    const cr = await create.execute({ project: "p1", page: "design", body: "# Design\n" });
    expect(cr.ok).toBe(true);
    expect(JSON.parse(cr.content).bytes).toBeGreaterThan(0);

    const list = createListDocPagesTool({ workspace });
    const lr = await list.execute({ project: "p1" });
    expect(lr.ok).toBe(true);
    expect(JSON.parse(lr.content).count).toBe(1);

    const read = createReadDocPageTool({ workspace });
    const rr = await read.execute({ project: "p1", page: "design" });
    expect(rr.ok).toBe(true);
    expect(JSON.parse(rr.content).content).toBe("# Design\n");

    const update = createUpdateDocPageTool({ workspace });
    const ur = await update.execute({ project: "p1", page: "design", body: "v2\n" });
    expect(ur.ok).toBe(true);
    expect(JSON.parse((await read.execute({ project: "p1", page: "design" })).content).content).toBe("v2\n");
  });
  it("create_doc_page rejects duplicate", async () => {
    await makeProject("p1");
    const tool = createCreateDocPageTool({ workspace });
    await tool.execute({ project: "p1", page: "x", body: "1" });
    const r = await tool.execute({ project: "p1", page: "x", body: "2" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("already exists");
  });
  it("update_doc_page rejects missing", async () => {
    await makeProject("p1");
    const tool = createUpdateDocPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "ghost", body: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
  it("read_doc_page returns ok=false for missing", async () => {
    await makeProject("p1");
    const tool = createReadDocPageTool({ workspace });
    const r = await tool.execute({ project: "p1", page: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
  it("list_doc_pages returns ok=false when project missing", async () => {
    const tool = createListDocPagesTool({ workspace });
    const r = await tool.execute({ project: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});
