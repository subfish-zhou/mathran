import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { snapshotFile } from "../snapshot.js";
import { MAX_SNAPSHOT_BYTES } from "../schema.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ckpt-snap-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("snapshotFile", () => {
  it("returns absent for a missing file", async () => {
    const snap = await snapshotFile(path.join(dir, "nope.txt"));
    expect(snap).toEqual({ kind: "absent" });
  });

  it("captures UTF-8 text for a normal file", async () => {
    const p = path.join(dir, "a.txt");
    await fs.writeFile(p, "héllo\nworld\n");
    const snap = await snapshotFile(p);
    expect(snap).toEqual({ kind: "text", content: "héllo\nworld\n" });
  });

  it("returns absent for a directory", async () => {
    const p = path.join(dir, "sub");
    await fs.mkdir(p);
    expect(await snapshotFile(p)).toEqual({ kind: "absent" });
  });

  it("stores only size + sha256 for a file over the cap", async () => {
    const p = path.join(dir, "big.bin");
    const big = Buffer.alloc(MAX_SNAPSHOT_BYTES + 10, 0x41);
    await fs.writeFile(p, big);
    const snap = await snapshotFile(p);
    expect(snap.kind).toBe("large");
    if (snap.kind === "large") {
      expect(snap.size).toBe(MAX_SNAPSHOT_BYTES + 10);
      expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
