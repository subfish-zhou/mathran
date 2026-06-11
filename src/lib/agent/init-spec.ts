/**
 * Init Agent Output Specification & Completeness Checker
 *
 * Defines the REQUIRED output for the Initialization Agent:
 * - Which Wiki pages MUST be generated
 * - Minimum Workspace effort requirements
 * - Content quality thresholds
 *
 * The completeness checker validates InitAgentResult against this spec
 * and returns a list of missing/insufficient items so the Agent can
 * re-generate them.
 */

import type { InitAgentResult } from "./init-types";
import { extractWorkspaceRefs } from "./ref-utils";

// ======================================================================
//  1. Required Wiki Page Specifications
// ======================================================================

export interface RequiredWikiPageSpec {
  /** Slug that the page MUST use */
  slug: string;
  /** Display title template — {title} is replaced by the problem title */
  titleTemplate: string;
  /** Instruction to the LLM for generating this page */
  instruction: string;
  /** Required content sections (headings that MUST appear) */
  requiredSections: string[];
  /** Whether this page is strictly required or recommended */
  priority: "required" | "recommended";
}

/**
 * The definitive list of Wiki pages that the Init Agent MUST generate.
 * Pages with priority "required" MUST exist in the output.
 * Pages with priority "recommended" should be generated if depth > "quick".
 */
export const REQUIRED_WIKI_PAGES: RequiredWikiPageSpec[] = [
  {
    slug: "overview",
    titleTemplate: "Overview — {title}",
    instruction:
      "Write a detailed overview structured as follows:\n" +
      "1. **Problem Statement**: The precise formal statement with ALL quantifiers and conditions in full LaTeX. Not a paraphrase — the actual conjecture/theorem.\n" +
      "2. **Historical Development**: A narrative tracing the problem from its origin to the present. For each major milestone: who, when, what they proved (precise statement), and how it changed the direction of research. Include the *motivations* — why was this problem posed? What broader question does it belong to?\n" +
      "3. **Relationship to the Broader Landscape**: How does this problem connect to other major conjectures/theories? What would a solution imply? What existing results does it depend on?\n" +
      "4. **Current State of the Art**: The best known results with exact bounds/constants in LaTeX. Who proved them, using what method?\n" +
      "5. **Proof Strategy Overview**: For solved problems, outline the proof architecture — the key reductions, the main technical ingredients, and how they fit together. For open problems, outline the most promising attack strategies and where they get stuck.",
    requiredSections: ["Problem Statement", "Historical Context", "Current Status"],
    priority: "required",
  },
  {
    slug: "key-results",
    titleTemplate: "Key Results & Timeline",
    instruction:
      "Create a detailed chronicle of results, ordered chronologically. For EACH milestone:\n" +
      "- **Precise theorem statement** in full LaTeX (all quantifiers, conditions, bounds)\n" +
      "- **Authors and year**\n" +
      "- **Proof technique**: not just the name, but a 2-3 sentence explanation of the key idea\n" +
      "- **Improvement over prior work**: what was the previous best result, and how does this improve it? Quantify the improvement.\n" +
      "- **Significance**: did this result introduce a new method? Settle a conjecture? Open a new direction?\n" +
      "Include ALL quantitative bounds where applicable. A reader should be able to trace the evolution of the best known constants/exponents through the timeline.",
    requiredSections: [],
    priority: "required",
  },
  {
    slug: "techniques",
    titleTemplate: "Technical Methods",
    instruction:
      "Provide a technical exposition of each major method. This page should read like the technical heart of a survey article. For EACH technique, include ALL of the following:\n\n" +
      "### Structure per technique:\n" +
      "1. **Mathematical Setup**: Define notation, spaces, objects. State the precise framework in which this technique operates. What are the inputs and outputs?\n" +
      "2. **Key Lemmas & Theorems**: State them with FULL LaTeX — all quantifiers, all conditions, all bounds. Not 'there exists a bound' but the actual bound.\n" +
      "3. **Proof Sketch**: Walk through the main argument in concrete steps. For each step: what tool is applied, to what object, producing what estimate? Include the key inequalities.\n" +
      "4. **Motivation — Why This Approach?**: What is the conceptual insight that makes this technique applicable? What analogy, structural observation, or failed attempt led to it? Who first had this idea, and in what context?\n" +
      "5. **Historical Evolution**: Trace the development from the original version to the current best form. Who refined it, when, and how? What were the key improvements?\n" +
      "6. **Limitations & Barriers**: Where precisely does this approach break down? State the exact quantitative boundary. What is the fundamental obstruction? Is it a parity problem, a convexity barrier, a square-root limit? Can the limitation be overcome, or is it inherent?\n" +
      "7. **Connections**: How does this technique relate to other methods on this page? Does it combine with them? Does it subsume earlier approaches?\n\n" +
      "Do NOT write vague summaries like 'X used deformation theory.' Write: 'X constructed a universal deformation ring $R$ parametrizing lifts of $\\bar{\\rho}: G_{\\mathbb{Q}} \\to GL_2(\\mathbb{F}_p)$ with specified local conditions at $p$ (ordinary/flat) and away from $p$ (minimally ramified), then proved $R \\cong T$ where $T$ is the relevant Hecke algebra, by...'",
    requiredSections: [],
    priority: "required",
  },
  {
    slug: "open-problems",
    titleTemplate: "Open Problems",
    instruction:
      "State each open problem with full mathematical precision. For EACH problem:\n" +
      "1. **Exact Conjecture Statement**: Full LaTeX with all quantifiers and conditions. If there are multiple formulations, state the strongest one.\n" +
      "2. **Partial Progress**: What is known? State the best partial results with precise bounds.\n" +
      "3. **Technical Barriers**: What specific obstruction prevents current methods from solving this? Be concrete — not 'current methods are insufficient' but 'the Selberg sieve gives an upper bound of $C_k = O(k^3 e^{8k})$ while the conjecture requires $C_k \\sim k \\log k$, and the parity barrier prevents sieve methods alone from achieving the correct order.'\n" +
      "4. **Possible Approaches**: What strategies might work? What new tools might be needed? What analogous problems have been solved, and could those methods transfer?\n" +
      "5. **Quantitative Targets**: If applicable, what are the specific numerical values that would constitute progress? (e.g., 'Improving the exponent from 1/2 to 1/2 + ε for any ε > 0 would break the convexity barrier.')",
    requiredSections: [],
    priority: "required",
  },
  {
    slug: "bibliography",
    titleTemplate: "Bibliography",
    instruction:
      "Compile a bibliography of primary references, foundational papers, and related work (300–600 words). " +
      "Use standard academic citation format. Group by: Primary Papers, Foundational References, Related Work. " +
      "Include arXiv IDs, DOIs, and journal references where available.",
    requiredSections: ["Primary Papers"],
    priority: "required",
  },
];

