import { describe, expect, it } from "vitest";

import type { InitAgentResult } from "../../lib/api.ts";
import { buildStatRows, extractInitResult, formatDuration, summaryHeadline } from "./init-result-helpers.ts";

function makeResult(over: Partial<InitAgentResult> = {}): InitAgentResult {
  return {
    projectSlug: "twin-primes",
    wikiPages: ["index", "sieve"],
    crawledResources: 4,
    seedPapers: 2,
    summary: {
      conceptsExtracted: 3,
      queriesRun: 5,
      resourcesFound: 4,
      wikiPagesGenerated: 2,
      durationMs: 65_000,
    },
    ...over,
  };
}

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("formats minute+second durations", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("guards against zero / non-finite", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(NaN)).toBe("0s");
  });
});

describe("summaryHeadline", () => {
  it("summarizes wiki pages", () => {
    expect(summaryHeadline(makeResult())).toBe("Init complete — 2 wiki pages");
  });

  it("includes efforts for spine runs", () => {
    const r = makeResult({
      mode: "spine",
      summary: { ...makeResult().summary, effortsCreated: 3 },
    });
    expect(summaryHeadline(r)).toBe("Init complete — 2 wiki pages, 3 efforts");
  });

  it("singularizes a single page", () => {
    const r = makeResult({
      wikiPages: ["index"],
      summary: { ...makeResult().summary, wikiPagesGenerated: 1 },
    });
    expect(summaryHeadline(r)).toBe("Init complete — 1 wiki page");
  });
});

describe("buildStatRows", () => {
  it("returns the core stats for a v1a run", () => {
    const rows = buildStatRows(makeResult());
    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(["Wiki pages", "Resources", "Seed papers", "Duration"]);
    expect(rows.find((r) => r.label === "Duration")?.value).toBe("1m 5s");
  });

  it("appends Spine-First extras when mode is spine", () => {
    const rows = buildStatRows(
      makeResult({
        mode: "spine",
        summary: { ...makeResult().summary, spineNodes: 7, pagesFlagged: 1 },
      }),
    );
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("Spine nodes");
    expect(labels).toContain("Pages flagged");
    expect(rows.find((r) => r.label === "Spine nodes")?.value).toBe(7);
  });
});

describe("extractInitResult", () => {
  const snapshot = {
    run: { runId: "run-abc123abc123", agentType: "init-project", status: "completed", startedAt: "x" },
    phases: [
      { phase: "build_wiki", event: "end", at: "x", data: { wikiPages: 2 } },
      {
        phase: "completed",
        event: "end",
        at: "x",
        data: { summary: { conceptsExtracted: 1, queriesRun: 2, resourcesFound: 4, wikiPagesGenerated: 2, durationMs: 9000, effortsCreated: 3 } },
      },
    ],
    checkpoint: null,
    logs: [],
  } as unknown as Parameters<typeof extractInitResult>[0];

  it("pulls the summary from the completed phase", () => {
    const r = extractInitResult(snapshot, { slug: "twin-primes", mode: "spine", wikiPages: ["index", "sieve"] });
    expect(r.projectSlug).toBe("twin-primes");
    expect(r.mode).toBe("spine");
    expect(r.wikiPages).toEqual(["index", "sieve"]);
    expect(r.summary.effortsCreated).toBe(3);
    expect(r.crawledResources).toBe(4);
  });

  it("falls back to defaults when no completed phase summary exists", () => {
    const empty = { run: snapshot.run, phases: [], checkpoint: null, logs: [] } as unknown as Parameters<typeof extractInitResult>[0];
    const r = extractInitResult(empty, { slug: "x", mode: "v1a", wikiPages: ["a"] });
    expect(r.summary.wikiPagesGenerated).toBe(1);
    expect(r.summary.durationMs).toBe(0);
  });
});
