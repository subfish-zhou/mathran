import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  createArtifactDir,
  writeArtifact,
  readArtifact,
  listArtifactRuns,
} from "../artifact.js";

describe("subagent artifact IO", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-subagent-test-"));
  });

  it("createArtifactDir creates .mathran/subagents/<runId>/ exactly", async () => {
    const dir = await createArtifactDir(workspace, "sub-aabbccdd");
    const expected = path.join(workspace, ".mathran", "subagents", "sub-aabbccdd");
    expect(dir).toBe(expected);
    const st = await fs.stat(expected);
    expect(st.isDirectory()).toBe(true);
  });

  it("writeArtifact returns POSIX relative path and creates the file", async () => {
    const rel = await writeArtifact(workspace, "sub-11223344", "output.txt", "hello");
    expect(rel).toBe(".mathran/subagents/sub-11223344/output.txt");
    const st = await fs.stat(path.join(workspace, rel));
    expect(st.isFile()).toBe(true);
  });

  it("writeArtifact with Buffer payload round-trips bytes", async () => {
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const rel = await writeArtifact(workspace, "sub-buf00001", "blob.bin", payload);
    const read = await fs.readFile(path.join(workspace, rel));
    expect(Buffer.compare(read, payload)).toBe(0);
  });

  it("readArtifact returns the same string bytes", async () => {
    const content = "the quick brown fox";
    await writeArtifact(workspace, "sub-str00001", "note.txt", content);
    const read = await readArtifact(workspace, "sub-str00001", "note.txt");
    expect(read).toBe(content);
  });

  it("listArtifactRuns returns all runIds and filters dot files", async () => {
    await createArtifactDir(workspace, "sub-aaaaaaaa");
    await createArtifactDir(workspace, "sub-bbbbbbbb");
    await fs.writeFile(
      path.join(workspace, ".mathran", "subagents", ".gitkeep"),
      "",
    );
    const runs = await listArtifactRuns(workspace);
    expect(runs.sort()).toEqual(["sub-aaaaaaaa", "sub-bbbbbbbb"]);
  });

  it("multiple writes under same runId co-exist", async () => {
    await writeArtifact(workspace, "sub-multi001", "a.txt", "A");
    await writeArtifact(workspace, "sub-multi001", "b.txt", "B");
    expect(await readArtifact(workspace, "sub-multi001", "a.txt")).toBe("A");
    expect(await readArtifact(workspace, "sub-multi001", "b.txt")).toBe("B");
  });

  it("listArtifactRuns on a workspace without subagents dir returns []", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-subagent-empty-"));
    await expect(listArtifactRuns(empty)).resolves.toEqual([]);
  });
});
