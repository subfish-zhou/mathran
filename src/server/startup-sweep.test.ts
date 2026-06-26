/**
 * Tests for the startup atomic-tmp sweeper (H8 audit follow-up).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { reapOldUploads, sweepAtomicTmpFiles } from "./startup-sweep.js";

async function mkTmpRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "mathran-sweep-test-"));
}

describe("sweepAtomicTmpFiles", () => {
  it("returns zeros for a non-existent directory", async () => {
    const result = await sweepAtomicTmpFiles("/no/such/path/should/not/exist");
    expect(result.removedFiles).toBe(0);
    expect(result.removedBytes).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("removes only files matching the atomic-write tmp pattern", async () => {
    const root = await mkTmpRoot();
    try {
      // Looks like atomic-write tmp: .tmp.<12 hex>
      await fs.writeFile(path.join(root, "real.json.tmp.deadbeef1234"), "x");
      await fs.writeFile(path.join(root, "other.json.tmp.cafebabef00d"), "yy");
      // Should NOT match (wrong length, not hex)
      await fs.writeFile(path.join(root, "preserved.tmp"), "keep me");
      await fs.writeFile(path.join(root, "real.json"), "keep me too");
      await fs.writeFile(path.join(root, "x.tmp.zzzz"), "keep me 3");
      await fs.writeFile(path.join(root, "x.tmp.aabbcc"), "keep me 4"); // only 6 hex

      const result = await sweepAtomicTmpFiles(root);
      expect(result.removedFiles).toBe(2);
      expect(result.removedBytes).toBe(3); // 1 + 2 bytes

      const remaining = (await fs.readdir(root)).sort();
      expect(remaining).toEqual([
        "preserved.tmp",
        "real.json",
        "x.tmp.aabbcc",
        "x.tmp.zzzz",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recurses into subdirectories", async () => {
    const root = await mkTmpRoot();
    try {
      const sub = path.join(root, "nested", "deeper");
      await fs.mkdir(sub, { recursive: true });
      await fs.writeFile(path.join(sub, "a.json.tmp.0123456789ab"), "xx");
      await fs.writeFile(path.join(sub, "a.json"), "real");

      const result = await sweepAtomicTmpFiles(root);
      expect(result.removedFiles).toBe(1);
      expect(result.removedBytes).toBe(2);
      // The directory walk should have visited root, nested, and deeper.
      expect(result.scannedDirs).toBeGreaterThanOrEqual(3);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow symlinks", async () => {
    const root = await mkTmpRoot();
    const outside = await mkTmpRoot();
    try {
      // A real tmp file outside the sweep root.
      await fs.writeFile(path.join(outside, "external.tmp.fedcba987654"), "z");
      // Symlink the outside dir into root — sweep should NOT follow it.
      await fs.symlink(outside, path.join(root, "out-link"));

      const result = await sweepAtomicTmpFiles(root);
      expect(result.removedFiles).toBe(0);
      // Symlinked target file must still exist.
      const stat = await fs.stat(path.join(outside, "external.tmp.fedcba987654"));
      expect(stat.isFile()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("reapOldUploads", () => {
  it("returns zeros when retentionDays <= 0 (disabled)", async () => {
    const root = await mkTmpRoot();
    try {
      await fs.writeFile(path.join(root, "old.txt"), "x");
      const r1 = await reapOldUploads(root, 0);
      expect(r1.scanned).toBe(0); // didn't even readdir
      expect(r1.removed).toBe(0);
      const r2 = await reapOldUploads(root, -5);
      expect(r2.removed).toBe(0);
      // File still there.
      expect((await fs.readdir(root))).toEqual(["old.txt"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns zeros for a non-existent uploads dir", async () => {
    const result = await reapOldUploads("/no/such/uploads/dir", 30);
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("deletes files older than retentionDays based on mtime", async () => {
    const root = await mkTmpRoot();
    try {
      const oldFile = path.join(root, "old.png");
      const freshFile = path.join(root, "fresh.png");
      await fs.writeFile(oldFile, "old");
      await fs.writeFile(freshFile, "fresh");
      // Backdate the old file's mtime by 45 days.
      const now = Date.now();
      const oldTime = new Date(now - 45 * 24 * 60 * 60 * 1000);
      await fs.utimes(oldFile, oldTime, oldTime);

      const result = await reapOldUploads(root, 30, now);
      expect(result.scanned).toBe(2);
      expect(result.removed).toBe(1);
      expect(result.removedBytes).toBe(3); // "old"

      const remaining = (await fs.readdir(root));
      expect(remaining).toEqual(["fresh.png"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not recurse into subdirectories (uploads are flat)", async () => {
    const root = await mkTmpRoot();
    try {
      const sub = path.join(root, "ignore-me");
      await fs.mkdir(sub);
      const oldInsideSub = path.join(sub, "nested-old.txt");
      await fs.writeFile(oldInsideSub, "x");
      const now = Date.now();
      const oldTime = new Date(now - 99 * 24 * 60 * 60 * 1000);
      await fs.utimes(oldInsideSub, oldTime, oldTime);

      const result = await reapOldUploads(root, 30, now);
      // Subdirectory contents must NOT be touched — uploads are flat
      // and a directory under there is suspicious / shouldn't exist.
      expect(result.removed).toBe(0);
      expect(await fs.readdir(sub)).toEqual(["nested-old.txt"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
