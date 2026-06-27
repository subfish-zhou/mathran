import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import {
  preserveV1Artifacts,
  gatherSeedReferences,
  runUpgradeToV3,
} from "./project-upgrade.js";
import { ingestPaper, associatePaperToProject } from "../../core/paper-graph/index.js";
import type { InitAgentResult } from "../../core/agents/init-project/index.js";

let workspace: string;
let projectDir: string;
const SLUG = "demo-project";

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-upgrade-"));
  projectDir = path.join(workspace, "projects", SLUG);
  await fs.mkdir(projectDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("preserveV1Artifacts", () => {
  it("moves wiki/ and efforts/ to *.v1/", async () => {
    await fs.mkdir(path.join(projectDir, "wiki"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "wiki", "index.md"), "# old", "utf-8");
    await fs.mkdir(path.join(projectDir, "efforts", "e1"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "efforts", "e1", "document.md"), "old doc", "utf-8");

    const preserved = await preserveV1Artifacts(projectDir);
    expect(preserved.sort()).toEqual(["efforts.v1", "wiki.v1"]);

    expect(await fs.readFile(path.join(projectDir, "wiki.v1", "index.md"), "utf-8")).toBe("# old");
    expect(await fs.readFile(path.join(projectDir, "efforts.v1", "e1", "document.md"), "utf-8")).toBe("old doc");
    // originals gone
    await expect(fs.access(path.join(projectDir, "wiki"))).rejects.toThrow();
  });

  it("is a no-op when there is nothing to preserve", async () => {
    const preserved = await preserveV1Artifacts(projectDir);
    expect(preserved).toEqual([]);
  });

  it("replaces a pre-existing backup", async () => {
    await fs.mkdir(path.join(projectDir, "wiki"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "wiki", "a.md"), "new", "utf-8");
    await fs.mkdir(path.join(projectDir, "wiki.v1"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "wiki.v1", "stale.md"), "stale", "utf-8");

    await preserveV1Artifacts(projectDir);
    await expect(fs.access(path.join(projectDir, "wiki.v1", "stale.md"))).rejects.toThrow();
    expect(await fs.readFile(path.join(projectDir, "wiki.v1", "a.md"), "utf-8")).toBe("new");
  });
});

describe("gatherSeedReferences", () => {
  it("collects arxiv-backed associated papers", async () => {
    const id = await ingestPaper(workspace, {
      title: "Bounded gaps",
      authors: ["Zhang"],
      arxivId: "1311.1234",
      year: 2014,
    });
    expect(id).toBeTruthy();
    await associatePaperToProject(projectDir, id!, { discoveredBy: "seed", depth: 0, relevanceScore: 1 });

    const refs = await gatherSeedReferences(workspace, projectDir);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.arxivId).toBe("1311.1234");
    expect(refs[0]!.type).toBe("arxiv");
  });

  it("skips papers without an arxivId", async () => {
    const id = await ingestPaper(workspace, { title: "No arxiv", authors: [], doi: "10.1000/x" });
    await associatePaperToProject(projectDir, id!, { discoveredBy: "seed", depth: 0, relevanceScore: 1 });
    const refs = await gatherSeedReferences(workspace, projectDir);
    expect(refs).toHaveLength(0);
  });
});

describe("runUpgradeToV3", () => {
  it("returns 1 for a missing project", async () => {
    const code = await runUpgradeToV3("nope", { workspace });
    expect(code).toBe(1);
  });

  it("returns 1 when no arxiv papers are associated", async () => {
    const code = await runUpgradeToV3(SLUG, { workspace });
    expect(code).toBe(1);
  });

  it("preserves v1 output and invokes the agent with the existing seeds", async () => {
    // Seed an associated arxiv paper.
    const id = await ingestPaper(workspace, { title: "Seed", authors: ["A"], arxivId: "2401.00001", year: 2024 });
    await associatePaperToProject(projectDir, id!, { discoveredBy: "seed", depth: 0, relevanceScore: 1 });
    // Existing v1 output.
    await fs.mkdir(path.join(projectDir, "wiki"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "wiki", "index.md"), "# v1", "utf-8");

    const fakeResult: InitAgentResult = {
      projectSlug: SLUG,
      wikiPages: ["index"],
      crawledResources: 1,
      seedPapers: 1,
      mode: "spine",
      summary: { conceptsExtracted: 0, queriesRun: 0, resourcesFound: 1, wikiPagesGenerated: 1, durationMs: 1, spineNodes: 3, effortsCreated: 2 },
    };
    const runAgent = vi.fn(async () => fakeResult);
    const buildLLM = vi.fn(() => ({ llm: {} as never, model: "fake/model" }));

    const code = await runUpgradeToV3(SLUG, { workspace }, { runAgent, buildLLM });
    expect(code).toBe(0);
    expect(runAgent).toHaveBeenCalledOnce();

    // v1 preserved
    expect(await fs.readFile(path.join(projectDir, "wiki.v1", "index.md"), "utf-8")).toBe("# v1");

    // agent invoked with the existing seed + v3 config
    const calls = runAgent.mock.calls as unknown as Array<[unknown]>;
    expect(calls.length).toBeGreaterThan(0);
    const input = calls[0][0] as { aiInit: { useSpine: boolean }; seedReferences: Array<{ arxivId: string }> };
    expect(input.aiInit.useSpine).toBe(true);
    expect(input.seedReferences[0]!.arxivId).toBe("2401.00001");
  });
});
