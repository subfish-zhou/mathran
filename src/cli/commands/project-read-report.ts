/**
 * `mathran project read-report <slug>` (Task 39).
 *
 * Prints a human-readable summary of an init run for a project:
 *   - PaperReads bucketed by audit verdict (trusted / warn / rejected / skipped)
 *   - rejected papers with their reasons
 *   - unresolved citations (from the run report)
 *   - BFS convergence summary
 *   - LLM cost summary (writer / reviewer / reader / total $)
 *
 * Data sources:
 *   - `<workspace>/.mathran/paper-graph/reads/*.json`  (PaperRead.audit.verdict)
 *   - `<project>/.mathran/agent-runs/<run-id>/report.json` (latest InitAgentReport)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveWorkspaceRoot } from "./project.js";
import { listPaperReadIds, readPaperReadFile, type PaperRead } from "../../core/paper-graph/index.js";
import { listRuns, runDir } from "../../core/agents/init-project/runs-ledger.js";
import type { InitAgentReport } from "../../core/agents/init-project/types.js";

export interface ReadReportOptions {
  workspace?: string;
  json?: boolean;
}

type Verdict = "trusted" | "warn" | "rejected" | "skipped";

export interface ReadReportData {
  slug: string;
  projectDir: string;
  byStatus: Record<Verdict, number>;
  rejected: Array<{ paperId: string; arxivId?: string; reason: string }>;
  report: InitAgentReport | null;
  totalReads: number;
}

function statusOf(read: PaperRead): Verdict {
  const v = read.audit?.verdict;
  if (v === "trusted" || v === "warn" || v === "rejected" || v === "skipped") return v;
  // No audit pass → held with neutral trust.
  return "skipped";
}

/** Find the most-recent run report.json for a project (or null). */
export async function latestReport(projectDir: string): Promise<InitAgentReport | null> {
  const runs = await listRuns(projectDir); // most-recent-first
  for (const run of runs) {
    try {
      const raw = await fs.readFile(path.join(runDir(projectDir, run.runId), "report.json"), "utf-8");
      return JSON.parse(raw) as InitAgentReport;
    } catch {
      /* this run had no report; try the next */
    }
  }
  return null;
}

/** Gather the structured read-report data. Pure aside from fs reads. */
export async function buildReadReport(workspace: string, slug: string): Promise<ReadReportData> {
  const projectDir = path.join(workspace, "projects", slug);
  const ids = await listPaperReadIds(workspace);
  const byStatus: Record<Verdict, number> = { trusted: 0, warn: 0, rejected: 0, skipped: 0 };
  const rejected: ReadReportData["rejected"] = [];

  for (const id of ids) {
    const read = await readPaperReadFile(workspace, id);
    if (!read) continue;
    const status = statusOf(read);
    byStatus[status] += 1;
    if (status === "rejected") {
      rejected.push({
        paperId: read.paperId,
        arxivId: read.arxivId,
        reason: read.audit?.reason ?? read.audit?.flags?.join("; ") ?? "(no reason recorded)",
      });
    }
  }

  const report = await latestReport(projectDir);
  return { slug, projectDir, byStatus, rejected, report, totalReads: ids.length };
}

