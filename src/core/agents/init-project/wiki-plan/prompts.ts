/**
 * Wiki Outliner — prompt construction.
 *
 * The outliner replaces the fixed 5-page wiki template
 * (overview/key-results/techniques/open-problems/bibliography) with an
 * LLM-decided page plan tailored to what the field actually contains
 * (DESIGN-REFERENCE Part 4). The prompt casts the model as the editor deciding
 * the structure of a NEW survey that must ADD VALUE beyond existing surveys.
 */

import type { OutlineWikiInput } from "./index.js";
import type { SpineNode } from "../spine/types.js";

export const WIKI_OUTLINE_PROMPT_VERSION = "v2";

export function buildWikiOutlinePrompt(input: OutlineWikiInput): string {
  const { problem, spine, reads, priorArt } = input;

  // ── Spine threads (status + frontier) ──
  const threadLines = spine.threads
    .map((t) => {
      const frontier = t.currentFrontier ? ` | frontier: ${t.currentFrontier.slice(0, 160)}` : "";
      const barrier = t.barrier ? ` | barrier: ${t.barrier.slice(0, 120)}` : "";
      return `  - [${t.status}] ${t.name}: ${t.description}${frontier}${barrier}\n    node ids: ${t.nodeIds.join(", ") || "(none)"}`;
    })
    .join("\n");

  // ── Eras (summary) ──
  const eraLines = spine.eras
    .map((e) => `  - ${e.name}: ${e.summary} (nodes: ${e.nodeIds.join(", ") || "none"})`)
    .join("\n");

  // ── Open questions ──
  const openLines = spine.openQuestions
    .map((q) => `  - ${q.title}: ${q.statement.slice(0, 160)} (barrier: ${q.barrier.slice(0, 100)})`)
    .join("\n");

  // ── Paper-count summary by role ──
  const roleCounts = new Map<string, number>();
  for (const r of reads) {
    const role = r.read?.role ?? "unknown";
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  const roleSummary = [...roleCounts.entries()].map(([role, n]) => `${role}=${n}`).join(", ");

  // ── A few representative spine node ids (for keyEffortsCited proxies) ──
  const nodeIdHint = spine.nodes.map((n: SpineNode) => `${n.id} ("${n.title}")`).slice(0, 40).join("; ");

  // ── Prior surveys (add-value framing) ──
  const surveyLines = (priorArt?.surveys ?? [])
    .map((s) => {
      const read = reads.find((r) => r.paperId === s.paperId);
      const outline = read?.surveyDistillation?.surveyOutline?.map((o) => o.heading) ?? [];
      const covered = outline.length > 0 ? ` — covers: ${outline.join(" | ")}` : "";
      return `  - "${s.title}" (${s.year ?? "?"}, confidence ${s.confidence.toFixed(2)})${covered}`;
    })
    .join("\n");

  const priorArtBlock = (priorArt?.surveys?.length ?? 0) > 0
    ? `PRIOR SURVEYS THAT ALREADY EXIST (your wiki must ADD VALUE beyond these):
${surveyLines}

When deciding pages, consider: (1) what's been published SINCE the most recent survey; (2) which threads the existing surveys cover thinly; (3) what NEW connections / re-organizations the post-survey literature suggests. Produce complementary content, not a redundant rehash.`
    : `No prior surveys were found for this field — your wiki is the first systematic survey, so cover the field comprehensively from foundations to frontier.`;

  return `You are the editor deciding the structure of a survey ("wiki") on the mathematical problem "${problem.title}".

## Problem
Title: ${problem.title}
Formal statement: ${problem.formalStatement}
Status: ${problem.mathStatus ?? "OPEN"}

## Narrative spine
Global thesis: ${spine.globalThesis}

Research threads (status + frontier):
${threadLines || "  (none)"}

Eras:
${eraLines || "  (none)"}

Open questions:
${openLines || "  (none)"}

Spine node ids you may reference (use these as keyEffortsCited proxies):
${nodeIdHint || "(none)"}

## Corpus
${reads.length} papers read. Roles: ${roleSummary || "(none)"}.

## ${priorArtBlock}

## Your job
Decide what wiki pages THIS project should have, in service of a serious survey. Do NOT force a fixed template — let the field's actual structure dictate the pages. A solved problem might have a "what's next: variants" page instead of "open problems"; a problem with several distinct attacks deserves one page per attack.

You must ALSO produce an "argument map" — an explicit decomposition of the globalThesis into 3–8 sub-claims, each tied to the page(s) that argue for it. This is the wiki's *intellectual skeleton*: the introductory page renders it for the reader; every other page knows which sub-claim it is arguing. WITHOUT the argument map, pages drift into standalone short-essays grouped by topic; WITH it, the wiki reads as a single coherent argument.

## Hard constraints (also enforced after parsing — obey them):
1. Between 3 and 12 pages total.
2. EXACTLY one introductory page with audience "graduate-student-entering-field" (this is the overview replacement) — put it first in pageOrder. This page renders the argument map for the reader (thesis → sub-claims → which page argues each → reading arc).
3. EXACTLY one bibliography page, LAST in pageOrder.
4. pageOrder must list every page slug exactly once and define a sensible cover-to-cover reading sequence.
5. Every non-bibliography page must anchor to the workspace: keyEffortsCited (spine node ids) and/or keyPaperReadsCited (paper ids) must be non-empty.
6. argumentMap.subClaims has between 3 and 8 entries; every CONTENT page (not the intro, not bibliography) MUST appear in exactly one sub-claim's supportedByPages; every page in supportedByPages MUST exist in pages[]; subClaim.dependsOn forms a DAG (no cycles) over the sub-claim ids you define.
7. Each content page sets 'subClaimId' to the id of the sub-claim it argues. The intro page leaves subClaimId empty (it renders the whole map). Bibliography leaves it empty.
8. relatedPages relations are TYPED: each entry is {slug, relation} where relation ∈ {prerequisite, extends, contrasts-with, applies, follows-up}. Use the vocabulary literally:
   - prerequisite — "the reader should read X first to follow this page"
   - extends — "this page builds directly on X's results"
   - contrasts-with — "this page presents a competing / alternative approach to X"
   - applies — "this page applies X's methods/results to a new setting"
   - follows-up — "X partially answered a question; this page continues / refines"

## Output
Output ONLY a valid JSON object with this EXACT shape:
{
  "globalThesis": "1-2 sentence through-line for the whole wiki",
  "argumentMap": {
    "thesis": "same as globalThesis, restated for the map's standalone export",
    "subClaims": [
      {
        "id": "C1",
        "claim": "Specialist-readable sentence stating what we are arguing",
        "supportedByPages": ["page-slug-1", "page-slug-2"],
        "dependsOn": []
      },
      {
        "id": "C2",
        "claim": "Next sub-claim",
        "supportedByPages": ["page-slug-3"],
        "dependsOn": ["C1"]
      }
    ]
  },
  "totalPages": 7,
  "pages": [
    {
      "slug": "url-safe-slug",
      "title": "Human title",
      "purpose": "1-3 sentences: why this page exists in THIS wiki",
      "audience": "graduate-student-entering-field" | "specialist-refresher" | "expert-checking-status",
      "estimatedLengthWords": 2500,
      "coreSections": ["Top-level heading 1", "Heading 2"],
      "keyEffortsCited": ["spine-node-id-1"],
      "keyPaperReadsCited": ["paper-id-1"],
      "relatedPages": [
        { "slug": "other-slug", "relation": "prerequisite" }
      ],
      "subClaimId": "C2",
      "narrativeRole": "free-form, e.g. 'sets the historical stage'"
    }
  ],
  "pageOrder": ["overview-slug", "...", "bibliography"]
}

## Examples (different fields → different shapes)

Ternary Goldbach (SOLVED):
  overview → circle-method → minor-arc-technology → major-arcs → finite-verification → modern-variants → bibliography

Binary Goldbach (OPEN):
  overview → sieve-method-history → circle-method-attempts → exceptional-set → chen-1+2-and-beyond → barriers-and-strategies → open-questions → bibliography

Riemann hypothesis:
  overview → function-theoretic-approach → pair-correlation-and-random-matrix → explicit-formulae-perspective → moments-of-zeta → selberg-class-and-generalizations → conditional-cascade → computational-evidence → famous-failed-attempts → open-questions → bibliography

Each is a legitimate survey shape. Pick based on what THIS field actually contains.

Output ONLY valid JSON.`;
}
