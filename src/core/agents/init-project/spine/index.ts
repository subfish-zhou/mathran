/**
 * Spine-First Architecture — Barrel Export (fs port).
 *
 * Pipeline: Explore → Spine → Efforts → Wiki.
 */

export * from "./types.js";
export * from "./llm.js";
export {
  buildSpine,
  writeSpine,
  readSpine,
  spineFile,
  spineDir,
  createEmptySpine,
  dedupeSpineNodesByTitle,
  normalizeSpineNodeTitle,
} from "./builder.js";
export { diffSpine, isEmptyDiff } from "./diff.js";
