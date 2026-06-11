/**
 * Unit tests for LocalFsArtifactSink.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { LocalFsArtifactSink } from "./local-fs.js";

let tmpDir: string;
let sink: LocalFsArtifactSink;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-test-sink-"));
  sink = new LocalFsArtifactSink(tmpDir);
});

describe("LocalFsArtifactSink", () => {
  it("describes itself", async () => {
    const d = await sink.describe();
    expect(d.name).toMatch(/local-fs/);
  });

  it("createPage writes markdown with frontmatter", async () => {
    const p = await sink.createPage({
      title: "My Page",
      body: "hello body",
      authorId: "u1",
      tags: ["tag1", "tag2"],
    });
    expect(p.slug).toBe("my-page");
    const file = await fs.readFile(path.join(tmpDir, "pages", "my-page.md"), "utf-8");
    expect(file).toMatch(/^---/);
    expect(file).toContain('title: "My Page"');
    expect(file).toContain("tag1");
    expect(file).toContain("hello body");
  });

  it("creates unique slugs on title collision", async () => {
    const a = await sink.createPage({ title: "Same", body: "", authorId: "u1" });
    const b = await sink.createPage({ title: "Same", body: "", authorId: "u1" });
    expect(a.slug).toBe("same");
    expect(b.slug).toBe("same-2");
  });

  it("updatePage rewrites body + bumps updatedAt", async () => {
    const p = await sink.createPage({ title: "T", body: "v1", authorId: "u1" });
    await new Promise((r) => setTimeout(r, 5));
    await sink.updatePage(p.id, { body: "v2" });
    const file = await fs.readFile(path.join(tmpDir, "pages", p.slug + ".md"), "utf-8");
    expect(file).toContain("v2");
    expect(file).not.toContain("v1");
  });

  it("commit appends to commits list and returns sha", async () => {
    const p = await sink.createPage({ title: "T", body: "v1", authorId: "u1" });
    const c = await sink.commit({ pageId: p.id, body: "v2", authorId: "u1", message: "msg" });
    expect(c.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const idx = JSON.parse(
      await fs.readFile(path.join(tmpDir, "pages.index.json"), "utf-8"),
    );
    expect(idx[p.id].commits).toHaveLength(1);
    expect(idx[p.id].commits[0].message).toBe("msg");
  });

  it("notify appends NDJSON line", async () => {
    await sink.notify("u1", { kind: "test", title: "hi" });
    await sink.notify("u2", { kind: "test", title: "bye" });
    const content = await fs.readFile(path.join(tmpDir, "notifications.jsonl"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).userId).toBe("u1");
  });

  it("postActivity appends NDJSON line", async () => {
    await sink.postActivity({
      actorId: "u1",
      verb: "created",
      objectType: "page",
      objectId: "x",
    });
    const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
    expect(JSON.parse(content.trim()).verb).toBe("created");
  });
});
