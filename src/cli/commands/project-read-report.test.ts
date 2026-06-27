import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { buildReadReport, runReadReport } from "./project-read-report.js";
import { writePaperReadFile } from "../../core/paper-graph/index.js";
import type { PaperRead } from "../../core/paper-graph/index.js";
import type { InitAgentReport } from "../../core/agents/init-project/types.js";

let workspace: string;
let projectDir: string;
const SLUG = "demo-project";

function makeRead(id: string, verdict?: "trusted" | "warn" | "rejected" | "skipped", reason?: string): PaperRead {
  const now = new Date().toISOString();
  return {
    paperId: id,
    arxivId: id,
    sourceKind: "tex",
    sourceBytes: 100,
    truncated: false,
    skim: {
      oneLineSummary: `summary ${id}`,
      mainContribution: "c",
      sectionOutline: [],
      decision: "study",
      decisionReason: "r",
    },
    audit: verdict
      ? { verdict, flags: [], reason, pass: "fine", checkedAt: now }
      : undefined,
    outgoingCitations: [],
    isSurvey: false,
    modelUsed: "m",
    promptVersion: "v1",
    passesCompleted: ["skim"],
    totalLlmCalls: 1,
    totalTokensIn: 10,
    totalTokensOut: 20,
    createdAt: now,
    updatedAt: now,
  };
}

const SAMPLE_REPORT: InitAgentReport = {
  runId: "run-abc",
  projectSlug: SLUG,
  generatedAt: new Date().toISOString(),
  writerModel: "openai/gpt-5.5",
  reviewerModel: "anthropic/opus-4.8",
  llmAccounting: {
    writerCallsTotal: 4,
    reviewerCallsTotal: 6,
    readerCallsTotal: 7,
    planAgentCalls: 2,
    estimatedTotalUsd: 0.1234,
    breakdownByPhase: { build_spine: { calls: 2, estimatedUsd: 0.02 } },
  },
  revisionsSummary: {
    artifactsReviewed: 5,
    artifactsApproved: 4,
    artifactsFlaggedPersistent: 1,
    avgRevisionsPerArtifact: 0.4,
    maxRevisionsAcrossArtifacts: 2,
  },
  unresolvedCitations: [{ citedTitle: "Chen 1966", whyImportant: "the key sieve bound" }],
  convergenceSummary: { reason: "natural", rounds: 3 },
  fieldTooLargeTripped: false,
};

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-readreport-"));
  projectDir = path.join(workspace, "projects", SLUG);
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("buildReadReport", () => {
  it("buckets reads by audit verdict", async () => {
    await writePaperReadFile(workspace, makeRead("1111.1111", "trusted"));
    await writePaperReadFile(workspace, makeRead("2222.2222", "warn"));
    await writePaperReadFile(workspace, makeRead("3333.3333", "rejected", "pseudoscience"));
    await writePaperReadFile(workspace, makeRead("4444.4444", "skipped"));
    await writePaperReadFile(workspace, makeRead("5555.5555")); // no audit → skipped

    const data = await buildReadReport(workspace, SLUG);
    expect(data.byStatus.trusted).toBe(1);
    expect(data.byStatus.warn).toBe(1);
    expect(data.byStatus.rejected).toBe(1);
    expect(data.byStatus.skipped).toBe(2);
    expect(data.totalReads).toBe(5);
  });

  it("surfaces rejected papers with reasons", async () => {
    await writePaperReadFile(workspace, makeRead("3333.3333", "rejected", "fabricated proof"));
    const data = await buildReadReport(workspace, SLUG);
    expect(data.rejected).toHaveLength(1);
    expect(data.rejected[0]!.reason).toBe("fabricated proof");
  });

  it("loads the latest run report.json", async () => {
    const runDir = path.join(projectDir, ".mathran", "agent-runs", "run-abc");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify({ runId: "run-abc", agentType: "init-project", status: "completed", startedAt: new Date().toISOString() }), "utf-8");
    await fs.writeFile(path.join(runDir, "report.json"), JSON.stringify(SAMPLE_REPORT), "utf-8");

    const data = await buildReadReport(workspace, SLUG);
    expect(data.report).not.toBeNull();
    expect(data.report!.llmAccounting.estimatedTotalUsd).toBeCloseTo(0.1234);
    expect(data.report!.unresolvedCitations).toHaveLength(1);
  });
});

describe("runReadReport", () => {
  it("returns 1 for a missing project", async () => {
    const code = await runReadReport("nope", { workspace });
    expect(code).toBe(1);
  });

  it("returns 0 and prints for an existing project", async () => {
    await writePaperReadFile(workspace, makeRead("1111.1111", "trusted"));
    const code = await runReadReport(SLUG, { workspace });
    expect(code).toBe(0);
  });
});
