/**
 * Spine-First Architecture — Barrel Export
 *
 * The unified pipeline: Explore → Spine → Efforts → Wiki
 * Used by both Init Agent (full mode) and Patrol Agent (incremental mode).
 */

export * from "./types";
export { explorePaperGraph, upsertPaperNode, ingestSeedPapers } from "./explore-pipeline";
export { buildSpine } from "./spine-builder";
export { diffSpine, isEmptyDiff } from "./spine-diff";
export { generateEffortsFromSpine } from "./effort-from-spine";
export { generateWikiFromSpine, patchWikiFromSpineDiff } from "./wiki-from-spine";
export { runSpinePatrol } from "./patrol-spine";
