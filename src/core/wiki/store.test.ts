import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  isSafeSlug,
  parseFrontMatter,
  stringifyFrontmatter,
  listWikiPages,
  readWikiPage,
  writeWikiPage,
  createWikiPage,
  updateWikiPage,
  softDeleteWikiPage,
  searchWiki,
} from "./store.js";

let workspace: string;

async function makeProject(slug = "p1") {
  const dir = path.join(workspace, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "project.toml"), `[project]\nname = "${slug}"\n`);
  return dir;
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-wiki-store-"));
});

describe("isSafeSlug", () => {
  it("accepts alphanumeric + - _ .", () => {
    expect(isSafeSlug("alpha")).toBe(true);
    expect(isSafeSlug("a1.b_2-3")).toBe(true);
    expect(isSafeSlug("Z9")).toBe(true);
  });
  it("rejects empty, dotty, and traversal-ish input", () => {
    expect(isSafeSlug("")).toBe(false);
    expect(isSafeSlug("..")).toBe(false);
    expect(isSafeSlug("a/b")).toBe(false);
    expect(isSafeSlug("a b")).toBe(false);
    expect(isSafeSlug(".hidden")).toBe(false);
    expect(isSafeSlug("ends-")).toBe(false);
  });
});

describe("parseFrontMatter / stringifyFrontmatter", () => {
  it("round-trips title + tags", () => {
    const raw = stringifyFrontmatter({ title: "Hi", tags: ["a", "b"], version: 1 }) + "body\n";
    const fm = parseFrontMatter(raw);
    expect(fm.data.title).toBe("Hi");
    expect(fm.data.tags).toEqual(["a", "b"]);
    expect(fm.body).toBe("body\n");
  });
  it("treats missing fences as plain body", () => {
    const fm = parseFrontMatter("no frontmatter here\n");
    expect(fm.data).toEqual({});
    expect(fm.body).toBe("no frontmatter here\n");
  });
});

describe("listWikiPages", () => {
  it("returns null when project missing", async () => {
    expect(await listWikiPages(workspace, "ghost")).toBeNull();
  });
  it("returns [] when wiki dir missing", async () => {
    await makeProject();
    expect(await listWikiPages(workspace, "p1")).toEqual([]);
  });
  it("lists pages sorted by sortOrder then slug", async () => {
    await makeProject();
    await writeWikiPage(workspace, "p1", "zeta", "z", { sortOrder: 0 });
    await writeWikiPage(workspace, "p1", "alpha", "a", { sortOrder: 5 });
    await writeWikiPage(workspace, "p1", "beta", "b", { sortOrder: 0 });
    const pages = await listWikiPages(workspace, "p1");
    expect(pages?.map((p) => p.page)).toEqual(["beta", "zeta", "alpha"]);
  });
  it("rejects invalid project slug", async () => {
    await expect(listWikiPages(workspace, "../etc")).rejects.toThrow("invalid project slug");
  });
});

describe("readWikiPage / writeWikiPage", () => {
  it("returns null for missing page", async () => {
    await makeProject();
    expect(await readWikiPage(workspace, "p1", "missing")).toBeNull();
  });
  it("writes and reads a page with frontmatter", async () => {
    await makeProject();
    await writeWikiPage(workspace, "p1", "intro", "# Hello\n", { title: "Intro" });
    const page = await readWikiPage(workspace, "p1", "intro");
    expect(page?.body).toBe("# Hello\n");
    expect(page?.frontmatter.title).toBe("Intro");
    expect(page?.version).toBe(1);
  });
  it("bumps version and snapshots history on update", async () => {
    await makeProject();
    await writeWikiPage(workspace, "p1", "intro", "v1");
    await writeWikiPage(workspace, "p1", "intro", "v2");
    const page = await readWikiPage(workspace, "p1", "intro");
    expect(page?.version).toBe(2);
    const histFile = path.join(workspace, "projects/p1/wiki/.history/intro/v1.md");
    expect(await fs.readFile(histFile, "utf-8")).toContain("v1");
  });
  it("rejects invalid parent slug", async () => {
    await makeProject();
    await expect(
      writeWikiPage(workspace, "p1", "x", "body", { parent: "../bad" }),
    ).rejects.toThrow("invalid parent slug");
  });
  it("throws when project missing", async () => {
    await expect(writeWikiPage(workspace, "ghost", "p", "b")).rejects.toThrow(
      "project not found",
    );
  });
});

describe("createWikiPage / updateWikiPage", () => {
  it("createWikiPage throws on duplicate", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "intro", "v1");
    await expect(createWikiPage(workspace, "p1", "intro", "v2")).rejects.toThrow("already exists");
  });
  it("updateWikiPage throws on missing", async () => {
    await makeProject();
    await expect(updateWikiPage(workspace, "p1", "missing", "x")).rejects.toThrow("not found");
  });
  it("updateWikiPage updates an existing page", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "intro", "v1");
    const r = await updateWikiPage(workspace, "p1", "intro", "v2");
    expect(r.body).toBe("v2");
    expect(r.version).toBe(2);
  });
});

describe("softDeleteWikiPage", () => {
  it("marks page deleted = true", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "intro", "body");
    const r = await softDeleteWikiPage(workspace, "p1", "intro");
    expect(r.frontmatter.deleted).toBe(true);
    // body preserved
    expect(r.body).toBe("body");
  });
  it("throws if page missing", async () => {
    await makeProject();
    await expect(softDeleteWikiPage(workspace, "p1", "ghost")).rejects.toThrow("not found");
  });
});

describe("searchWiki", () => {
  it("finds substring matches across pages", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "alpha", "the quick brown fox\njumps");
    await createWikiPage(workspace, "p1", "beta", "no match here");
    await createWikiPage(workspace, "p1", "gamma", "lazy dog rolls fox over");
    const hits = await searchWiki(workspace, "p1", "fox");
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.page).sort()).toEqual(["alpha", "gamma"]);
    expect(hits.find((h) => h.page === "alpha")?.line).toBe(1);
  });
  it("returns [] for empty query", async () => {
    await makeProject();
    expect(await searchWiki(workspace, "p1", "")).toEqual([]);
  });
  it("respects limit", async () => {
    await makeProject();
    await createWikiPage(workspace, "p1", "a", "match");
    await createWikiPage(workspace, "p1", "b", "match");
    await createWikiPage(workspace, "p1", "c", "match");
    expect((await searchWiki(workspace, "p1", "match", { limit: 2 })).length).toBe(2);
  });
  it("returns [] when project missing", async () => {
    expect(await searchWiki(workspace, "ghost", "x")).toEqual([]);
  });
});
