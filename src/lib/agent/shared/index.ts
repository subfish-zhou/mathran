/**
 * Shared modules for init-agent and patrol-agent pipelines.
 *
 * Re-exports all shared building blocks so consumers can import from
 * `@/lib/agent/shared` or `../shared`.
 */

// Crawl pipeline
export {
  runDeepCrawl,
  generateNextRoundQueries,
  searchArxiv,
  fetchWikipediaSummary,
  sleep,
  ARXIV_RATE_DELAY,
  type DeepCrawlConfig,
  type DeepCrawlResult,
} from "./crawl-pipeline";

// Build efforts
export {
  buildEffortsFromResources,
  type BuildEffortsConfig,
  type BuildEffortsResult,
} from "./build-efforts";

// Wiki generation
export {
  generateWikiContent,
  mergeWikiContent,
  updateWikiIncremental,
  type WikiGeneratorConfig,
  type WikiGeneratorResult,
  type WikiIncrementalConfig,
  type WikiIncrementalResult,
} from "./wiki-generator";

// Wiki Patrol v2 — Extract → Match → Patch
export {
  extractKnowledgeItems,
  matchKnowledgeToPlacements,
  patchWikiSections,
  classifyDiscoveriesToEfforts,
  type KnowledgeItem,
  type PlacementDecision,
  type WikiPatch,
  type ExtractConfig,
  type MatchConfig,
  type PatchConfig,
  type ClassifyEffortsConfig,
  type ClassifyEffortsResult,
} from "./wiki-patrol-v2";

// Review & verify
export {
  reviewAndRefinePages,
  verifyContent,
  type ReviewConfig,
  type ReviewResult,
  type VerifyConfig,
  type VerifyResult,
} from "./review-verify";