function renderReadReport(data: ReadReportData): string {
  const lines: string[] = [];
  lines.push(`Read report — ${data.slug}`);
  lines.push("");
  lines.push(`Reads (${data.totalReads} total):`);
  lines.push(`  trusted:  ${data.byStatus.trusted}`);
  lines.push(`  warn:     ${data.byStatus.warn}`);
  lines.push(`  rejected: ${data.byStatus.rejected}`);
  lines.push(`  skipped:  ${data.byStatus.skipped}`);
  lines.push("");

  if (data.rejected.length > 0) {
    lines.push("Rejected papers:");
    for (const r of data.rejected) {
      lines.push(`  - ${r.arxivId ?? r.paperId}: ${r.reason}`);
    }
    lines.push("");
  }

  const report = data.report;
  if (!report) {
    lines.push("No run report found (run `mathran ai-init` first).");
    return lines.join("\n");
  }

  lines.push(`Convergence: ${report.convergenceSummary.reason} (${report.convergenceSummary.rounds} rounds)`);
  lines.push("");

  lines.push(`Unresolved citations (${report.unresolvedCitations.length}):`);
  for (const u of report.unresolvedCitations) {
    // doi/venue come from the Crossref harvest fallback (reading-loop.ts).
    // Surface them so the user has a concrete fetch hint instead of just a
    // title — "go to the venue, here's the DOI" beats "good luck finding it".
    const suffix =
      u.doi
        ? ` [DOI: ${u.doi}${u.venue ? `, ${u.venue}` : ""}]`
        : "";
    lines.push(`  - ${u.citedTitle}${suffix}: ${u.whyImportant}`);
  }
  if (report.unresolvedCitations.length === 0) lines.push("  (none)");
  lines.push("");

  const a = report.llmAccounting;
  lines.push("LLM cost summary:");
  lines.push(`  writer model:   ${report.writerModel}`);
  lines.push(`  reviewer model: ${report.reviewerModel}`);
  lines.push(`  calls: writer=${a.writerCallsTotal} reviewer=${a.reviewerCallsTotal} reader=${a.readerCallsTotal} plan=${a.planAgentCalls}`);
  lines.push(`  estimated total: $${a.estimatedTotalUsd.toFixed(4)}`);
  if (Object.keys(a.breakdownByPhase).length > 0) {
    lines.push("  by phase:");
    for (const [phase, b] of Object.entries(a.breakdownByPhase)) {
      lines.push(`    ${phase.padEnd(20)} calls=${b.calls}  $${b.estimatedUsd.toFixed(4)}`);
    }
  }

  const r = report.revisionsSummary;
  lines.push("");
  lines.push("Revisions:");
  lines.push(`  reviewed=${r.artifactsReviewed} approved=${r.artifactsApproved} flagged=${r.artifactsFlaggedPersistent} reviewer_broken=${r.artifactsReviewerBroken}`);
  lines.push(`  avg=${r.avgRevisionsPerArtifact} max=${r.maxRevisionsAcrossArtifacts}`);

  // 2026-06-28 (fix #2 from run-13-audit): surface spine quality with a
  // red-flag header at high shallow ratios so users notice when the run's
  // spine was rescued rather than freshly extracted. ≥80% shallow with
  // any llm_error reason almost always means "retry this run, the LLM
  // call flaked"; ≥80% shallow with no llm_error means "your corpus is
  // genuinely thin".
  const sq = report.spineQuality;
  if (sq) {
    lines.push("");
    if (sq.shallowFraction >= 0.8) {
      lines.push(`Spine quality: ⚠ ${sq.shallowNodes}/${sq.totalNodes} nodes shallow (${Math.round(sq.shallowFraction * 100)}%)`);
    } else {
      lines.push(`Spine quality: ${sq.shallowNodes}/${sq.totalNodes} nodes shallow (${Math.round(sq.shallowFraction * 100)}%)`);
    }
    if (sq.shallowNodes > 0) {
      lines.push(`  reasons: llm_error=${sq.shallowByReason.llm_error} parse_error=${sq.shallowByReason.parse_error} no_candidates=${sq.shallowByReason.no_candidates}`);
      if (sq.shallowByReason.llm_error > 0) {
        lines.push(`  hint: shallowNodes include LLM transient failures — re-running often produces a much better spine.`);
      }
    }
  }

  // 2026-06-29 (fix from run-14-audit): hypothesis-spine reconcile. Absent
  // (the field itself) → no hypothesis was generated. Present → render
  // verified/refined/falsified/unread so users can see whether their
  // pre-read hypothesis tracked reality.
  const rc = report.reconcile;
  if (rc) {
    lines.push("");
    lines.push("Hypothesis-spine reconcile:");
    lines.push(`  verified=${rc.verified} refined=${rc.refined} falsified=${rc.falsified} unread=${rc.unread} / ${rc.totalHypothesisNodes}`);
  }

  return lines.join("\n");
}

/** CLI action handler. Returns a process exit code. */
export async function runReadReport(slug: string, opts: ReadReportOptions): Promise<number> {
  const workspace = resolveWorkspaceRoot(opts.workspace);
  const projectDir = path.join(workspace, "projects", slug);
  try {
    await fs.access(projectDir);
  } catch {
    console.error(`mathran project read-report: project not found: ${slug} (in ${workspace}/projects/)`);
    return 1;
  }
  try {
    const data = await buildReadReport(workspace, slug);
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(renderReadReport(data));
    }
    return 0;
  } catch (err) {
    console.error(`mathran project read-report: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
