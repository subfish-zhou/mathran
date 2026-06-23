import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseToml } from "smol-toml";

import {
  listAllProjects,
  readProjectDetails,
  updateProjectMetadata,
  listDocPages,
  readDocPage,
  createDocPage,
  updateDocPage,
} from "./helpers.js";

let workspace: string;

async function makeProject(slug: string, tomlBody = `[project]\nname = "${slug}"\n`) {
  const dir = path.join(workspace, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "project.toml"), tomlBody);
  return dir;
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-projects-helpers-"));
});

describe("listAllProjects", () => {
  it("returns [] when projects dir missing", async () => {
    expect(await listAllProjects(workspace)).toEqual([]);
  });
  it("lists slugs sorted, with names from TOML", async () => {
    await makeProject("zeta", `[project]\nname = "Zeta!"\ncreated_at = "2026-01-01"\n`);
    await makeProject("alpha");
    const list = await listAllProjects(workspace);
    expect(list.map((p) => p.slug)).toEqual(["alpha", "zeta"]);
    expect(list[1].name).toBe("Zeta!");
    expect(list[1].created_at).toBe("2026-01-01");
  });
  it("falls back to slug when TOML missing/broken", async () => {
    const dir = path.join(workspace, "projects", "broken");
    await fs.mkdir(dir, { recursive: true });
    // no project.toml
    expect((await listAllProjects(workspace))[0]).toMatchObject({ slug: "broken", name: "broken" });
  });
});

describe("readProjectDetails", () => {
  it("returns null when missing", async () => {
    expect(await readProjectDetails(workspace, "ghost")).toBeNull();
  });
  it("returns slug + project + entries", async () => {
    await makeProject("p1");
    await fs.mkdir(path.join(workspace, "projects/p1/wiki"));
    const d = await readProjectDetails(workspace, "p1");
    expect(d?.slug).toBe("p1");
    expect(d?.entries).toContain("project.toml");
    expect(d?.entries).toContain("wiki/");
  });
  it("rejects invalid slug", async () => {
    await expect(readProjectDetails(workspace, "../etc")).rejects.toThrow("invalid project slug");
  });
});

describe("updateProjectMetadata", () => {
  it("updates name and preserves other fields", async () => {
    await makeProject("p1", `[project]\nname = "Old"\nmathran_version = "0.12.0"\n`);
    await updateProjectMetadata(workspace, "p1", { name: "New" });
    const raw = await fs.readFile(path.join(workspace, "projects/p1/project.toml"), "utf-8");
    const toml = parseToml(raw) as any;
    expect(toml.project.name).toBe("New");
    expect(toml.project.mathran_version).toBe("0.12.0");
  });
  it("updates description + tags", async () => {
    await makeProject("p1");
    await updateProjectMetadata(workspace, "p1", { description: "d", tags: ["x", "y"] });
    const toml = parseToml(
      await fs.readFile(path.join(workspace, "projects/p1/project.toml"), "utf-8"),
    ) as any;
    expect(toml.project.description).toBe("d");
    expect(toml.project.tags).toEqual(["x", "y"]);
  });
  it("throws when project missing", async () => {
    await expect(updateProjectMetadata(workspace, "ghost", { name: "x" })).rejects.toThrow(
      "project not found",
    );
  });
  it("throws when patch is empty", async () => {
    await makeProject("p1");
    await expect(updateProjectMetadata(workspace, "p1", {})).rejects.toThrow(
      "no recognised fields",
    );
  });
});

describe("doc pages", () => {
  it("listDocPages returns null when project missing", async () => {
    expect(await listDocPages(workspace, "ghost")).toBeNull();
  });
  it("listDocPages returns [] when docs dir missing", async () => {
    await makeProject("p1");
    expect(await listDocPages(workspace, "p1")).toEqual([]);
  });
  it("create + read + update flow", async () => {
    await makeProject("p1");
    await createDocPage(workspace, "p1", "design", "# Design\n");
    expect(await readDocPage(workspace, "p1", "design")).toBe("# Design\n");
    await updateDocPage(workspace, "p1", "design", "# Design v2\n");
    expect(await readDocPage(workspace, "p1", "design")).toBe("# Design v2\n");
    const pages = await listDocPages(workspace, "p1");
    expect(pages?.length).toBe(1);
    expect(pages?.[0].page).toBe("design");
  });
  it("createDocPage rejects duplicate", async () => {
    await makeProject("p1");
    await createDocPage(workspace, "p1", "design", "body");
    await expect(createDocPage(workspace, "p1", "design", "body2")).rejects.toThrow(
      "already exists",
    );
  });
  it("updateDocPage rejects missing", async () => {
    await makeProject("p1");
    await expect(updateDocPage(workspace, "p1", "ghost", "x")).rejects.toThrow("not found");
  });
  it("readDocPage returns null for missing", async () => {
    await makeProject("p1");
    expect(await readDocPage(workspace, "p1", "ghost")).toBeNull();
  });
});
