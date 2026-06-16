/**
 * Unit tests for the filesystem-backed Effort store (T1-B).
 *
 * All operations are exercised against a temp workspace; we never touch the
 * user's real ~/mathran-workspace. Path-traversal tests guard BUG #5's
 * companion check at the effort layer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  initEffort,
  listEfforts,
  readEffortMetadata,
  writeEffortMetadata,
  updateEffortMetadata,
  readEffortDocument,
  writeEffortDocument,
  listEffortFiles,
  readEffortFile,
  writeEffortFile,
  snapshotEffort,
  listSnapshots,
  effortDirFor,
  isSafeFilePath,
} from "./store.js";
import { BUILTIN_EFFORT_TYPES } from "./types.js";

let workspace: string;
const PROJECT = "tau-project";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-test-"));
  await fs.mkdir(path.join(workspace, "projects", PROJECT), { recursive: true });
});

describe("initEffort + listEfforts", () => {
  it("scaffolds an effort with metadata, document, and files/ directory", async () => {
    const r = await initEffort(workspace, PROJECT, {
      title: "Lemma A",
      type: "PROOF_ATTEMPT",
    });
    expect(r.slug).toBe("lemma-a");
    expect(r.metadata.title).toBe("Lemma A");
    expect(r.metadata.type).toBe("PROOF_ATTEMPT");
    expect(r.metadata.status).toBe("DRAFT");
    expect(r.metadata.currentVersion).toBe(0);

    // On disk
    const dir = effortDirFor(workspace, PROJECT, "lemma-a");
    expect(await fs.stat(path.join(dir, "effort.toml"))).toBeTruthy();
    expect(await fs.stat(path.join(dir, "document.md"))).toBeTruthy();
    expect(await fs.stat(path.join(dir, "files"))).toBeTruthy();
  });

  it("listEfforts returns all efforts sorted by slug", async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma B", type: "ESTIMATE" });
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
    await initEffort(workspace, PROJECT, { title: "Lemma C", type: "FORMALIZATION" });
    const efforts = await listEfforts(workspace, PROJECT);
    expect(efforts.map((e) => e.slug)).toEqual(["lemma-a", "lemma-b", "lemma-c"]);
  });

  it("rejects invalid effort type", async () => {
    await expect(
      initEffort(workspace, PROJECT, { title: "X", type: "BOGUS" as any }),
    ).rejects.toThrow(/invalid effort type/);
  });

  it("rejects creation when project doesn't exist", async () => {
    await expect(
      initEffort(workspace, "no-such-project", { title: "X", type: "PROOF_ATTEMPT" }),
    ).rejects.toThrow(/project not found/);
  });

  it("rejects duplicate slug unless force=true", async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
    await expect(
      initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" }),
    ).rejects.toThrow(/already exists/);
    // force=true overwrites
    const r = await initEffort(workspace, PROJECT, {
      title: "Lemma A",
      type: "ESTIMATE",
      force: true,
    });
    expect(r.metadata.type).toBe("ESTIMATE");
  });

  it("skips malformed efforts during listEfforts instead of throwing", async () => {
    await initEffort(workspace, PROJECT, { title: "Good", type: "PROOF_ATTEMPT" });
    // Place a junk subdirectory that looks like an effort but isn't.
    const bad = path.join(workspace, "projects", PROJECT, "efforts", "bad");
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, "effort.toml"), "garbage = no quotes [", "utf-8");
    const efforts = await listEfforts(workspace, PROJECT);
    expect(efforts.map((e) => e.slug)).toEqual(["good"]);
  });
});

describe("metadata + document round-trip", () => {
  beforeEach(async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
  });

  it("readEffortMetadata returns the canonical metadata", async () => {
    const meta = await readEffortMetadata(workspace, PROJECT, "lemma-a");
    expect(meta?.title).toBe("Lemma A");
    expect(meta?.type).toBe("PROOF_ATTEMPT");
  });

  it("updateEffortMetadata applies a partial patch + bumps updatedAt", async () => {
    const before = await readEffortMetadata(workspace, PROJECT, "lemma-a");
    await new Promise((r) => setTimeout(r, 5)); // ensure timestamp differs
    const updated = await updateEffortMetadata(workspace, PROJECT, "lemma-a", {
      title: "Lemma A (revised)",
      status: "PROMISING",
    });
    expect(updated.title).toBe("Lemma A (revised)");
    expect(updated.status).toBe("PROMISING");
    expect(updated.updatedAt).not.toBe(before?.updatedAt);
  });

  it("rejects invalid status enum values silently (keeps old value)", async () => {
    const updated = await updateEffortMetadata(workspace, PROJECT, "lemma-a", {
      status: "TOTALLY_FAKE" as any,
    });
    expect(updated.status).toBe("DRAFT");
  });

  it("writeEffortDocument + readEffortDocument round-trips", async () => {
    expect(await readEffortDocument(workspace, PROJECT, "lemma-a")).toBe("");
    await writeEffortDocument(workspace, PROJECT, "lemma-a", "# Lemma A\n\nProof…");
    expect(await readEffortDocument(workspace, PROJECT, "lemma-a")).toContain("# Lemma A");
  });

  it("writeEffortDocument bumps metadata.updatedAt", async () => {
    const before = await readEffortMetadata(workspace, PROJECT, "lemma-a");
    await new Promise((r) => setTimeout(r, 5));
    await writeEffortDocument(workspace, PROJECT, "lemma-a", "body");
    const after = await readEffortMetadata(workspace, PROJECT, "lemma-a");
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
  });
});

describe("file r/w + listing", () => {
  beforeEach(async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
  });

  it("write/read round-trips a single file under files/", async () => {
    await writeEffortFile(workspace, PROJECT, "lemma-a", "proof.lean", "theorem t : 1 = 1 := by rfl");
    const content = await readEffortFile(workspace, PROJECT, "lemma-a", "proof.lean");
    expect(content).toContain("rfl");
  });

  it("listEffortFiles walks subdirectories", async () => {
    await writeEffortFile(workspace, PROJECT, "lemma-a", "a.lean", "a");
    await writeEffortFile(workspace, PROJECT, "lemma-a", "sub/b.lean", "b");
    await writeEffortFile(workspace, PROJECT, "lemma-a", "sub/nested/c.lean", "c");
    const files = await listEffortFiles(workspace, PROJECT, "lemma-a");
    expect(files).toEqual(["a.lean", "sub/b.lean", "sub/nested/c.lean"]);
  });

  it("rejects path-traversal payloads (BUG #5 at effort layer)", async () => {
    expect(isSafeFilePath("../etc/passwd")).toBe(false);
    expect(isSafeFilePath("/etc/passwd")).toBe(false);
    expect(isSafeFilePath("a/../b")).toBe(false);
    expect(isSafeFilePath("a/../../b")).toBe(false);
    expect(isSafeFilePath("a/b/c.lean")).toBe(true);
    await expect(
      writeEffortFile(workspace, PROJECT, "lemma-a", "../escape.txt", "x"),
    ).rejects.toThrow(/invalid file path/);
  });
});

describe("snapshot + version listing", () => {
  beforeEach(async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
    await writeEffortDocument(workspace, PROJECT, "lemma-a", "# v1");
    await writeEffortFile(workspace, PROJECT, "lemma-a", "f.lean", "f1");
  });

  it("snapshotEffort copies document.md + files/ to .versions/v<N+1>/ and bumps currentVersion", async () => {
    const v1 = await snapshotEffort(workspace, PROJECT, "lemma-a");
    expect(v1).toBe(1);
    const meta = await readEffortMetadata(workspace, PROJECT, "lemma-a");
    expect(meta?.currentVersion).toBe(1);

    const dir = effortDirFor(workspace, PROJECT, "lemma-a");
    const doc1 = await fs.readFile(path.join(dir, ".versions", "v1", "document.md"), "utf-8");
    expect(doc1).toBe("# v1");
    const file1 = await fs.readFile(path.join(dir, ".versions", "v1", "files", "f.lean"), "utf-8");
    expect(file1).toBe("f1");
  });

  it("subsequent snapshot increments to v2 and listSnapshots returns both", async () => {
    await snapshotEffort(workspace, PROJECT, "lemma-a");
    await writeEffortDocument(workspace, PROJECT, "lemma-a", "# v2");
    const v2 = await snapshotEffort(workspace, PROJECT, "lemma-a");
    expect(v2).toBe(2);
    expect(await listSnapshots(workspace, PROJECT, "lemma-a")).toEqual([1, 2]);
    // v2 captures the new doc
    const dir = effortDirFor(workspace, PROJECT, "lemma-a");
    const doc2 = await fs.readFile(path.join(dir, ".versions", "v2", "document.md"), "utf-8");
    expect(doc2).toBe("# v2");
  });

  it("snapshot of a non-existent effort throws", async () => {
    await expect(snapshotEffort(workspace, PROJECT, "ghost")).rejects.toThrow(/not found/);
  });
});

describe("BUILTIN_EFFORT_TYPES sanity (mathub parity)", () => {
  it("exposes all 9 mathub builtin types", () => {
    expect(BUILTIN_EFFORT_TYPES).toEqual([
      "CONSTRUCTION",
      "PROOF_ATTEMPT",
      "ESTIMATE",
      "COUNTEREXAMPLE",
      "COMPUTATION",
      "REDUCTION",
      "FORMALIZATION",
      "AUXILIARY",
      "REFERENCE",
    ]);
  });
});
