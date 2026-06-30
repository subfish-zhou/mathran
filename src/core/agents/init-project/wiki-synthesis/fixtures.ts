/**
 * Shared synthetic fixtures for wiki-synthesis tests:
 * a 3-page WikiPlan + 5 effort documents + 8 PaperReads.
 */

import type { WikiPlan, WikiPlanPage, ArgumentMap, RelatedPage } from "../wiki-plan/index.js";
import type { NarrativeSpine } from "../spine/types.js";
import type { PaperRead } from "../../../paper-graph/types.js";

export function planPage(slug: string, overrides: Partial<WikiPlanPage> = {}): WikiPlanPage {
  return {
    slug,
    title: `Title ${slug}`,
    purpose: `Purpose of ${slug}`,
    audience: "specialist-refresher",
    estimatedLengthWords: 1500,
    coreSections: [`${slug} Section A`, `${slug} Section B`],
    keyEffortsCited: [],
    keyPaperReadsCited: [],
    relatedPageSlugs: [],
    // 2026-06-30: WikiPlanPage gained typed relatedPages + optional
    // subClaimId. Default both to empty so legacy fixtures stay terse;
    // overrides can supply richer values per-test.
    relatedPages: [],
    narrativeRole: "content",
    ...overrides,
  };
}

export function threePagePlan(): WikiPlan {
  const overview = planPage("overview", {
    audience: "graduate-student-entering-field",
    narrativeRole: "introduction",
    keyEffortsCited: ["effort-1", "effort-2"],
    keyPaperReadsCited: ["paper-1", "paper-2"],
    relatedPageSlugs: ["circle-method"],
    relatedPages: [{ slug: "circle-method", relation: "extends" }],
  });
  const circle = planPage("circle-method", {
    keyEffortsCited: ["effort-3", "effort-4"],
    keyPaperReadsCited: ["paper-3", "paper-4", "paper-5"],
    relatedPageSlugs: ["overview", "bibliography"],
    relatedPages: [
      { slug: "overview", relation: "prerequisite" },
      { slug: "bibliography", relation: "extends" },
    ],
    subClaimId: "C1",
  });
  const biblio = planPage("bibliography", {
    narrativeRole: "references",
    keyEffortsCited: ["effort-5"],
    keyPaperReadsCited: ["paper-6", "paper-7", "paper-8"],
    relatedPageSlugs: [],
    relatedPages: [],
  });
  return {
    globalThesis: "Goldbach via circle method",
    totalPages: 3,
    pages: [overview, circle, biblio],
    pageOrder: ["overview", "circle-method", "bibliography"],
    // 2026-06-30: ship an argument map so writer-prompt fixtures exercise
    // the v3 argumentMapBlock path. Degenerate (one sub-claim, one page)
    // is fine for fixture purposes.
    argumentMap: {
      thesis: "Goldbach via circle method",
      subClaims: [
        {
          id: "C1",
          claim: "The circle method gives the right decomposition for ternary Goldbach.",
          supportedByPages: ["circle-method"],
          dependsOn: [],
        },
      ],
    },
  };
}

/** A WikiPlan with NO argumentMap — covers the legacy fall-back path. */
export function threePagePlanLegacy(): WikiPlan {
  const p = threePagePlan();
  delete p.argumentMap;
  for (const page of p.pages) delete page.subClaimId;
  return p;
}

export function relatedPage(slug: string, relation: RelatedPage["relation"]): RelatedPage {
  return { slug, relation };
}

export function argumentMap(overrides: Partial<ArgumentMap> = {}): ArgumentMap {
  return {
    thesis: "Goldbach via circle method",
    subClaims: [
      { id: "C1", claim: "Circle method applies", supportedByPages: ["circle-method"], dependsOn: [] },
    ],
    ...overrides,
  };
}

export function emptySpine(): NarrativeSpine {
  return {
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    globalThesis: "thesis",
    eras: [],
    nodes: [],
    edges: [],
    threads: [],
    openQuestions: [],
  };
}

export function fiveEffortDocs(): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 1; i <= 5; i++) {
    m.set(`effort-${i}`, `# Effort ${i}\n\nThis effort proves bound $B_${i} = 1/${i}$.`);
  }
  return m;
}

export function paperRead(id: string, overrides: Partial<PaperRead> = {}): PaperRead {
  return {
    paperId: id,
    sourceKind: "tex",
    sourceBytes: 1000,
    truncated: false,
    skim: {
      oneLineSummary: `${id} summary`,
      mainContribution: "contribution",
      sectionOutline: [],
      decision: "study",
      decisionReason: "relevant",
    },
    read: {
      mainResults: [
        {
          label: "Theorem 1",
          statement: `Result of ${id}: $x_{${id}} < 1$`,
          whereInPaper: "§1",
          noveltyVsPrior: "novel",
        },
      ],
      proofStrategy: "strategy",
      keyTechniques: [],
      technicalDependencies: [],
      novelContributions: "novel",
      standardMaterial: "standard",
      hardSteps: [],
      role: "milestone",
    },
    outgoingCitations: [],
    isSurvey: false,
    modelUsed: "test",
    promptVersion: "v1",
    passesCompleted: ["skim", "read"],
    totalLlmCalls: 1,
    totalTokensIn: 100,
    ...overrides,
  } as PaperRead;
}

export function eightPaperReads(): PaperRead[] {
  return Array.from({ length: 8 }, (_, i) => paperRead(`paper-${i + 1}`));
}
