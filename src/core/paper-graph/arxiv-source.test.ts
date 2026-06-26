/**
 * Tests for arxiv-source.ts (sync-upgrade Phase 1-A).
 *
 * Strategy: build a real .tar.gz on disk that simulates an arxiv
 * /e-print/ response, point the mocked fetchImpl at it, and verify
 * the full extract → resolve → cache pipeline.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import { beforeEach, afterEach, describe, it, expect } from "vitest";

import {
  fetchArxivSource,
  resolveMainTex,
  classifyFiles,
  cacheDirFor,
  listCachedSources,
} from "./arxiv-source.js";

let workspace: string;
let fixtureDir: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-arxiv-test-"));
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-arxiv-fix-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

/**
 * Build a tar.gz with the given files (relative path → content) and
 * return its contents as a single ArrayBuffer so the mock fetchImpl
 * can stream it.
 */
async function buildTarGz(files: Record<string, string>): Promise<ArrayBuffer> {
  // Stage to a tmp dir, tar it, gzip, read back into memory.
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-fix-stage-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(stage, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
    }
    const tarball = path.join(fixtureDir, `bundle-${Date.now()}.tar.gz`);
    // Use tar package directly to create a .tar then gzip it.
    const rawTar = path.join(fixtureDir, `bundle-${Date.now()}.tar`);
    await tar.create({ file: rawTar, cwd: stage }, await fs.readdir(stage));
    const gz = createGzip();
    await pipeline(
      Readable.from(await fs.readFile(rawTar)),
      gz,
      (await import("node:fs")).createWriteStream(tarball),
    );
    const buf = await fs.readFile(tarball);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

/** Build a mocked fetchImpl that returns a tar.gz buffer for any URL. */
function makeMockFetch(buf: ArrayBuffer): (url: string) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}> {
  return async () => {
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      }),
    };
  };
}

describe("classifyFiles", () => {
  it("splits .tex / .bib / figures correctly", () => {
    const result = classifyFiles([
      "/x/main.tex",
      "/x/refs.bib",
      "/x/fig1.png",
      "/x/fig2.PDF",
      "/x/notes.md",
      "/x/intro.tex",
    ]);
    expect(result.texFiles.sort()).toEqual(["/x/intro.tex", "/x/main.tex"]);
    expect(result.bibFiles).toEqual(["/x/refs.bib"]);
    expect(result.figureFiles.sort()).toEqual(["/x/fig1.png", "/x/fig2.PDF"]);
  });
});

describe("resolveMainTex heuristic", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-resolve-test-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null on empty input", async () => {
    expect(await resolveMainTex(dir, [])).toBeNull();
  });

  it("returns the single file when only one", async () => {
    const f = path.join(dir, "main.tex");
    await fs.writeFile(f, "\\documentclass{article}");
    expect(await resolveMainTex(dir, [f])).toBe(f);
  });

  it("prefers the file with \\documentclass when there are multiple", async () => {
    const a = path.join(dir, "intro.tex");
    const b = path.join(dir, "main.tex");
    await fs.writeFile(a, "intro section body");
    await fs.writeFile(b, "\\documentclass{article}\n\\begin{document}");
    expect(await resolveMainTex(dir, [a, b])).toBe(b);
  });

  it("drops files that are \\input{}'d by another", async () => {
    const main = path.join(dir, "main.tex");
    const intro = path.join(dir, "intro.tex");
    await fs.writeFile(main, "\\documentclass{article}\n\\input{intro}");
    await fs.writeFile(intro, "\\documentclass{article}\nbody");
    // Both have \documentclass but intro is referenced — main should win.
    expect(await resolveMainTex(dir, [main, intro])).toBe(main);
  });

  it("prefers main.tex by name when other heuristics tie", async () => {
    const a = path.join(dir, "paperdraft.tex");
    const b = path.join(dir, "main.tex");
    await fs.writeFile(a, "\\documentclass{article}\nA");
    await fs.writeFile(b, "\\documentclass{article}\nB");
    expect(await resolveMainTex(dir, [a, b])).toBe(b);
  });

  it("falls back to largest file when nothing else discriminates", async () => {
    const a = path.join(dir, "alpha.tex");
    const b = path.join(dir, "beta.tex");
    await fs.writeFile(a, "X");
    await fs.writeFile(b, "X".repeat(1000));
    expect(await resolveMainTex(dir, [a, b])).toBe(b);
  });
});

