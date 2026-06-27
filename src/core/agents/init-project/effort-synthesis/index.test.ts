import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { synthesizeEffort } from "./index.js";
import type { SpineLLM } from "../spine/llm.js";
import { makeNode, makeSpine, makeFullPaperRead } from "./test-fixtures.js";

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathran-effort-synth-"));
});
afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

/**
 * A scripted LLM: returns a valid outline first, then anchored section prose,
 * then a README with a specific "noticed" observation.
 */
function scriptedLLM(): SpineLLM {
  return async (prompt: string) => {
    if (prompt.includes("Decide what sections")) {
      return JSON.stringify({
        title: "Sharp Chromatic Bound",
        thesis: "A sharp upper bound for the chromatic number and its probabilistic proof.",
        narrativeRole: "core_technique",
        sections: [
          { heading: "Setup", anchor: "setup", purpose: "objects", targetParagraphs: 1, mustCite: [{ kind: "paper-read", id: "2401.00001" }] },
          { heading: "Main Result", anchor: "main-result", purpose: "theorem", targetParagraphs: 1, mustCite: [{ kind: "paper-read", id: "2401.00001" }] },
          { heading: "Proof Strategy", anchor: "proof-strategy", purpose: "argument", targetParagraphs: 1, mustCite: [{ kind: "paper-read", id: "2401.00001" }] },
        ],
      });
    }
    if (prompt.includes("writing ONE section")) {
      const anchorMatch = prompt.match(/anchor: ([a-z0-9-]+)/);
      const anchor = anchorMatch ? anchorMatch[1] : "section";
      return `## Section {#${anchor}}\n\nWe have $\\chi(G) \\le \\Delta(G) + 1$ @paper-read:2401.00001#mainResult-1.`;
    }
    if (prompt.includes("introduces this effort to a human")) {
      return [
        "# Sharp Chromatic Bound — Reading Guide",
        "## What this is",
        "A sharp bound.",
        "## What the agent noticed while reading",
        "- Equation (7) on p.12 carries a sign typo flagged by the rigor audit; harmless but distracting.",
        "## Source provenance",
        "- 2401.00001 (tex).",
      ].join("\n\n");
    }
    return "fallback";
  };
}

describe("synthesizeEffort (4-piece-set, end-to-end)", () => {
  it("writes a real document.md, README with a non-empty 'noticed' section, and rendered reading notes", async () => {
    const node = makeNode("n1");
    const reads = [makeFullPaperRead("n1-paper")];
    const logs: string[] = [];

    const result = await synthesizeEffort(
      {
        node,
        spine: makeSpine([node]),
        paperReads: reads,
        predecessorNodes: [],
        successorNodes: [],
        problemTitle: "Chromatic numbers",
        projectDir,
      },
      { llm: scriptedLLM(), emitLog: (m) => logs.push(m) },
    );

    const dir = path.join(projectDir, "efforts", result.effortId);

    // document.md — real content, not a stub work-log.
    const doc = await fs.readFile(result.documentPath, "utf-8");
    expect(doc).toContain("generatedBy: effort-synthesis");
    expect(doc).toContain("## Setup {#setup}");
    expect(doc).toContain("## Main Result {#main-result}");
    expect(doc).toContain("@paper-read:2401.00001#mainResult-1");
    expect(doc).not.toContain("_(your notes go here)_");

    // README.md — non-empty "What the agent noticed".
    const readme = await fs.readFile(result.readmePath, "utf-8");
    expect(readme).toContain("## What the agent noticed while reading");
    expect(readme).toContain("sign typo");

    // reading notes rendered from the PaperRead.
    const notes = await fs.readFile(result.readingNotesPath, "utf-8");
    expect(notes).toContain("# Reading Notes");
    expect(notes).toContain("## Pass 2: Read findings");

    // scratch placeholder + effort.json persisted.
    const scratch = await fs.readFile(path.join(dir, "scratch", ".placeholder.md"), "utf-8");
    expect(scratch).toContain("Your scratch space");
    const effortJson = JSON.parse(await fs.readFile(path.join(dir, "effort.json"), "utf-8"));
    expect(effortJson.outline.sections.length).toBe(3);
    expect(effortJson.readmeStatus).toBe("generated");
    expect(effortJson.readingNotesStatus).toBe("generated");
  });

  it("runs the writer-reviewer loop and persists documentRevisions when a reviewer model is supplied", async () => {
    const node = makeNode("n1", { depth: "foundational" });
    const reads = [makeFullPaperRead("n1-paper")];

    // Reviewer: reject the document once (blocks-understanding), then approve;
    // approve the README on first read.
    let docReviews = 0;
    const reviewerLlm: SpineLLM = async (prompt: string) => {
      const isReadme = prompt.includes("reading-guide README");
      if (isReadme) {
        return JSON.stringify({ verdict: "approve", overallReaderExperience: "Clear guide.", issues: [], verdict_reasoning: "ok" });
      }
      docReviews++;
      if (docReviews === 1) {
        return JSON.stringify({
          verdict: "rewrite_requested",
          overallReaderExperience: "Lost me in the proof.",
          issues: [{ location: "Proof p1", severity: "blocks-understanding", kind: "skips-steps", what_you_experienced: "jump", what_would_help: "expand" }],
          verdict_reasoning: "needs steps",
        });
      }
      return JSON.stringify({ verdict: "approve", overallReaderExperience: "Now clear.", issues: [], verdict_reasoning: "ok" });
    };

    const result = await synthesizeEffort(
      {
        node,
        spine: makeSpine([node]),
        paperReads: reads,
        predecessorNodes: [],
        successorNodes: [],
        problemTitle: "Chromatic numbers",
        projectDir,
      },
      { llm: scriptedLLM(), reviewerLlm, writerModel: "openai/gpt-5.5", reviewerModel: "anthropic/opus-4.8" },
    );

    expect(result.documentRevisions).toBeDefined();
    // revision 0 (rejected) + revision 1 (approved) = 2 history entries
    expect(result.documentRevisions!.length).toBe(2);
    expect(result.documentRevisions![0]!.reviewerVerdict).toBe("rewrite_requested");
    expect(result.documentRevisions![1]!.reviewerVerdict).toBe("approve");

    const dir = path.join(projectDir, "efforts", result.effortId);
    const effortJson = JSON.parse(await fs.readFile(path.join(dir, "effort.json"), "utf-8"));
    expect(effortJson.documentRevisions).toHaveLength(2);
  });

  it("skips the review loop (no documentRevisions) when no reviewer model is supplied", async () => {
    const node = makeNode("n2");
    const reads = [makeFullPaperRead("n2-paper")];
    const result = await synthesizeEffort(
      {
        node,
        spine: makeSpine([node]),
        paperReads: reads,
        predecessorNodes: [],
        successorNodes: [],
        problemTitle: "Chromatic numbers",
        projectDir,
      },
      { llm: scriptedLLM() },
    );
    expect(result.documentRevisions).toBeUndefined();
    const dir = path.join(projectDir, "efforts", result.effortId);
    const effortJson = JSON.parse(await fs.readFile(path.join(dir, "effort.json"), "utf-8"));
    expect(effortJson.documentRevisions).toBeUndefined();
  });
});