// ======================================================================
// 2. Required Workspace Effort Specifications
// ======================================================================

export interface WSRequirements {
  /** Minimum total workspace efforts */
  minTotalEfforts: number;
  /** Minimum number of non-REFERENCE items (i.e., actual mathematical content) */
  minContentItems: number;
  /** Minimum number of REFERENCE items */
  minReferenceItems: number;
  /** Maximum allowed items with empty description */
  maxEmptyDescriptions: number;
}

/**
 * Workspace effort requirements by search depth.
 */
export const WORKSPACE_REQUIREMENTS: Record<"quick" | "standard" | "deep", WSRequirements> = {
  quick: {
    minTotalEfforts: 3,
    minContentItems: 1,
    minReferenceItems: 2,
    maxEmptyDescriptions: 0,
  },
  standard: {
    minTotalEfforts: 6,
    minContentItems: 3,
    minReferenceItems: 3,
    maxEmptyDescriptions: 0,
  },
  deep: {
    minTotalEfforts: 10,
    minContentItems: 5,
    minReferenceItems: 5,
    maxEmptyDescriptions: 0,
  },
};

// ======================================================================
//  3. Content Quality Thresholds
// ======================================================================

export interface ContentQualitySpec {
  /** Minimum percentage of workspace efforts referenced in wiki via @ws: */
  minWorkspaceEffortCoverage: number;
  /** Maximum allowed broken @ws: references */
  maxBrokenRefs: number;
  /** Minimum number of LaTeX expressions ($..$ or $$..$$) in overview */
  minLatexExpressionsInOverview: number;
}

export const CONTENT_QUALITY: ContentQualitySpec = {
  minWorkspaceEffortCoverage: 0.3, // at least 30% of non-REFERENCE workspace efforts should be mentioned in wiki
  maxBrokenRefs: 2,
  minLatexExpressionsInOverview: 3,
};

// ======================================================================
//  4. Completeness Check Result
// ======================================================================

export interface CompletenessIssue {
  type: "missing_page" | "insufficient_content" | "missing_section" | "insufficient_ws" | "quality_issue";
  severity: "error" | "warning";
  /** Human-readable description */
  message: string;
  /** For missing_page: the page spec; for insufficient_content: the offending page */
  pageSpec?: RequiredWikiPageSpec;
  /** Actionable fix: what the Agent should do */
  fix: string;
}