describe("fetchArxivSource — happy path", () => {
  it("downloads, extracts, classifies, caches, resolves main.tex", async () => {
    const buf = await buildTarGz({
      "main.tex": "\\documentclass{article}\n\\input{intro}\n\\begin{document}body\\end{document}",
      "intro.tex": "Hello world.",
      "refs.bib": "@article{foo,title={Bar}}",
      "figs/fig1.png": "PNG-DATA",
    });
    const result = await fetchArxivSource("2106.04561", {
      workspace,
      fetchImpl: makeMockFetch(buf),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fromCache).toBe(false);
    expect(path.basename(result.mainTexFile!)).toBe("main.tex");
    expect(result.texFiles.length).toBe(2);
    expect(result.bibFiles.length).toBe(1);
    expect(result.figureFiles.length).toBe(1);
    expect(result.byteSize).toBeGreaterThan(0);

    // .complete marker present
    const marker = await fs.readFile(path.join(result.rootDir, ".complete"), "utf-8");
    expect(JSON.parse(marker).arxivId).toBe("2106.04561");
  });

  it("serves second call from cache (fromCache=true, no fetchImpl call)", async () => {
    const buf = await buildTarGz({
      "main.tex": "\\documentclass{article}\nbody",
    });
    await fetchArxivSource("2106.04561", { workspace, fetchImpl: makeMockFetch(buf) });
    let calls = 0;
    const result = await fetchArxivSource("2106.04561", {
      workspace,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("cache should have prevented this");
      },
    });
    expect(calls).toBe(0);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fromCache).toBe(true);
    expect(path.basename(result.mainTexFile!)).toBe("main.tex");
  });

  it("force=true bypasses cache and re-fetches", async () => {
    const buf = await buildTarGz({ "main.tex": "\\documentclass{article}\nbody" });
    await fetchArxivSource("2106.04561", { workspace, fetchImpl: makeMockFetch(buf) });
    let calls = 0;
    const wrapped = (url: string) => {
      calls += 1;
      return makeMockFetch(buf)(url);
    };
    const result = await fetchArxivSource("2106.04561", {
      workspace,
      force: true,
      fetchImpl: wrapped,
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.fromCache).toBe(false);
  });
});

describe("fetchArxivSource — error paths", () => {
  it("rejects invalid arxiv ids without making a request", async () => {
    let called = false;
    const result = await fetchArxivSource("not a real id", {
      workspace,
      fetchImpl: async () => {
        called = true;
        return { ok: false, status: 999, body: null };
      },
    });
    expect(called).toBe(false);
    expect(result.status).toBe("invalid-id");
  });

  it("classifies 404 as no-source (paper has only a PDF)", async () => {
    const result = await fetchArxivSource("2106.04561", {
      workspace,
      fetchImpl: async () => ({ ok: false, status: 404, body: null }),
    });
    expect(result.status).toBe("no-source");
  });

  it("classifies network rejection as fetch-failed", async () => {
    const result = await fetchArxivSource("2106.04561", {
      workspace,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(result.status).toBe("fetch-failed");
    if (result.status === "fetch-failed") expect(result.error).toContain("ECONNRESET");
  });

  it("classifies broken tarball as extract-failed", async () => {
    // Send a non-tar.gz body.
    const garbage = new TextEncoder().encode("this is not a tar.gz").buffer as ArrayBuffer;
    const result = await fetchArxivSource("2106.04561", {
      workspace,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(garbage));
            controller.close();
          },
        }),
      }),
    });
    expect(result.status).toBe("extract-failed");
  });
});

describe("listCachedSources", () => {
  it("returns [] when cache dir doesn't exist", async () => {
    expect(await listCachedSources(workspace)).toEqual([]);
  });

  it("lists fetched papers", async () => {
    const buf = await buildTarGz({ "main.tex": "\\documentclass{article}\nbody" });
    await fetchArxivSource("2106.04561", { workspace, fetchImpl: makeMockFetch(buf) });
    await fetchArxivSource("0801.1234", { workspace, fetchImpl: makeMockFetch(buf) });
    const entries = await listCachedSources(workspace);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.arxivId).sort()).toEqual(["0801.1234", "2106.04561"]);
  });
});

describe("cacheDirFor", () => {
  it("escapes legacy slash ids", () => {
    expect(cacheDirFor("/w", "cs.LG/0412020")).toBe(
      path.join("/w", ".mathran", "paper-sources", "cs.LG_0412020"),
    );
  });
});

