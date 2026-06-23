/**
 * Permission Profiles (C-1) — autoApprovePatterns matching unit tests.
 *
 * Verifies the pure `matchAutoApprovePattern` helper. End-to-end broker /
 * dispatch precedence is covered in `auto-approve-broker.test.ts` next door;
 * this file pins down the path-vs-command safety invariant + glob semantics.
 */

import { describe, it, expect } from "vitest";
import { matchAutoApprovePattern } from "../profile-resolver.js";

describe("matchAutoApprovePattern (C-1 §1)", () => {
  // ──────────────────────────────────────────────────────────────────
  // Positive matches — write_file / edit_file path arg
  // ──────────────────────────────────────────────────────────────────

  it("matches a write_file call whose path matches a ** pattern", () => {
    const hit = matchAutoApprovePattern(
      "write_file",
      { path: "src/foo.test.ts" },
      ["src/**/*.test.ts"],
    );
    expect(hit).toBe("src/**/*.test.ts");
  });

  it("matches an edit_file call against the same patterns", () => {
    const hit = matchAutoApprovePattern(
      "edit_file",
      { path: "src/lib/bar.test.ts" },
      ["src/**/*.test.ts", "docs/**"],
    );
    expect(hit).toBe("src/**/*.test.ts");
  });

  it("single-* matches within a path segment only", () => {
    // `src/*` matches `src/a.ts` but NOT `src/lib/a.ts`.
    expect(
      matchAutoApprovePattern("write_file", { path: "src/a.ts" }, ["src/*"]),
    ).toBe("src/*");
    expect(
      matchAutoApprovePattern("write_file", { path: "src/lib/a.ts" }, ["src/*"]),
    ).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────
  // Negative matches — non-matching paths
  // ──────────────────────────────────────────────────────────────────

  it("returns null when no pattern matches the path", () => {
    const hit = matchAutoApprovePattern(
      "write_file",
      { path: "src/foo.ts" }, // not a *.test.ts
      ["src/**/*.test.ts"],
    );
    expect(hit).toBeNull();
  });

  it("returns null with an empty patterns array", () => {
    const hit = matchAutoApprovePattern(
      "write_file",
      { path: "src/anything.ts" },
      [],
    );
    expect(hit).toBeNull();
  });

  it("returns null when the call carries no path arg", () => {
    const hit = matchAutoApprovePattern(
      "write_file",
      {},
      ["src/**"],
    );
    expect(hit).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────
  // Safety: command-style tools NEVER match (PLAN §1 "安全保留")
  // ──────────────────────────────────────────────────────────────────

  it("NEVER matches bash even when path-like patterns include '*'", () => {
    // An autoApprovePattern of `*` must not auto-approve a bash command.
    // The denylist + suspicious-command check are the only gates for bash.
    expect(
      matchAutoApprovePattern("bash", { command: "rm -rf /" }, ["*"]),
    ).toBeNull();
    expect(
      matchAutoApprovePattern("bash", { command: "echo hi", path: "x" }, ["**"]),
    ).toBeNull();
  });

  it("NEVER matches lean_check or other non-write tools", () => {
    expect(
      matchAutoApprovePattern(
        "lean_check",
        { path: "src/foo.lean" },
        ["src/**"],
      ),
    ).toBeNull();
    expect(
      matchAutoApprovePattern(
        "dispatch_subagent",
        { path: "x" },
        ["**"],
      ),
    ).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────
  // Resilience: malformed patterns warn-and-ignore, never crash
  // ──────────────────────────────────────────────────────────────────

  it("skips empty / falsy pattern entries and continues", () => {
    const hit = matchAutoApprovePattern(
      "write_file",
      { path: "src/a.test.ts" },
      ["", "src/**/*.test.ts"],
    );
    expect(hit).toBe("src/**/*.test.ts");
  });
});