export interface CompletenessCheckResult {
  /** Overall pass/fail (true = all required items present) */
  passed: boolean;
  /** Total issues found */
  totalIssues: number;
  /** Error-level issues (must fix) */
  errors: CompletenessIssue[];
  /** Warning-level issues (should fix) */
  warnings: CompletenessIssue[];
  /** Pages that need to be (re-)generated */
  pagesToGenerate: RequiredWikiPageSpec[];
  /** Summary string for logging */
  summary: string;
}

export interface CompletenessCheckOptions {
  /**
   * When true, PRD-level structural quality issues become errors instead of
   * warnings. Use this before persistence/rebuild apply so bad workspace
   * structure does not land silently.
   */
  strictQualityGate?: boolean;
}

// ======================================================================
//  5. The Checker
// ======================================================================

/**
 * Check the completeness of an InitAgentResult against the specification.
 *
 * @param result - The Init Agent output to validate
 * @param depth  - The search depth used (affects workspace requirements)
 * @returns A CompletenessCheckResult describing all issues found
 */
export function checkCompleteness(
  result: InitAgentResult,
  depth: "quick" | "standard" | "deep" = "standard",
  options: CompletenessCheckOptions = {},
): CompletenessCheckResult {
  const errors: CompletenessIssue[] = [];
  const warnings: CompletenessIssue[] = [];
  const pagesToGenerate: RequiredWikiPageSpec[] = [];
  const strictQualityGate = options.strictQualityGate ?? false;

  const addIssue = (
    issue: Omit<CompletenessIssue, "severity"> & { severity?: "error" | "warning" },
    hardInStrict = false,
  ) => {
    const severity = strictQualityGate && hardInStrict ? "error" : (issue.severity ?? "warning");
    const fullIssue: CompletenessIssue = { ...issue, severity };
    if (severity === "error") errors.push(fullIssue);
    else warnings.push(fullIssue);
  };

  const slugCounts = new Map<string, number>();
  for (const page of result.wikiPages) {
    slugCounts.set(page.slug, (slugCounts.get(page.slug) ?? 0) + 1);
  }
  const duplicateSlugs = [...slugCounts.entries()].filter(([, count]) => count > 1).map(([slug]) => slug);
  if (duplicateSlugs.length > 0) {
    addIssue({
      type: "quality_issue",
      message: `Duplicate Wiki page slugs in init result: ${duplicateSlugs.join(", ")}`,
      fix: `Deduplicate wiki pages by slug before applying init output`,
    }, true);
  }

  const titleCounts = new Map<string, number>();
  for (const effort of result.workspaceEfforts) {
    const normalized = effort.title.trim().replace(/\s+/g, " ").toLowerCase();
    if (!normalized) continue;
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
  }
  const duplicateTitles = [...titleCounts.entries()].filter(([, count]) => count > 1).map(([title]) => title);
  if (duplicateTitles.length > 0) {
    addIssue({
      type: "quality_issue",
      message: `Duplicate Workspace effort titles in init result: ${duplicateTitles.join(", ")}`,
      fix: `Merge duplicate efforts by normalized title and keep the richer item before persistence`,
    }, true);
  }

  // --- Check required wiki pages ---
  for (const spec of REQUIRED_WIKI_PAGES) {
    const page = result.wikiPages.find((p) => p.slug === spec.slug);

    if (!page) {
      // Page is missing
      const issue: CompletenessIssue = {
        type: "missing_page",
        severity: spec.priority === "required" ? "error" : "warning",
        message: `Missing Wiki page: ${spec.slug} (${spec.titleTemplate})`,
        pageSpec: spec,
        fix: `Generate Wiki page for slug="${spec.slug}"`,
      };
      if (spec.priority === "required") {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
      pagesToGenerate.push(spec);
      continue;
    }

    // Check required sections
    for (const section of spec.requiredSections) {
      if (!hasSection(page.content, section)) {
        warnings.push({
          type: "missing_section",
          severity: "warning",
          message: `Page "${spec.slug}" is missing required section: "${section}"`,
          pageSpec: spec,
          fix: `Add "${section}" section to page "${spec.slug}"`,
        });
      }
    }
  }

  // --- Check workspace requirements ---
  const wsReq = WORKSPACE_REQUIREMENTS[depth];
  const contentItems = result.workspaceEfforts.filter((i) => i.type !== "REFERENCE");
  const refItems = result.workspaceEfforts.filter((i) => i.type === "REFERENCE");

  if (result.workspaceEfforts.length < wsReq.minTotalEfforts) {
    errors.push({
      type: "insufficient_ws",
      severity: "error",
      message: `Insufficient Workspace efforts: ${result.workspaceEfforts.length} (minimum ${wsReq.minTotalEfforts})`,
      fix: `Generate more Workspace efforts (current ${result.workspaceEfforts.length}, required ${wsReq.minTotalEfforts})`,
    });
  }

  if (contentItems.length < wsReq.minContentItems) {
    warnings.push({
      type: "insufficient_ws",
      severity: "warning",
      message: `Insufficient math content items: ${contentItems.length} (minimum ${wsReq.minContentItems})`,
      fix: `Generate more CONSTRUCTION/ESTIMATE/PROOF_ATTEMPT type Workspace efforts`,
    });
  }

  if (refItems.length < wsReq.minReferenceItems) {
    warnings.push({
      type: "insufficient_ws",
      severity: "warning",
      message: `Insufficient reference items: ${refItems.length} (minimum ${wsReq.minReferenceItems})`,
      fix: `Generate more REFERENCE type Workspace efforts`,
    });
  }

  // Check for empty descriptions
  const emptyDescs = result.workspaceEfforts.filter((i) => !i.description || i.description.trim().length < 20);
  if (emptyDescs.length > wsReq.maxEmptyDescriptions) {
    addIssue({
      type: "quality_issue",
      message: `${emptyDescs.length} Workspace efforts have empty or too short descriptions`,
      fix: `Add meaningful descriptions to Workspace efforts (at least 20 characters)`,
    }, true);
  }

  const missingDocuments = contentItems.filter((i) => !i.document || i.document.trim().length < 500);
  if (missingDocuments.length > 0) {
    addIssue({
      type: "quality_issue",
      message: `${missingDocuments.length} non-reference Workspace efforts are missing substantial documents`,
      fix: `Generate rich effort documents before applying init output`,
    }, true);
  }

  const refsWithoutSources = refItems.filter((i) => !i.sources || i.sources.length === 0);
  if (refsWithoutSources.length > 0) {
    addIssue({
      type: "quality_issue",
      message: `${refsWithoutSources.length} REFERENCE efforts are missing structured source metadata`,
      fix: `Attach CrawledResource source metadata to every REFERENCE effort`,
    }, true);
  }

  const missingDifficulty = result.workspaceEfforts.filter((i) => !i.difficultyEstimate);
  if (missingDifficulty.length > 0) {
    addIssue({
      type: "quality_issue",
      message: `${missingDifficulty.length} Workspace efforts are missing difficulty estimates`,
      fix: `Set difficultyEstimate to ROUTINE, MODERATE, HARD, or VERY_HARD`,
    }, true);
  }

  const difficultyValues = new Set(result.workspaceEfforts.map((i) => i.difficultyEstimate).filter(Boolean));
  if (result.workspaceEfforts.length >= 10 && difficultyValues.size === 1) {
    warnings.push({
      type: "quality_issue",
      severity: "warning",
      message: `All Workspace efforts have the same difficulty estimate (${[...difficultyValues][0]})`,
      fix: `Derive effort-specific difficulty instead of relying on a single default`,
    });
  }

  const weakTags = result.workspaceEfforts.filter((i) => !hasTopicTag(i.tags));
  if (weakTags.length > 0) {
    addIssue({
      type: "quality_issue",
      severity: "warning",
      message: `${weakTags.length} Workspace efforts have missing or non-topic tags`,
      fix: `Generate mathematical topic tags rather than only authors, statuses, or spine structural labels`,
    });
  }

  const edgesWithoutDescriptions = result.dependencyEdges.filter((edge) => !edge.description || edge.description.trim().length === 0);
  if (edgesWithoutDescriptions.length > 0) {
    addIssue({
      type: "quality_issue",
      message: `${edgesWithoutDescriptions.length} dependency edges are missing descriptions`,
      fix: `Persist or regenerate relation descriptions explaining the mathematical dependency`,
    }, true);
  }

  // --- Check content quality ---
  const wsIds = new Set(result.workspaceEfforts.map((i) => i.id));
  let brokenRefs = 0;
  for (const page of result.wikiPages) {
    const refs = extractWorkspaceRefs(page.content);
    for (const refId of refs) {
      if (!wsIds.has(refId)) {
        brokenRefs++;
      }
    }
  }

  const maxBrokenRefs = strictQualityGate ? 0 : CONTENT_QUALITY.maxBrokenRefs;
  if (brokenRefs > maxBrokenRefs) {
    addIssue({
      type: "quality_issue",
      message: `Wiki has ${brokenRefs} broken references (@ws: referencing non-existent Workspace efforts)`,
      fix: `Fix broken references or remove invalid @ws: tags`,
    }, true);
  }

  // Check workspace effort coverage in wiki
  const referencedInWiki = new Set<string>();
  for (const page of result.wikiPages) {
    const refs = extractWorkspaceRefs(page.content);
    for (const refId of refs) {
      referencedInWiki.add(refId);
    }
  }

  if (contentItems.length > 0) {
    const coverage = contentItems.filter((i) => referencedInWiki.has(i.id)).length / contentItems.length;
    if (coverage < CONTENT_QUALITY.minWorkspaceEffortCoverage) {
      warnings.push({
        type: "quality_issue",
        severity: "warning",
        message: `Wiki coverage of Workspace content items is only ${Math.round(coverage * 100)}% (minimum ${Math.round(CONTENT_QUALITY.minWorkspaceEffortCoverage * 100)}%)`,
        fix: `Add more @ws:effort-id references in Wiki pages to cover Workspace efforts`,
      });
    }
  }

  // Check LaTeX in overview
  const overview = result.wikiPages.find((p) => p.slug === "overview");
  if (overview) {
    const latexCount = countLatexExpressions(overview.content);
    if (latexCount < CONTENT_QUALITY.minLatexExpressionsInOverview) {
      warnings.push({
        type: "quality_issue",
        severity: "warning",
        message: `Overview page has only ${latexCount} LaTeX expressions (minimum ${CONTENT_QUALITY.minLatexExpressionsInOverview})`,
        fix: `Add more math formulas to Overview (problem statement, key theorems, etc.)`,
      });
    }
  }

  // --- Build result ---
  const passed = errors.length === 0;
  const totalIssues = errors.length + warnings.length;

  const parts: string[] = [];
  if (passed) {
    parts.push("✅ Completeness check passed");
  } else {
    parts.push(`❌ Completeness check failed (${errors.length} errors)`);
  }
  if (warnings.length > 0) {
    parts.push(`⚠️ ${warnings.length} warnings`);
  }
  parts.push(`Wiki: ${result.wikiPages.length}/${REQUIRED_WIKI_PAGES.filter((s) => s.priority === "required").length} required pages`);
  parts.push(`Workspace: ${result.workspaceEfforts.length} items`);

  return {
    passed,
    totalIssues,
    errors,
    warnings,
    pagesToGenerate,
    summary: parts.join(" | "),
  };
}

// ======================================================================
//  Helpers
// ======================================================================

/** Check if markdown content has a heading matching the section name */
function hasSection(content: string, sectionName: string): boolean {
  const pattern = new RegExp(`^#{1,3}\\s+.*${escapeRegex(sectionName)}`, "im");
  return pattern.test(content);
}

/** Count LaTeX expressions in content */
function countLatexExpressions(content: string): number {
  const blockMath = content.match(/\$\$[\s\S]*?\$\$/g) ?? [];
  const inlineMath = content.match(/\$[^$]+\$/g) ?? [];
  const bracketMath = content.match(/\\\[[\s\S]*?\\\]/g) ?? [];
  const parenMath = content.match(/\\\([\s\S]*?\\\)/g) ?? [];
  return blockMath.length + inlineMath.length + bracketMath.length + parenMath.length;
}

const NON_TOPIC_TAGS = new Set([
  "active",
  "application",
  "background",
  "barrier",
  "bridge",
  "converged",
  "core-technique",
  "core_technique",
  "dead-end",
  "dead_end",
  "foundation",
  "generalization",
  "method-group",
  "method_group",
  "milestone",
  "open-direction",
  "open_direction",
  "reference",
  "reference-survey",
  "refinement",
  "stalled",
  "technique-origin",
  "technique_origin",
]);

function hasTopicTag(tags?: string[]): boolean {
  if (!tags || tags.length === 0) return false;
  return tags.some((tag) => {
    const trimmed = tag.trim();
    if (!trimmed) return false;
    const normalized = trimmed.toLowerCase().replace(/_/g, "-");
    if (NON_TOPIC_TAGS.has(normalized)) return false;
    if (/^[A-Z]\.\s*[A-Z][A-Za-z-]+/.test(trimmed)) return false;
    if (/^[A-Z][A-Za-z-]+(?:\s+[A-Z][A-Za-z-]+)+$/.test(trimmed)) return false;
    return normalized.length >= 3;
  });
}

/** Escape string for use in regex */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
