import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  searchBourbakiSeminars,
  parseBourbakiIndex,
  loadBourbakiHtml,
  BOURBAKI_CACHE_TTL_MS,
} from "./bourbaki-search.js";

const SAMPLE_HTML = `
<html><body>
<ul>
  <li><a href="/seminaires/2025/1234.pdf">1234. J. Dupont — A survey of the Lonely Runner Conjecture (2025)</a></li>
  <li><a href="/seminaires/2024/1200.pdf">1200. A. Other — Perfectoid spaces and prismatic cohomology (2024)</a></li>
  <li><a href="/seminaires/2023/1100.pdf">1100. M. Tiers — Diophantine approximation revisited (2023)</a></li>
</ul>
</body></html>`;

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-bourbaki-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parseBourbakiIndex", () => {
  it("extracts number, speaker, title, year and absolute url", () => {
    const entries = parseBourbakiIndex(SAMPLE_HTML);
    expect(entries.length).toBe(3);
    const first = entries[0]!;
    expect(first.number).toBe("Exposé 1234");
    expect(first.speaker).toBe("J. Dupont");
    expect(first.title).toContain("Lonely Runner Conjecture");
    expect(first.year).toBe(2025);
    expect(first.url).toMatch(/^https:\/\/www\.bourbaki\.fr/);
  });

  it("returns [] for unrecognizable HTML", () => {
    expect(parseBourbakiIndex("<html><body>nothing here</body></html>")).toEqual([]);
  });
});

describe("searchBourbakiSeminars", () => {
  it("matches by keywords and sorts by confidence descending", async () => {
    const hits = await searchBourbakiSeminars(
      { title: "Lonely Runner Conjecture", tags: ["diophantine"] },
      { fetchBourbakiIndex: async () => SAMPLE_HTML },
    );
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.title).toContain("Lonely Runner");
    expect(hits[0]!.matchedKeywords).toContain("lonely");
    expect(hits[0]!.source).toBe("bourbaki");
    // sorted descending
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.matchConfidence).toBeGreaterThanOrEqual(hits[i]!.matchConfidence);
    }
  });

  it("returns [] when nothing matches", async () => {
    const hits = await searchBourbakiSeminars(
      { title: "Riemann Hypothesis zeta zeros", tags: ["analysis"] },
      { fetchBourbakiIndex: async () => SAMPLE_HTML },
    );
    expect(hits).toEqual([]);
  });

  it("is failure-isolated when fetch throws", async () => {
    const hits = await searchBourbakiSeminars(
      { title: "anything", tags: [] },
      {
        fetchBourbakiIndex: async () => {
          throw new Error("unreachable");
        },
      },
    );
    expect(hits).toEqual([]);
  });

  it("caches the index for 24h and reuses it", async () => {
    let calls = 0;
    const deps = {
      cacheDir: tmpDir,
      fetchBourbakiIndex: async () => {
        calls++;
        return SAMPLE_HTML;
      },
    };
    await loadBourbakiHtml(deps);
    await loadBourbakiHtml(deps);
    expect(calls).toBe(1);
    const cacheFile = path.join(tmpDir, "bourbaki-index.html");
    expect((await fs.readFile(cacheFile, "utf8")).length).toBeGreaterThan(0);
  });

  it("refetches when cache is older than TTL", async () => {
    let calls = 0;
    const deps = {
      cacheDir: tmpDir,
      fetchBourbakiIndex: async () => {
        calls++;
        return SAMPLE_HTML;
      },
    };
    await loadBourbakiHtml(deps);
    const cacheFile = path.join(tmpDir, "bourbaki-index.html");
    const old = new Date(Date.now() - BOURBAKI_CACHE_TTL_MS - 1000);
    await fs.utimes(cacheFile, old, old);
    await loadBourbakiHtml(deps);
    expect(calls).toBe(2);
  });
});
