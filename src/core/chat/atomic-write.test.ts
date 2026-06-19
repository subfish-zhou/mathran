/**
 * Unit tests for `atomicWriteFile` (T3 / v0.2 §3).
 *
 * Verifies the temp-file + rename strategy: successful writes land exactly,
 * and simulated failures (writeFile / rename throwing) leave the target
 * untouched while cleaning up the temp file.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { atomicWriteFile } from "./atomic-write.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-atomic-test-"));
});

async function listTemps(d: string): Promise<string[]> {
  const entries = await fs.readdir(d);
  return entries.filter((e) => e.includes(".tmp."));
}

describe("atomicWriteFile", () => {
  it("writes a new file with the given content", async () => {
    const target = path.join(dir, "new.txt");
    await atomicWriteFile(target, "hello world");
    expect(await fs.readFile(target, "utf-8")).toBe("hello world");
    expect(await listTemps(dir)).toEqual([]);
  });

  it("overwrites an existing file, replacing content", async () => {
    const target = path.join(dir, "existing.txt");
    await fs.writeFile(target, "old content", "utf-8");
    await atomicWriteFile(target, "new content");
    expect(await fs.readFile(target, "utf-8")).toBe("new content");
    expect(await listTemps(dir)).toEqual([]);
  });

  it("leaves target unchanged and cleans up temp when the write fails", async () => {
    const target = path.join(dir, "keep.txt");
    await fs.writeFile(target, "preserved", "utf-8");

    // Make the directory read-only so creating the temp file fails (EACCES).
    await fs.chmod(dir, 0o555);
    try {
      await expect(atomicWriteFile(target, "should not land")).rejects.toThrow();
      expect(await fs.readFile(target, "utf-8")).toBe("preserved");
    } finally {
      await fs.chmod(dir, 0o755);
    }
    expect(await listTemps(dir)).toEqual([]);
  });

  it("leaves target unchanged when rename fails and cleans up temp", async () => {
    // A directory target makes the final rename(file → dir) fail.
    const target = path.join(dir, "keepdir");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "marker.txt"), "x", "utf-8");

    await expect(atomicWriteFile(target, "should not land")).rejects.toThrow();

    expect((await fs.stat(target)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(target, "marker.txt"), "utf-8")).toBe("x");
    expect(await listTemps(dir)).toEqual([]);
  });

  it("writes a Buffer payload", async () => {
    const target = path.join(dir, "buf.bin");
    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await atomicWriteFile(target, payload);
    const onDisk = await fs.readFile(target);
    expect(Buffer.compare(onDisk, payload)).toBe(0);
  });

  it("concurrent writes to different targets do not interfere", async () => {
    const targets = Array.from({ length: 8 }, (_, i) => path.join(dir, `c${i}.txt`));
    await Promise.all(targets.map((t, i) => atomicWriteFile(t, `content-${i}`)));
    for (let i = 0; i < targets.length; i++) {
      expect(await fs.readFile(targets[i], "utf-8")).toBe(`content-${i}`);
    }
    expect(await listTemps(dir)).toEqual([]);
  });
});
