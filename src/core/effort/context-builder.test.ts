/**
 * Tests for the effort context builder (v0.2 §12).
 *
 * Covers both the loader (filesystem → EffortContext) and the formatter
 * (EffortContext → system-prompt fragment). All work happens against a
 * tmp workspace seeded via the existing effort/store helpers — no manual
 * file pokes, so we're guaranteed to match the real on-disk layout.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  initEffort,
  writeEffortDocument,
  transitionEffortStatus,
} from "./store.js";
import { loadEffortContext, formatEffortContext } from "./context-builder.js";

let workspace: string;
const PROJECT = "ctx-project";
const EFFORT = "lemma-a";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-ctx-"));
  await fs.mkdir(path.join(workspace, "projects", PROJECT), { recursive: true });
});

describe("loadEffortContext", () => {
  it("returns null when the effort does not exist", async () => {
    const ctx = await loadEffortContext({
      workspace,
      projectSlug: PROJECT,
      effortSlug: "missing",
    });
    expect(ctx).toBeNull();
  });

  it("loads the document excerpt + recent status (default limits)", async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
    await writeEffortDocument(workspace, PROJECT, EFFORT, "## Working notes\n\nTrying approach X.\n");
    // Walk through 4 valid status transitions so we have >3 entries (plus the
    // seed). VALID_TRANSITIONS from DRAFT: PROPOSED | DEAD_END.
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "PROPOSED" });
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "UNDER_REVIEW" });
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "PROMISING" });
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "VERIFIED" });

    const ctx = await loadEffortContext({
      workspace,
      projectSlug: PROJECT,
      effortSlug: EFFORT,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.documentExcerpt).toBe("## Working notes\n\nTrying approach X.\n");
    expect(ctx!.documentTruncated).toBe(false);
    // Default recentStatusCount = 3 → newest first.
    expect(ctx!.recentStatus.map((e) => e.to)).toEqual([
      "VERIFIED",
      "PROMISING",
      "UNDER_REVIEW",
    ]);
    expect(ctx!.projectSlug).toBe(PROJECT);
    expect(ctx!.effortSlug).toBe(EFFORT);
  });

  it("renders only the status section when document.md is empty", async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
    // initEffort writes an empty document.md — leave it empty.
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "PROPOSED" });

    const ctx = await loadEffortContext({
      workspace,
      projectSlug: PROJECT,
      effortSlug: EFFORT,
    });
    expect(ctx!.documentExcerpt).toBeNull();
    expect(ctx!.recentStatus.length).toBeGreaterThan(0);

    const out = formatEffortContext(ctx);
    expect(out).toContain("## Working on effort: ctx-project / lemma-a");
    expect(out).not.toContain("### Effort notes");
    expect(out).toContain("### Recent status updates");
    expect(out).toContain("PROPOSED");
  });

  it("truncates document.md when it exceeds documentMaxBytes", async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
    const big = "x".repeat(5000);
    await writeEffortDocument(workspace, PROJECT, EFFORT, big);

    const ctx = await loadEffortContext({
      workspace,
      projectSlug: PROJECT,
      effortSlug: EFFORT,
      documentMaxBytes: 2048,
    });
    expect(ctx!.documentExcerpt!.length).toBe(2048);
    expect(ctx!.documentTruncated).toBe(true);

    const fragment = formatEffortContext(ctx);
    expect(fragment).toContain("…[truncated]");
  });

  it("honors a custom recentStatusCount", async () => {
    await initEffort(workspace, PROJECT, { title: "Lemma A", type: "PROOF_ATTEMPT" });
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "PROPOSED" });
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "UNDER_REVIEW" });
    await transitionEffortStatus(workspace, PROJECT, EFFORT, { to: "PROMISING" });

    const ctx = await loadEffortContext({
      workspace,
      projectSlug: PROJECT,
      effortSlug: EFFORT,
      recentStatusCount: 1,
    });
    expect(ctx!.recentStatus).toHaveLength(1);
    expect(ctx!.recentStatus[0].to).toBe("PROMISING");
  });
});

describe("formatEffortContext", () => {
  it("returns the empty string for null context", () => {
    expect(formatEffortContext(null)).toBe("");
  });

  it("returns the empty string when both excerpt and status are empty", () => {
    const out = formatEffortContext({
      documentExcerpt: null,
      documentTruncated: false,
      recentStatus: [],
      projectSlug: PROJECT,
      effortSlug: EFFORT,
    });
    expect(out).toBe("");
  });

  it("renders both sections with the project/effort header", () => {
    const out = formatEffortContext({
      documentExcerpt: "The lemma states P → Q.",
      documentTruncated: false,
      recentStatus: [
        { at: "2026-06-19T10:00:00Z", to: "PROMISING" },
        { at: "2026-06-19T09:45:00Z", to: "UNDER_REVIEW" },
      ],
      projectSlug: PROJECT,
      effortSlug: EFFORT,
    });
    expect(out).toContain("## Working on effort: ctx-project / lemma-a");
    expect(out).toContain("### Effort notes (excerpt)");
    expect(out).toContain("The lemma states P → Q.");
    expect(out).toContain("### Recent status updates");
    expect(out).toContain("[2026-06-19T10:00:00Z] PROMISING");
    expect(out).toContain("[2026-06-19T09:45:00Z] UNDER_REVIEW");
    expect(out).toContain(
      "(If you need more detail, you can read .mathran-efforts/ctx-project/lemma-a/document.md directly.)",
    );
  });

  it("renders reason/supersededBy on status entries", () => {
    const out = formatEffortContext({
      documentExcerpt: null,
      documentTruncated: false,
      recentStatus: [
        { at: "2026-06-19T10:00:00Z", to: "DEAD_END", reason: "counterexample found" },
        { at: "2026-06-19T09:45:00Z", to: "SUPERSEDED", supersededBy: "lemma-a-v2" },
      ],
      projectSlug: PROJECT,
      effortSlug: EFFORT,
    });
    expect(out).toContain("[2026-06-19T10:00:00Z] DEAD_END (counterexample found)");
    expect(out).toContain("[2026-06-19T09:45:00Z] SUPERSEDED (superseded-by: lemma-a-v2)");
  });
});
