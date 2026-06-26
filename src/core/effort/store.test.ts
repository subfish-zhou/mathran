/**
 * Unit tests for the filesystem-backed Effort store (T1-B).
 *
 * All operations are exercised against a temp workspace; we never touch the
 * user's real ~/mathran-workspace. Path-traversal tests guard BUG #5's
 * companion check at the effort layer.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  appendEffortDocument,
  listEffortFiles,
  readEffortFile,
  writeEffortFile,
  snapshotEffort,
  listSnapshots,
  effortDirFor,
  isSafeFilePath,
  transitionEffortStatus,
  addRelation,
  listAllRelations,
  listEffortRelations,
  listEffortDependents,
  removeRelation,
  slugifyTitle,
  attachReference,
  listReferences,
  recordArtifact,
  listArtifacts,
} from "./store.js";
import { BUILTIN_EFFORT_TYPES, EFFORT_STATUSES, isValidTransition, VALID_TRANSITIONS } from "./types.js";

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

  it("appendEffortDocument appends to the existing document.md (twice)", async () => {
    await writeEffortDocument(workspace, PROJECT, "lemma-a", "# Lemma A\n");
    await appendEffortDocument(workspace, PROJECT, "lemma-a", "\n---\n## First\n\nfirst chunk\n");
    await appendEffortDocument(workspace, PROJECT, "lemma-a", "\n---\n## Second\n\nsecond chunk\n");
    const body = await readEffortDocument(workspace, PROJECT, "lemma-a");
    expect(body).toContain("# Lemma A");
    expect(body).toContain("## First");
    expect(body).toContain("first chunk");
    expect(body).toContain("## Second");
    expect(body).toContain("second chunk");
    // First chunk comes before second chunk.
    expect((body ?? "").indexOf("## First")).toBeLessThan((body ?? "").indexOf("## Second"));
  });

  it("appendEffortDocument bumps metadata.updatedAt", async () => {
    const before = await readEffortMetadata(workspace, PROJECT, "lemma-a");
    await new Promise((r) => setTimeout(r, 5));
    await appendEffortDocument(workspace, PROJECT, "lemma-a", "appended");
    const after = await readEffortMetadata(workspace, PROJECT, "lemma-a");
    expect(after?.updatedAt).not.toBe(before?.updatedAt);
  });

  it("appendEffortDocument throws when the effort directory does not exist", async () => {
    await expect(
      appendEffortDocument(workspace, PROJECT, "ghost-effort", "x"),
    ).rejects.toThrow(/effort not found/);
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
  it("exposes 8 builtin types (REFERENCE moved to status per GAP #9)", () => {
    expect(BUILTIN_EFFORT_TYPES).toEqual([
      "CONSTRUCTION",
      "PROOF_ATTEMPT",
      "ESTIMATE",
      "COUNTEREXAMPLE",
      "COMPUTATION",
      "REDUCTION",
      "FORMALIZATION",
      "AUXILIARY",
    ]);
  });
});

// ─── GAP #9: status state-machine + relations ──────────────────────────────

describe("EFFORT_STATUSES + VALID_TRANSITIONS (mathub parity)", () => {
  it("exposes the 11 mathub status ids plus ARCHIVED", () => {
    expect(EFFORT_STATUSES).toEqual([
      "DRAFT",
      "PROPOSED",
      "UNDER_REVIEW",
      "PROMISING",
      "VERIFIED",
      "MERGED",
      "REFERENCE",
      "DEAD_END",
      "SUPERSEDED",
      "ERRATUM",
      "ARCHIVED",
    ]);
  });

  it("isValidTransition agrees with VALID_TRANSITIONS table", () => {
    expect(isValidTransition("DRAFT", "PROPOSED")).toBe(true);
    expect(isValidTransition("DRAFT", "VERIFIED")).toBe(false);
    expect(isValidTransition("ARCHIVED", "DRAFT")).toBe(false);
    expect(isValidTransition("PROMISING", "VERIFIED")).toBe(true);
    expect(isValidTransition("DRAFT", "DRAFT")).toBe(false);
    // ARCHIVED is reachable from every non-terminal status.
    for (const s of EFFORT_STATUSES) {
      if (s === "ARCHIVED") continue;
      expect(VALID_TRANSITIONS[s]).toContain("ARCHIVED");
    }
  });
});

describe("transitionEffortStatus (GAP #9)", () => {
  it("DRAFT → PROPOSED records a statusHistory entry", async () => {
    await initEffort(workspace, PROJECT, {
      title: "T1",
      type: "PROOF_ATTEMPT",
    });
    const r = await transitionEffortStatus(workspace, PROJECT, "t1", { to: "PROPOSED" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.metadata.status).toBe("PROPOSED");
    expect(r.metadata.statusHistory).toHaveLength(2);
    expect(r.metadata.statusHistory?.at(-1)).toMatchObject({ from: "DRAFT", to: "PROPOSED" });
  });

  it("rejects an invalid transition with the allowed list", async () => {
    await initEffort(workspace, PROJECT, {
      title: "T2",
      type: "PROOF_ATTEMPT",
    });
    const r = await transitionEffortStatus(workspace, PROJECT, "t2", { to: "VERIFIED" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("invalid-transition");
    if (r.reason !== "invalid-transition") throw new Error("expected invalid-transition");
    expect(r.allowed).toContain("PROPOSED");
    expect(r.allowed).not.toContain("VERIFIED");
  });

  it("DEAD_END requires a reason", async () => {
    await initEffort(workspace, PROJECT, { title: "T3", type: "PROOF_ATTEMPT" });
    const noReason = await transitionEffortStatus(workspace, PROJECT, "t3", { to: "DEAD_END" });
    expect(noReason.ok).toBe(false);
    if (noReason.ok) throw new Error();
    expect(noReason.reason).toBe("missing-reason");
    const withReason = await transitionEffortStatus(workspace, PROJECT, "t3", {
      to: "DEAD_END",
      reason: "induction step does not close",
    });
    expect(withReason.ok).toBe(true);
    if (!withReason.ok) throw new Error();
    expect(withReason.metadata.status).toBe("DEAD_END");
    expect(withReason.metadata.statusHistory?.at(-1)?.reason).toMatch(/induction/);
  });

  it("SUPERSEDED requires supersededBy + target must exist", async () => {
    await initEffort(workspace, PROJECT, { title: "T4", type: "PROOF_ATTEMPT" });
    const missing = await transitionEffortStatus(workspace, PROJECT, "t4", { to: "SUPERSEDED" });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error();
    expect(missing.reason).toBe("missing-reason");

    const self = await transitionEffortStatus(workspace, PROJECT, "t4", {
      to: "SUPERSEDED",
      supersededBy: "t4",
    });
    expect(self.ok).toBe(false);
    if (self.ok) throw new Error();
    expect(self.reason).toBe("supersedes-self");

    const ghost = await transitionEffortStatus(workspace, PROJECT, "t4", {
      to: "SUPERSEDED",
      supersededBy: "nonesuch",
    });
    expect(ghost.ok).toBe(false);
    if (ghost.ok) throw new Error();
    expect(ghost.reason).toBe("supersededBy-not-found");

    // Create the target, then it should work — and auto-write a supersedes edge.
    await initEffort(workspace, PROJECT, { title: "T5", type: "PROOF_ATTEMPT" });
    const ok = await transitionEffortStatus(workspace, PROJECT, "t4", {
      to: "SUPERSEDED",
      supersededBy: "t5",
      reason: "cleaner approach",
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error();
    expect(ok.metadata.status).toBe("SUPERSEDED");

    const edges = await listEffortRelations(workspace, PROJECT, "t4");
    expect(edges.some((e) => e.to === "t5" && e.type === "supersedes")).toBe(true);
  });

  it("not-found when the effort does not exist", async () => {
    const r = await transitionEffortStatus(workspace, PROJECT, "ghost", { to: "PROPOSED" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("not-found");
  });
});

describe("legacy compat: type=REFERENCE migrates to status=REFERENCE", () => {
  it("reads pre-GAP-#9 effort.toml with type=\"REFERENCE\" and remaps it", async () => {
    // Hand-write an old-style effort.toml.
    const dir = effortDirFor(workspace, PROJECT, "legacy-ref");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "effort.toml"),
      `[effort]
id = "11111111-1111-1111-1111-111111111111"
slug = "legacy-ref"
title = "Old Ref"
type = "REFERENCE"
status = "PROMISING"
description = ""
currentVersion = 0
createdAt = "2026-01-01T00:00:00.000Z"
updatedAt = "2026-01-01T00:00:00.000Z"
`,
      "utf-8",
    );
    const meta = await readEffortMetadata(workspace, PROJECT, "legacy-ref");
    expect(meta?.type).toBe("AUXILIARY"); // remapped
    expect(meta?.status).toBe("PROMISING"); // existing status wins over default
  });

  it("type=\"REFERENCE\" with no explicit status promotes status to REFERENCE", async () => {
    const dir = effortDirFor(workspace, PROJECT, "legacy-ref-2");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "effort.toml"),
      `[effort]
id = "22222222-2222-2222-2222-222222222222"
slug = "legacy-ref-2"
title = "Old Ref"
type = "REFERENCE"
description = ""
currentVersion = 0
createdAt = "2026-01-01T00:00:00.000Z"
updatedAt = "2026-01-01T00:00:00.000Z"
`,
      "utf-8",
    );
    const meta = await readEffortMetadata(workspace, PROJECT, "legacy-ref-2");
    expect(meta?.type).toBe("AUXILIARY");
    expect(meta?.status).toBe("REFERENCE");
  });
});

describe("effort relations (GAP #9)", () => {
  beforeEach(async () => {
    await initEffort(workspace, PROJECT, { title: "Effort A", type: "PROOF_ATTEMPT" });
    await initEffort(workspace, PROJECT, { title: "Effort B", type: "FORMALIZATION" });
    await initEffort(workspace, PROJECT, { title: "Effort C", type: "REDUCTION" });
  });

  it("addRelation appends a fully-formed edge and listAllRelations reads it back", async () => {
    const e1 = await addRelation(workspace, PROJECT, {
      from: "effort-a",
      to: "effort-b",
      type: "depends_on",
      description: "needs B's lemma",
    });
    expect(e1.id).toBeTruthy();
    expect(e1.source).toBe("user");
    expect(e1.confidence).toBe(0.8);

    const e2 = await addRelation(workspace, PROJECT, {
      from: "effort-a",
      to: "effort-c",
      type: "uses",
      source: "llm",
      confidence: 0.6,
    });

    const all = await listAllRelations(workspace, PROJECT);
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.id).sort()).toEqual([e1.id, e2.id].sort());
  });

  it("listEffortRelations / listEffortDependents split by direction", async () => {
    await addRelation(workspace, PROJECT, { from: "effort-a", to: "effort-b", type: "depends_on" });
    await addRelation(workspace, PROJECT, { from: "effort-c", to: "effort-b", type: "depends_on" });
    await addRelation(workspace, PROJECT, { from: "effort-b", to: "effort-a", type: "extends" });

    const out = await listEffortRelations(workspace, PROJECT, "effort-b");
    expect(out).toHaveLength(1);
    expect(out[0].to).toBe("effort-a");

    const incoming = await listEffortDependents(workspace, PROJECT, "effort-b");
    expect(incoming).toHaveLength(2);
    expect(incoming.map((e) => e.from).sort()).toEqual(["effort-a", "effort-c"]);
  });

  it("removeRelation rewrites the file without the targeted edge", async () => {
    const a = await addRelation(workspace, PROJECT, { from: "effort-a", to: "effort-b", type: "depends_on" });
    const b = await addRelation(workspace, PROJECT, { from: "effort-a", to: "effort-c", type: "uses" });

    const removed = await removeRelation(workspace, PROJECT, a.id);
    expect(removed).toBe(true);
    const rest = await listAllRelations(workspace, PROJECT);
    expect(rest).toHaveLength(1);
    expect(rest[0].id).toBe(b.id);

    const removeAgain = await removeRelation(workspace, PROJECT, a.id);
    expect(removeAgain).toBe(false);
  });

  it("rejects an invalid relation type", async () => {
    await expect(
      addRelation(workspace, PROJECT, {
        from: "effort-a",
        to: "effort-b",
        type: "bogus" as any,
      }),
    ).rejects.toThrow(/invalid relation type/);
  });

  it("rejects traversal-style slugs", async () => {
    await expect(
      addRelation(workspace, PROJECT, {
        from: "../etc/passwd" as any,
        to: "effort-b",
        type: "depends_on",
      }),
    ).rejects.toThrow(/invalid/);
  });

  it("tolerates a malformed jsonl line on read", async () => {
    await addRelation(workspace, PROJECT, { from: "effort-a", to: "effort-b", type: "uses" });
    // Append a broken line by hand.
    const file = path.join(workspace, "projects", PROJECT, "efforts", ".relations.jsonl");
    await fs.appendFile(file, "not-json\n{broken:1}\n", "utf-8");
    const all = await listAllRelations(workspace, PROJECT);
    expect(all).toHaveLength(1); // malformed lines silently skipped
  });
});

// ─── v0.4 §1: slugifyTitle 60-char cap ──────────────────────────
describe("slugifyTitle (v0.4 §1 cap at 60)", () => {
  it("leaves short titles unchanged", () => {
    expect(slugifyTitle("hello world")).toBe("hello-world");
  });

  it("normalises non-slug chars to single hyphens", () => {
    expect(slugifyTitle("  Hello,  World!! ")).toBe("hello-world");
  });

  it("preserves a 60-char slug unchanged", () => {
    const s60 = "a".repeat(60);
    const out = slugifyTitle(s60);
    expect(out).toBe(s60);
    expect(out.length).toBe(60);
  });

  it("clips a long hyphen-separated title at the last hyphen <= 60", () => {
    // Many words → many hyphens; ensure result <= 60 and ends at a hyphen boundary.
    const title = Array.from({ length: 40 }, (_, i) => `word${i + 1}`).join(" ");
    const out = slugifyTitle(title);
    expect(out.length).toBeLessThanOrEqual(60);
    // Should NOT end with a hyphen — trim defense ran.
    expect(out.endsWith("-")).toBe(false);
    // Should end at a hyphen boundary inside the original head (i.e. a
    // complete "wordN"), so the last char is a digit, not a fragment.
    expect(/word\d+$/.test(out)).toBe(true);
  });

  it("hard-cuts a hyphen-less 100-char input to 60", () => {
    const s = "a".repeat(100);
    const out = slugifyTitle(s);
    expect(out.length).toBe(60);
    expect(out).toBe("a".repeat(60));
  });

  it("never returns a slug with a leading or trailing hyphen even for huge inputs", () => {
    const title = "the-quick-brown-fox-".repeat(20); // way past 60
    const out = slugifyTitle(title);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.startsWith("-")).toBe(false);
    expect(out.endsWith("-")).toBe(false);
  });
});

// ─── P2-A: extended effort folder layout + references / artifacts ────

describe("initEffort layout extension (P2-A)", () => {
  let workspace: string;
  let projectSlug: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-layout-"));
    projectSlug = "proj";
    await fs.mkdir(path.join(workspace, "projects", projectSlug), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("scaffolds references/ notes/ scratch/ artifacts.jsonl on initEffort", async () => {
    const { effortDir } = await initEffort(workspace, projectSlug, {
      title: "Test",
      type: "CONSTRUCTION",
      description: "x",
    });
    for (const sub of ["references", "notes", "scratch", "files"]) {
      const st = await fs.stat(path.join(effortDir, sub));
      expect(st.isDirectory()).toBe(true);
    }
    const artifacts = await fs.readFile(path.join(effortDir, "artifacts.jsonl"), "utf-8");
    expect(artifacts).toBe("");
  });
});

describe("attachReference / listReferences (P2-A)", () => {
  let workspace: string;
  let projectSlug: string;
  let effortSlug: string;
  let cacheDir: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-ref-"));
    projectSlug = "proj";
    await fs.mkdir(path.join(workspace, "projects", projectSlug), { recursive: true });
    const r = await initEffort(workspace, projectSlug, { title: "Test", type: "CONSTRUCTION", description: "x" });
    effortSlug = r.slug;
    // pretend cache: workspace/.mathran/paper-sources/2106.04561/
    cacheDir = path.join(workspace, ".mathran", "paper-sources", "2106.04561");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "main.tex"), "\\documentclass{article}\nbody", "utf-8");
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("symlinks cache dir into <effort>/references/<arxivId>", async () => {
    const r = await attachReference(workspace, projectSlug, effortSlug, "2106.04561", cacheDir);
    expect(r.existed).toBe(false);
    expect(r.mode).toBe("symlink");
    expect(r.linkPath.endsWith("2106.04561")).toBe(true);
    const refs = await listReferences(workspace, projectSlug, effortSlug);
    expect(refs.length).toBe(1);
    expect(refs[0].name).toBe("2106.04561");
    expect(refs[0].isSymlink).toBe(true);
    // .gitkeep filtered out
  });

  it("returns existed:true on repeat attach", async () => {
    await attachReference(workspace, projectSlug, effortSlug, "2106.04561", cacheDir);
    const r2 = await attachReference(workspace, projectSlug, effortSlug, "2106.04561", cacheDir);
    expect(r2.existed).toBe(true);
  });

  it("rejects unsafe arxiv ids", async () => {
    await expect(
      attachReference(workspace, projectSlug, effortSlug, "../etc/passwd", cacheDir),
    ).rejects.toThrow(/invalid arxivId/);
  });

  it("escapes legacy slash ids to safe basenames", async () => {
    const legacyCache = path.join(workspace, ".mathran", "paper-sources", "cs.LG_0412020");
    await fs.mkdir(legacyCache, { recursive: true });
    const r = await attachReference(workspace, projectSlug, effortSlug, "cs.LG/0412020", legacyCache);
    expect(r.existed).toBe(false);
    expect(path.basename(r.linkPath)).toBe("cs.LG_0412020");
  });
});

describe("recordArtifact / listArtifacts (P2-A)", () => {
  let workspace: string;
  let projectSlug: string;
  let effortSlug: string;
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-art-"));
    projectSlug = "proj";
    await fs.mkdir(path.join(workspace, "projects", projectSlug), { recursive: true });
    const r = await initEffort(workspace, projectSlug, { title: "T", type: "CONSTRUCTION", description: "x" });
    effortSlug = r.slug;
  });
  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("appends, lists in order", async () => {
    await recordArtifact(workspace, projectSlug, effortSlug, { path: "result.csv", kind: "csv" });
    await recordArtifact(workspace, projectSlug, effortSlug, { path: "plot.png", kind: "png", summary: "loss curve" });
    const all = await listArtifacts(workspace, projectSlug, effortSlug);
    expect(all.length).toBe(2);
    expect(all[0].path).toBe("result.csv");
    expect(all[1].kind).toBe("png");
    expect(all[1].summary).toBe("loss curve");
    expect(all.every((a) => typeof a.createdAt === "string")).toBe(true);
  });

  it("rejects absolute path / .. escape", async () => {
    await expect(
      recordArtifact(workspace, projectSlug, effortSlug, { path: "/etc/x", kind: "x" }),
    ).rejects.toThrow(/invalid artifact path/);
    await expect(
      recordArtifact(workspace, projectSlug, effortSlug, { path: "../outside", kind: "x" }),
    ).rejects.toThrow(/invalid artifact path/);
  });
});
