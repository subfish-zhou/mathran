/**
 * Pure (React-free) helpers for InitResultView. Kept standalone so they can be
 * unit-tested under the root vitest config without `react`.
 */

import type { InitAgentResult, RunLedgerSnapshot } from "../../lib/api.ts";

/** Format a millisecond duration as a compact "Mm Ss" / "Ns" string. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

/** One-line summary headline, e.g. "Init complete — 5 wiki pages, 3 efforts". */
export function summaryHeadline(result: InitAgentResult): string {
  const pages = result.summary?.wikiPagesGenerated ?? result.wikiPages?.length ?? 0;
  const efforts = result.summary?.effortsCreated ?? 0;
  const pagePart = `${pages} wiki page${pages === 1 ? "" : "s"}`;
  if (efforts > 0) {
    return `Init complete — ${pagePart}, ${efforts} effort${efforts === 1 ? "" : "s"}`;
  }
  return `Init complete — ${pagePart}`;
}

export interface StatRow {
  label: string;
  value: number | string;
}

/**
 * Build the stat row shown under the headline. Always includes the core v1a
 * stats; appends Spine-First (`spine`) extras when the run used that pipeline.
 */
export function buildStatRows(result: InitAgentResult): StatRow[] {
  const s = result.summary ?? ({} as InitAgentResult["summary"]);
  const rows: StatRow[] = [
    { label: "Wiki pages", value: s.wikiPagesGenerated ?? result.wikiPages?.length ?? 0 },
    { label: "Resources", value: s.resourcesFound ?? result.crawledResources ?? 0 },
    { label: "Seed papers", value: result.seedPapers ?? 0 },
    { label: "Duration", value: formatDuration(s.durationMs ?? 0) },
  ];
  if (result.mode === "spine") {
    rows.push(
      { label: "Spine nodes", value: s.spineNodes ?? 0 },
      { label: "Efforts", value: s.effortsCreated ?? 0 },
      { label: "Papers discovered", value: s.papersDiscovered ?? 0 },
      { label: "Papers relevant", value: s.papersRelevant ?? 0 },
      { label: "Pages refined", value: s.pagesRefined ?? 0 },
      { label: "Pages flagged", value: s.pagesFlagged ?? 0 },
    );
  }
  return rows;
}

/**
 * Reconstruct an `InitAgentResult` from a completed run-ledger snapshot. The
 * `completed` phase carries the full `summary`; wiki page names (not present in
 * the ledger) are supplied separately by the caller (e.g. from `listWiki`).
 */
export function extractInitResult(
  snapshot: RunLedgerSnapshot,
  opts: { slug: string; mode: "v1a" | "spine"; wikiPages?: string[] },
): InitAgentResult {
  const completed = snapshot.phases.find((p) => p.phase === "completed");
  const summary = (completed?.data?.summary as InitAgentResult["summary"] | undefined) ?? {
    conceptsExtracted: 0,
    queriesRun: 0,
    resourcesFound: 0,
    wikiPagesGenerated: opts.wikiPages?.length ?? 0,
    durationMs: 0,
  };
  return {
    projectSlug: opts.slug,
    wikiPages: opts.wikiPages ?? [],
    crawledResources: summary.resourcesFound ?? 0,
    seedPapers: 0,
    mode: opts.mode,
    summary,
  };
}