// ─── Audit fixes ─────────────────────────────────────────────────────────

describe("ARXIV_ID_RE (Fix A5)", () => {
  it("accepts modern ids YYMM.NNNNN with optional vN", async () => {
    const buf = await buildTarGz({ "main.tex": "\\documentclass{article}\nbody" });
    for (const id of ["2106.04561", "2106.04561v2", "0801.1234"]) {
      const res = await fetchArxivSource(id, { workspace, fetchImpl: makeMockFetch(buf) });
      expect(res.status).toBe("ok");
    }
  });

  it("accepts legacy archive-prefix ids (cs.LG/, hep-th/, math.NT/)", async () => {
    const buf = await buildTarGz({ "main.tex": "\\documentclass{article}\nbody" });
    for (const id of ["cs.LG/0412020", "hep-th/9901001", "math.NT/0412020"]) {
      const res = await fetchArxivSource(id, { workspace, fetchImpl: makeMockFetch(buf) });
      expect(res.status).toBe("ok");
    }
  });

  it("rejects malformed ids before network", async () => {
    let called = false;
    const res = await fetchArxivSource("../etc/passwd", {
      workspace,
      fetchImpl: async () => { called = true; return { ok: false, status: 999, body: null }; },
    });
    expect(called).toBe(false);
    expect(res.status).toBe("invalid-id");
  });
});

describe("content-type dispatch (Fix A24)", () => {
  it("treats application/pdf as no-source (without exploding)", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4\nfake pdf body");
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from(pdfBytes)) as unknown as ReadableStream<Uint8Array>,
      headers: { get: (n: string) => n.toLowerCase() === "content-type" ? "application/pdf" : null },
    });
    const res = await fetchArxivSource("2106.04561", { workspace, fetchImpl: mockFetch });
    expect(res.status).toBe("no-source");
  });

  it("handles single-file .tex submissions (text/plain)", async () => {
    const rawTex = "\\documentclass{article}\n\\begin{document}\nfoo\n\\end{document}\n";
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from(Buffer.from(rawTex))) as unknown as ReadableStream<Uint8Array>,
      headers: { get: (n: string) => n.toLowerCase() === "content-type" ? "text/plain" : null },
    });
    const res = await fetchArxivSource("2106.04561", { workspace, fetchImpl: mockFetch });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.mainTexFile).toBeTruthy();
      const body = await fs.readFile(res.mainTexFile!, "utf-8");
      expect(body).toContain("\\documentclass{article}");
    }
  });
});

describe("concurrent fetch deduplication (Fix B1)", () => {
  it("two simultaneous fetchArxivSource for same id share one network call", async () => {
    const buf = await buildTarGz({ "main.tex": "\\documentclass{article}\nbody" });
    // Build a tracking wrapper around makeMockFetch so each call wraps
    // the ArrayBuffer in a fresh ReadableStream (the helper does this
    // correctly; rolling our own with Readable.from(ArrayBuffer) breaks
    // because Readable.from iterates an ArrayBuffer's elements rather
    // than yielding bytes).
    const inner = makeMockFetch(buf);
    let callCount = 0;
    const mockFetch: typeof inner = async (url) => {
      callCount += 1;
      // small delay so second call starts before first finishes
      await new Promise((r) => setTimeout(r, 30));
      return inner(url);
    };
    const [a, b] = await Promise.all([
      fetchArxivSource("2106.04561", { workspace, fetchImpl: mockFetch }),
      fetchArxivSource("2106.04561", { workspace, fetchImpl: mockFetch }),
    ]);
    expect(callCount).toBe(1);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
  });
});

describe("byte caps (Fix C5/C6/C19)", () => {
  it("text/plain body over DOWNLOAD_CAP is rejected", async () => {
    // Build a fake 'text/plain' response with > 60 MB body.
    const tooBig = Buffer.alloc(61 * 1024 * 1024, 0x61); // 61 MB of 'a'
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from(tooBig)) as unknown as ReadableStream<Uint8Array>,
      headers: { get: (n: string) => n.toLowerCase() === "content-type" ? "text/plain" : null },
    });
    const res = await fetchArxivSource("2106.04561", { workspace, fetchImpl: mockFetch });
    expect(res.status).toBe("extract-failed");
    if (res.status === "extract-failed") {
      expect(res.error).toMatch(/exceeded cap/);
    }
  });
});
