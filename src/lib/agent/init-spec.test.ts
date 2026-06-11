import assert from "node:assert/strict";
import test from "node:test";

import { checkCompleteness } from "./init-spec";
import type { InitAgentResult } from "./init-types";

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
}

function buildResultWithRef(refId: string): InitAgentResult {
  const overviewContent = [
    "> [AI-GENERATED] This content was automatically generated and requires human review.",
    "## Problem Statement",
    `$a$ $b$ $c$ ${words(260)} @ws:${refId}`,
    "## Historical Context",
    words(260),
    "## Current Status",
    words(260),
  ].join("\n\n");

  return {
    wikiPages: [
      {
        slug: "overview",
        title: "Overview — Test Problem",
        content: overviewContent,
        workspaceRefs: [refId],
      },
      {
        slug: "key-results",
        title: "Key Results & Timeline",
        content: `${words(430)} @ws:${refId}`,
        workspaceRefs: [refId],
      },
      {
        slug: "techniques",
        title: "Technical Methods",
        content: `${words(430)} @ws:${refId}`,
        workspaceRefs: [refId],
      },
      {
        slug: "open-problems",
        title: "Open Problems",
        content: `${words(320)} @ws:${refId}`,
        workspaceRefs: [refId],
      },
      {
        slug: "bibliography",
        title: "Bibliography",
        content: `## Primary Papers\n\n${words(240)} @ws:${refId}`,
        workspaceRefs: [refId],
      },
    ],
    workspaceEfforts: [
      {
        id: refId,
        type: "CONSTRUCTION",
        title: "Main Method",
        description: "A detailed construction used throughout the wiki pages.",
        status: "VERIFIED",
      },
      {
        id: "arxiv-1",
        type: "REFERENCE",
        title: "Paper A",
        description: "Primary reference with sufficient abstract information.",
        status: "VERIFIED",
      },
      {
        id: "arxiv-2",
        type: "REFERENCE",
        title: "Paper B",
        description: "Secondary reference with sufficient abstract information.",
        status: "VERIFIED",
      },
    ],
    dependencyEdges: [],
    crawledResources: [],
    summary: {
      wikiPagesGenerated: 5,
      workspaceEffortsCreated: 3,
      referencesFound: 0,
      depGraphEdges: 0,
      totalDurationMs: 0,
    },
  };
}

function buildStrictReadyResult(refId: string): InitAgentResult {
  const result = buildResultWithRef(refId);
  result.workspaceEfforts = result.workspaceEfforts.map((effort) => {
    if (effort.type === "REFERENCE") {
      return {
        ...effort,
        difficultyEstimate: "ROUTINE",
        tags: ["literature"],
        sources: [{
          id: `${effort.id}-source`,
          title: effort.title,
          authors: ["A. Author"],
          sourceType: "arxiv",
          arxivId: `${effort.id}.00001`,
          url: `https://arxiv.org/abs/${effort.id}.00001`,
        }],
      };
    }
    return {
      ...effort,
      difficultyEstimate: "HARD",
      tags: ["finite-checking"],
      document: `# ${effort.title}\n\n${words(520)}`,
    };
  });
  result.dependencyEdges = [{
    fromId: refId,
    toId: "arxiv-1",
    relation: "depends_on",
    description: "The main method depends on the primary reference.",
    confidence: 0.95,
    source: "spine",
  }];
  return result;
}

test("checkCompleteness recognizes @r refs containing dot/underscore", () => {
  const result = buildResultWithRef("method.v1_alpha");
  const check = checkCompleteness(result, "quick");

  assert.equal(check.passed, true);
  const brokenRefWarning = check.warnings.find((w) =>
    w.message.includes("broken references")
  );
  assert.equal(brokenRefWarning, undefined);
});

test("strict quality gate passes structurally complete init result", () => {
  const result = buildStrictReadyResult("method.v1_alpha");
  result.wikiPages[0]!.content = result.wikiPages[0]!.content
    .replace("$a$ $b$ $c$", "\\(a\\) \\[b\\] \\(c\\)");
  const check = checkCompleteness(result, "quick", { strictQualityGate: true });

  assert.equal(check.passed, true);
  assert.equal(check.errors.length, 0);
});

test("strict quality gate promotes structural workspace issues to errors", () => {
  const result = buildResultWithRef("method.v1_alpha");
  result.wikiPages[0]!.content += "\n\n@ws:missing-effort";
  result.workspaceEfforts.push({
    id: "duplicate-method",
    type: "CONSTRUCTION",
    title: "  main method  ",
    description: "Duplicate method with insufficient metadata.",
    status: "DRAFT",
  });
  result.dependencyEdges = [{
    fromId: "method.v1_alpha",
    toId: "arxiv-1",
    relation: "depends_on",
    confidence: 0.8,
  }];

  const check = checkCompleteness(result, "quick", { strictQualityGate: true });
  const messages = check.errors.map((issue) => issue.message).join("\n");

  assert.equal(check.passed, false);
  assert.match(messages, /Duplicate Workspace effort titles/);
  assert.match(messages, /non-reference Workspace efforts are missing substantial documents/);
  assert.match(messages, /REFERENCE efforts are missing structured source metadata/);
  assert.match(messages, /Workspace efforts are missing difficulty estimates/);
  assert.match(messages, /dependency edges are missing descriptions/);
  assert.match(messages, /broken references/);
});
