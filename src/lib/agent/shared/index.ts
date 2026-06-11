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
// TODO(mathran-v0.1): export {
// TODO(mathran-v0.1):   generateWikiContent,
// TODO(mathran-v0.1):   mergeWikiContent,
// TODO(mathran-v0.1):   updateWikiIncremental,
// TODO(mathran-v0.1):   type WikiGeneratorConfig,
// TODO(mathran-v0.1):   type WikiGeneratorResult,
// TODO(mathran-v0.1):   type WikiIncrementalConfig,
// TODO(mathran-v0.1):   type WikiIncrementalResult,
// TODO(mathran-v0.1): } from "./wiki-generator";

// Wiki Patrol v2 — Extract → Match → Patch
// TODO(mathran-v0.1): export {
// TODO(mathran-v0.1):   extractKnowledgeItems,
// TODO(mathran-v0.1):   matchKnowledgeToPlacements,
// TODO(mathran-v0.1):   patchWikiSections,
// TODO(mathran-v0.1):   classifyDiscoveriesToEfforts,
// TODO(mathran-v0.1):   type KnowledgeItem,
// TODO(mathran-v0.1):   type PlacementDecision,
// TODO(mathran-v0.1):   type WikiPatch,
// TODO(mathran-v0.1):   type ExtractConfig,
// TODO(mathran-v0.1):   type MatchConfig,
// TODO(mathran-v0.1):   type PatchConfig,
// TODO(mathran-v0.1):   type ClassifyEffortsConfig,
// TODO(mathran-v0.1):   type ClassifyEffortsResult,
// TODO(mathran-v0.1): } from "./wiki-patrol-v2";

// Review & verify
export {
  reviewAndRefinePages,
  verifyContent,
  type ReviewConfig,
  type ReviewResult,
  type VerifyConfig,
  type VerifyResult,
} from "./review-verify";
