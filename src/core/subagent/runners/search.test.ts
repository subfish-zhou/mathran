/**
 * Tests for the search subagent runner (v0.2 §8).
 *
 * Every test forces the Node fallback path via `_forceNodeFallback: true` so
 * results don't depend on whether `rg` is installed on the host.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  searchRunner,
  globToRegExp,
  MIN_QUERY_LENGTH,
  type SearchRunnerInput,
} from "./search.js";
import { SubagentRegistry } from "../registry.js";
import { SubagentScheduler } from "../scheduler.js";
import type { SubagentContext } from "../types.js";

/** Create a tmp workspace and seed it with files. Returns absolute path. */
async function makeWorkspace(
  files: Record<string, string>,
): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-search-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return ws;
}

/** Build a SubagentContext (with a no-op signal + on-disk artifact writer). */
function makeContext(ws: string, runId = "sub-test1234"): SubagentContext {
  return {
    workspace: ws,
    runId,
    signal: new AbortController().signal,
    async writeArtifact(name, content) {
      const dir = path.join(ws, ".mathran", "subagents", runId);
      await fs.mkdir(dir, { recursive: true });
      const abs = path.join(dir, name);
      await fs.writeFile(abs, content);
      return path
        .relative(ws, abs)
        .split(path.sep)
        .join("/");
    },
  };
}

/** Convenience: invoke the runner with `_forceNodeFallback: true` baked in. */
async function runSearch(
  ws: string,
  input: Omit<SearchRunnerInput, "_forceNodeFallback">,
  runId = "sub-test1234",
) {
  return searchRunner.run(
    {
      type: "search",
      input: { ...input, _forceNodeFallback: true } as Record<string, unknown>,
    },
    makeContext(ws, runId),
  );
}

let createdDirs: string[] = [];

function trackWs(ws: string): string {
  createdDirs.push(ws);
  return ws;
}

beforeEach(() => {
  createdDirs = [];
});
afterEach(async () => {
  for (const d of createdDirs) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe("globToRegExp", () => {
  it("**/*.ts matches paths with any depth", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("foo.ts")).toBe(true);
    expect(re.test("a/b/c.ts")).toBe(true);
    expect(re.test("foo.js")).toBe(false);
  });
  it("**/* matches everything", () => {
    const re = globToRegExp("**/*");
    expect(re.test("foo")).toBe(true);
    expect(re.test("a/b/c.md")).toBe(true);
  });
  it("escapes regex metachars in literals", () => {
    const re = globToRegExp("foo.bar/baz");
    expect(re.test("foo.bar/baz")).toBe(true);
    expect(re.test("fooXbar/baz")).toBe(false);
  });
});

