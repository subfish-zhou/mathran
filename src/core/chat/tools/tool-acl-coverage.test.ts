/**
 * Part B1 commit 4 — Plan-mode ACL coverage test.
 *
 * Scans every non-test `.ts` file in `src/core/chat/tools/` and verifies
 * that each file exporting a ToolSpec carries an explicit `readOnly:`
 * field. This is a static text scan (regex), NOT a runtime check, so it
 * catches drift the moment someone adds a new tool but forgets to
 * classify it.
 *
 * The conservative-default contract (commit 2) means that an
 * un-classified tool would simply be blocked in plan mode, which is
 * safe but silently degrades plan-mode usability. This test makes the
 * omission loud.
 *
 * Threshold: ≥95% of ToolSpec files must declare `readOnly:`. Anything
 * below indicates someone added a tool without thinking about plan
 * mode; the test prints the offenders so the fix is mechanical.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, ".");

function listToolFiles(): string[] {
  return fs
    .readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    // utility files (no ToolSpec). Detect by absence of `riskClass:` in
    // the source — utilities like python-venv.ts don't return ToolSpec
    // and thus carry no riskClass.
    .filter((f) => {
      const text = fs.readFileSync(path.join(TOOLS_DIR, f), "utf8");
      return /riskClass:\s*"(read|write|exec)"/.test(text);
    });
}

describe("plan-mode ACL coverage (ToolSpec.readOnly annotation)", () => {
  const files = listToolFiles();

  it("discovers at least 40 ToolSpec files in src/core/chat/tools/", () => {
    // Sanity: we don't want the regex filter to accidentally exclude
    // everything. Current baseline is 49 plus plan-mode-tools.ts (=2 specs
    // in 1 file). The threshold here is a floor, not a ceiling, so future
    // tool additions don't break this assertion.
    expect(files.length).toBeGreaterThanOrEqual(40);
  });

  it("≥95% of ToolSpec files declare an explicit readOnly: field", () => {
    const missing: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(TOOLS_DIR, f), "utf8");
      if (!/readOnly:\s*(true|false)/.test(text)) {
        missing.push(f);
      }
    }
    const total = files.length;
    const annotated = total - missing.length;
    const coverage = annotated / total;
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[plan-mode-acl] ${missing.length}/${total} files missing readOnly:`,
        missing,
      );
    }
    expect(coverage).toBeGreaterThanOrEqual(0.95);
  });

  it("every annotated file uses readOnly: true OR readOnly: false (no typos / no other values)", () => {
    for (const f of files) {
      const text = fs.readFileSync(path.join(TOOLS_DIR, f), "utf8");
      // Skip comment lines (// ... or  * ... in JSDoc blocks) so the regex
      // only inspects real ToolSpec field assignments.
      const codeLines = text
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith("//") && !trimmed.startsWith("*");
        })
        .join("\n");
      const ms = codeLines.match(/readOnly:\s*([^,}\n\s]+)/g) ?? [];
      for (const m of ms) {
        const val = m.replace(/readOnly:\s*/, "").replace(/,$/, "").trim();
        expect(["true", "false"]).toContain(val);
      }
    }
  });

  it("known-read tools carry readOnly: true (regression guard)", () => {
    const cases: Array<{ file: string; expected: "true" }> = [
      { file: "read-file.ts", expected: "true" },
      { file: "list-efforts.ts", expected: "true" },
      { file: "memory-read.ts", expected: "true" },
      { file: "search-web.ts", expected: "true" },
      { file: "search-arxiv.ts", expected: "true" },
      { file: "get-subagent-result.ts", expected: "true" },
      { file: "ask-user.ts", expected: "true" },
    ];
    for (const { file, expected } of cases) {
      const text = fs.readFileSync(path.join(TOOLS_DIR, file), "utf8");
      const re = new RegExp(`readOnly:\\s*${expected}`);
      expect(re.test(text), `${file} should have readOnly: ${expected}`).toBe(true);
    }
  });

  it("known-mutating tools carry readOnly: false (regression guard)", () => {
    const cases = [
      "write-file.ts",
      "edit-file.ts",
      "bash.ts",
      "run-python.ts",
      "run-latex.ts",
      "install-python-package.ts",
      "dispatch-subagent.ts",
      "create-effort.ts",
      "update-effort-document.ts",
      "memory-write.ts",
      "memory-append.ts",
      "propose-goal.ts",
      "propose-plan.ts",
      "verify-page.ts",
      "snapshot-effort.ts",
      "todo-write.ts",
    ];
    for (const file of cases) {
      const text = fs.readFileSync(path.join(TOOLS_DIR, file), "utf8");
      expect(/readOnly:\s*false/.test(text), `${file} should have readOnly: false`).toBe(true);
    }
  });

  it("plan-mode toggle tools themselves are readOnly: true (escape hatch)", () => {
    const text = fs.readFileSync(
      path.join(TOOLS_DIR, "plan-mode-tools.ts"),
      "utf8",
    );
    // Should declare readOnly: true at least twice (one per tool).
    const matches = text.match(/readOnly:\s*true/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
