/**
 * Unit tests for the LocalLeanProvider — uses a temp directory and real
 * `lean` binary on PATH.
 *
 * Run: npm run test:unit src/providers/lean
 */

import { describe, it, expect, beforeAll } from "vitest";
import { LocalLeanProvider } from "./local.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

let tmpDir: string;
let provider: LocalLeanProvider;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-test-lean-"));
  provider = new LocalLeanProvider();
});

describe("LocalLeanProvider", () => {
  it("describes itself with lean version", async () => {
    const d = await provider.describe();
    expect(d.name).toBe("local-lean");
    expect(d.version).toMatch(/Lean/i);
  });

  it("returns ok for a trivial valid proof", async () => {
    const f = path.join(tmpDir, "good.lean");
    await fs.writeFile(f, "theorem t : True := trivial\n");
    const r = await provider.check({ filePath: f });
    expect(r.ok).toBe(true);
    expect(r.messages.filter((m) => m.severity === "error")).toHaveLength(0);
  });

  it("returns errors for a broken proof", async () => {
    const f = path.join(tmpDir, "bad.lean");
    await fs.writeFile(f, "theorem t : 1 + 1 = 3 := by rfl\n");
    const r = await provider.check({ filePath: f });
    expect(r.ok).toBe(false);
    const errors = r.messages.filter((m) => m.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Should have a line/column for the error
    expect(errors[0].line).toBeDefined();
  });

  it("returns error for missing file", async () => {
    const r = await provider.check({ filePath: "/tmp/does-not-exist.lean" });
    expect(r.ok).toBe(false);
    expect(r.messages.some((m) => /not found/i.test(m.message))).toBe(true);
  });
});