describe("search runner — Node fallback", () => {
  it("literal query finds expected matches across files", async () => {
    const ws = trackWs(
      await makeWorkspace({
        "a.ts": "const useState = 1;\nconsole.log(useState);\n",
        "b.ts": "function useState() { return useState; }\n",
        "c.md": "Notes about useState behavior.\n",
        "d.txt": "no matches here\n",
      }),
    );
    const res = await runSearch(ws, { query: "useState" });
    expect(res.status).toBe("ok");
    expect(res.summary).toContain('Found 4 matches in 3 files for "useState".');
    expect(res.artifactPath).toMatch(/\.mathran\/subagents\/.+\/matches\.jsonl$/);
  });

  it("glob filter limits search to matching files", async () => {
    const ws = trackWs(
      await makeWorkspace({
        "a.ts": "needle\n",
        "b.js": "needle\n",
        "c.ts": "needle\nneedle\n",
        "d.md": "needle\n",
      }),
    );
    const res = await runSearch(ws, { query: "needle", globPattern: "**/*.ts" });
    expect(res.status).toBe("ok");
    expect(res.summary).toContain('Found 3 matches in 2 files for "needle".');
    // Ensure non-ts files were skipped.
    expect(res.summary).not.toContain("b.js");
    expect(res.summary).not.toContain("d.md");
  });

  it("case-insensitive flag matches both cases", async () => {
    const ws = trackWs(
      await makeWorkspace({
        "a.ts": "Hello world\nhello again\nHELLO!\n",
      }),
    );
    const sensitive = await runSearch(ws, { query: "Hello" });
    expect(sensitive.summary).toContain('Found 1 match in 1 file for "Hello".');

    const insensitive = await runSearch(ws, { query: "Hello", caseInsensitive: true });
    expect(insensitive.summary).toContain('Found 3 matches in 1 file for "Hello".');
  });

  it("empty workspace → Found 0 matches", async () => {
    const ws = trackWs(await makeWorkspace({}));
    const res = await runSearch(ws, { query: "anything" });
    expect(res.status).toBe("ok");
    expect(res.summary).toContain('Found 0 matches in 0 files for "anything".');
  });

  it("query too short → status error", async () => {
    const ws = trackWs(await makeWorkspace({ "a.txt": "hi\n" }));
    const res = await runSearch(ws, { query: "a" });
    expect(res.status).toBe("error");
    expect(res.summary).toBe("");
    expect(res.artifactPath).toBeNull();
    expect(res.errorMessage).toContain(`at least ${MIN_QUERY_LENGTH}`);
  });

  it("artifact file is created and parseable as jsonl", async () => {
    const ws = trackWs(
      await makeWorkspace({
        "a.ts": "needle one\nother\nneedle two\n",
        "b.ts": "needle three\n",
      }),
    );
    const res = await runSearch(ws, { query: "needle" });
    expect(res.artifactPath).not.toBeNull();
    const raw = await fs.readFile(path.join(ws, res.artifactPath!), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ file: "a.ts", line: 1 });
    expect(parsed[0].text).toContain("needle one");
    expect(parsed[2]).toMatchObject({ file: "b.ts", line: 1 });
    expect(parsed[2].text).toContain("needle three");
  });

  it("top files are ranked by match count (most matches first)", async () => {
    const ws = trackWs(
      await makeWorkspace({
        "few.ts": "xx\n",
        "many.ts": "xx\nxx\nxx\nxx\nxx\n",
        "some.ts": "xx\nxx\n",
      }),
    );
    const res = await runSearch(ws, { query: "xx" });
    expect(res.status).toBe("ok");
    const lines = res.summary.split("\n");
    // Find the order of file lines after "Top files:".
    const topIdx = lines.findIndex((l) => l === "Top files:");
    expect(topIdx).toBeGreaterThanOrEqual(0);
    const file1 = lines[topIdx + 1];
    const file2 = lines[topIdx + 2];
    const file3 = lines[topIdx + 3];
    expect(file1).toContain("many.ts");
    expect(file1).toContain("(5)");
    expect(file2).toContain("some.ts");
    expect(file2).toContain("(2)");
    expect(file3).toContain("few.ts");
    expect(file3).toContain("(1)");
  });

  it("default ignore dirs (node_modules, dist, .git, .mathran) are skipped", async () => {
    const ws = trackWs(
      await makeWorkspace({
        "src/keep.ts": "needle\n",
        "node_modules/pkg/index.js": "needle\n",
        "dist/bundle.js": "needle\n",
        ".git/HEAD": "needle\n",
        ".mathran/state.json": "needle\n",
      }),
    );
    const res = await runSearch(ws, { query: "needle" });
    expect(res.summary).toContain('Found 1 match in 1 file for "needle".');
    expect(res.summary).toContain("src/keep.ts");
    expect(res.summary).not.toContain("node_modules");
    expect(res.summary).not.toContain("dist/");
  });
});

describe("search runner — scheduler integration", () => {
  it("end-to-end through SubagentScheduler honors the byte cap and artifact path", async () => {
    const ws = trackWs(
      await makeWorkspace({
        "a.ts": Array.from({ length: 50 }, (_, i) => `hit_${i}`).join("\n") + "\n",
      }),
    );
    const registry = new SubagentRegistry();
    registry.register(searchRunner);
    const sched = new SubagentScheduler({ workspace: ws, registry });
    const result = await sched.dispatch({
      type: "search",
      input: {
        query: "hit_",
        _forceNodeFallback: true,
      } as Record<string, unknown>,
      hardCapBytes: 2048,
    });
    expect(result.status === "ok" || result.status === "cap_exceeded").toBe(true);
    expect(Buffer.byteLength(result.summary, "utf8")).toBeLessThanOrEqual(2048);
    expect(result.artifactPath).not.toBeNull();
    expect(result.runId).toMatch(/^sub-[0-9a-f]+$/);
  });
});
