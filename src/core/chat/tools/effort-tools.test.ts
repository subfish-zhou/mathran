/**
 * Tests for the effort chat tools (gap #1).
 *
 * Covers: list_efforts, read_effort, create_effort, update_effort_document,
 * append_effort_document, update_effort_metadata, transition_effort_status,
 * snapshot_effort, list_effort_versions, read_effort_version,
 * add_effort_relation, list_effort_relations.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { createListEffortsTool } from "./list-efforts.js";
import { createReadEffortTool } from "./read-effort.js";
import { createCreateEffortTool } from "./create-effort.js";
import { createUpdateEffortDocumentTool } from "./update-effort-document.js";
import { createAppendEffortDocumentTool } from "./append-effort-document.js";
import { createUpdateEffortMetadataTool } from "./update-effort-metadata.js";
import { createTransitionEffortStatusTool } from "./transition-effort-status.js";
import { createSnapshotEffortTool } from "./snapshot-effort.js";
import { createListEffortVersionsTool } from "./list-effort-versions.js";
import { createReadEffortVersionTool } from "./read-effort-version.js";
import { createAddEffortRelationTool } from "./add-effort-relation.js";
import { createListEffortRelationsTool } from "./list-effort-relations.js";

let workspace: string;

async function makeProject(slug = "p1") {
  const dir = path.join(workspace, "projects", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "project.toml"), `[project]\nname = "${slug}"\n`);
  return dir;
}

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-tool-"));
});

describe("create_effort", () => {
  it("scaffolds with type=PROOF_ATTEMPT", async () => {
    await makeProject();
    const tool = createCreateEffortTool({ workspace });
    const r = await tool.execute({
      project: "p1",
      title: "My Proof",
      type: "PROOF_ATTEMPT",
    });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.type).toBe("PROOF_ATTEMPT");
    expect(data.status).toBe("DRAFT");
    expect(data.slug).toMatch(/my-proof/);
  });
  it("rejects invalid type", async () => {
    await makeProject();
    const tool = createCreateEffortTool({ workspace });
    const r = await tool.execute({ project: "p1", title: "X", type: "FAKE_TYPE" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("invalid type");
  });
  it("requires title", async () => {
    const tool = createCreateEffortTool({ workspace });
    const r = await tool.execute({ project: "p1", type: "PROOF_ATTEMPT" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("requires 'title'");
  });
});

describe("list_efforts + read_effort", () => {
  it("lists efforts and reads one", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    await create.execute({ project: "p1", title: "Alpha", type: "PROOF_ATTEMPT" });
    await create.execute({ project: "p1", title: "Beta", type: "COMPUTATION" });
    const list = createListEffortsTool({ workspace });
    const lr = await list.execute({ project: "p1" });
    expect(lr.ok).toBe(true);
    const data = JSON.parse(lr.content);
    expect(data.count).toBe(2);
    const read = createReadEffortTool({ workspace });
    const slug = data.efforts[0].slug;
    const rr = await read.execute({ project: "p1", effort: slug });
    expect(rr.ok).toBe(true);
    expect(JSON.parse(rr.content).metadata.slug).toBe(slug);
  });
  it("read_effort fails when missing", async () => {
    await makeProject();
    const tool = createReadEffortTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: "ghost" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});

describe("update_effort_document + append_effort_document", () => {
  it("write then append", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    const c = await create.execute({ project: "p1", title: "Doc", type: "PROOF_ATTEMPT" });
    const slug = JSON.parse(c.content).slug;
    const update = createUpdateEffortDocumentTool({ workspace });
    const u = await update.execute({ project: "p1", effort: slug, body: "v1\n" });
    expect(u.ok).toBe(true);
    const append = createAppendEffortDocumentTool({ workspace });
    const a = await append.execute({ project: "p1", effort: slug, body: "more\n" });
    expect(a.ok).toBe(true);
    const file = path.join(workspace, "projects/p1/efforts", slug, "document.md");
    const raw = await fs.readFile(file, "utf-8");
    expect(raw).toContain("v1");
    expect(raw).toContain("more");
  });
  it("update_effort_document requires body", async () => {
    const tool = createUpdateEffortDocumentTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("requires 'body'");
  });
});

describe("update_effort_metadata", () => {
  it("updates title + description", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    const c = await create.execute({ project: "p1", title: "Old", type: "PROOF_ATTEMPT" });
    const slug = JSON.parse(c.content).slug;
    const tool = createUpdateEffortMetadataTool({ workspace });
    const r = await tool.execute({
      project: "p1",
      effort: slug,
      title: "New",
      description: "abstract here",
    });
    expect(r.ok).toBe(true);
    const data = JSON.parse(r.content);
    expect(data.title).toBe("New");
    expect(data.description).toBe("abstract here");
  });
  it("requires at least one field", async () => {
    await makeProject();
    const tool = createUpdateEffortMetadataTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: "x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("no fields");
  });
  it("rejects invalid status", async () => {
    await makeProject();
    const tool = createUpdateEffortMetadataTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: "x", status: "WAT" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("invalid status");
  });
});

describe("transition_effort_status", () => {
  it("DRAFT → PROPOSED works", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    const c = await create.execute({ project: "p1", title: "T", type: "PROOF_ATTEMPT" });
    const slug = JSON.parse(c.content).slug;
    const tool = createTransitionEffortStatusTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: slug, to: "PROPOSED" });
    expect(r.ok).toBe(true);
  });
  it("DEAD_END without reason fails", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    const c = await create.execute({ project: "p1", title: "T", type: "PROOF_ATTEMPT" });
    const slug = JSON.parse(c.content).slug;
    const tool = createTransitionEffortStatusTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: slug, to: "DEAD_END" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("missing-reason");
  });
  it("invalid status rejected", async () => {
    const tool = createTransitionEffortStatusTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: "x", to: "WAT" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("invalid target status");
  });
});

describe("snapshot_effort + list_effort_versions + read_effort_version", () => {
  it("snapshot bumps currentVersion and is readable", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    const c = await create.execute({ project: "p1", title: "T", type: "PROOF_ATTEMPT" });
    const slug = JSON.parse(c.content).slug;
    await createUpdateEffortDocumentTool({ workspace }).execute({
      project: "p1",
      effort: slug,
      body: "v1 body\n",
    });
    const snap = createSnapshotEffortTool({ workspace });
    const sr = await snap.execute({ project: "p1", effort: slug });
    expect(sr.ok).toBe(true);
    expect(JSON.parse(sr.content).version).toBe(1);
    const list = createListEffortVersionsTool({ workspace });
    const lr = await list.execute({ project: "p1", effort: slug });
    expect(lr.ok).toBe(true);
    expect(JSON.parse(lr.content).versions).toEqual([1]);
    const read = createReadEffortVersionTool({ workspace });
    const rr = await read.execute({ project: "p1", effort: slug, version: 1 });
    expect(rr.ok).toBe(true);
    expect(JSON.parse(rr.content).document).toContain("v1 body");
  });
  it("read_effort_version returns ok=false for missing version", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    const c = await create.execute({ project: "p1", title: "T", type: "PROOF_ATTEMPT" });
    const slug = JSON.parse(c.content).slug;
    const tool = createReadEffortVersionTool({ workspace });
    const r = await tool.execute({ project: "p1", effort: slug, version: 99 });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
});

describe("add_effort_relation + list_effort_relations", () => {
  it("adds + lists", async () => {
    await makeProject();
    const create = createCreateEffortTool({ workspace });
    const a = await create.execute({ project: "p1", title: "A", type: "CONSTRUCTION" });
    const b = await create.execute({ project: "p1", title: "B", type: "PROOF_ATTEMPT" });
    const aSlug = JSON.parse(a.content).slug;
    const bSlug = JSON.parse(b.content).slug;
    const add = createAddEffortRelationTool({ workspace });
    const ar = await add.execute({
      project: "p1",
      from: bSlug,
      to: aSlug,
      type: "depends_on",
    });
    expect(ar.ok).toBe(true);
    const list = createListEffortRelationsTool({ workspace });
    const lr = await list.execute({ project: "p1", effort: bSlug });
    expect(lr.ok).toBe(true);
    const data = JSON.parse(lr.content);
    expect(data.outgoing.length).toBe(1);
    expect(data.outgoing[0].to).toBe(aSlug);
    const all = await list.execute({ project: "p1" });
    expect(JSON.parse(all.content).count).toBe(1);
  });
  it("rejects when endpoints missing", async () => {
    await makeProject();
    const tool = createAddEffortRelationTool({ workspace });
    const r = await tool.execute({
      project: "p1",
      from: "ghost-a",
      to: "ghost-b",
      type: "depends_on",
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });
  it("rejects invalid relation type", async () => {
    const tool = createAddEffortRelationTool({ workspace });
    const r = await tool.execute({
      project: "p1",
      from: "a",
      to: "b",
      type: "WAT",
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("invalid relation type");
  });
  it("rejects from === to", async () => {
    const tool = createAddEffortRelationTool({ workspace });
    const r = await tool.execute({
      project: "p1",
      from: "a",
      to: "a",
      type: "depends_on",
    });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("must differ");
  });
});
