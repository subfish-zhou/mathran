/**
 * Public API of the user-distillation profile store. Pre-existing
 * mathran modules import from this index, not from `./store.js` or
 * `./schema.js` directly, so we can refactor internals freely.
 *
 * 2026-06-26 (user-distillation Phase 1).
 */

export {
  CitedPaperEntrySchema,
  OwnPaperEntrySchema,
  ProfileSnapshotSchema,
  ProjectProfileEntrySchema,
  ReactionEntrySchema,
} from "./schema.js";

export type {
  CitedPaperEntry,
  OwnPaperEntry,
  ProfileSnapshot,
  ProjectProfileEntry,
  ReactionEntry,
} from "./schema.js";

export {
  addCitedPaper,
  addOwnPaper,
  defaultProfileDir,
  readCitedPapers,
  readOwnPapers,
  readProjects,
  readReactions,
  readSnapshot,
  removeCitedPaper,
  removeOwnPaper,
  removeProject,
  upsertProject,
} from "./store.js";
