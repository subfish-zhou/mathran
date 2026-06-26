/**
 * Public API of the user-distillation profile store. Pre-existing
 * mathran modules import from this index, not from `./store.js` or
 * `./schema.js` directly, so we can refactor internals freely.
 *
 * 2026-06-26 (user-distillation Phase 1).
 */

export {
  CitedPaperEntrySchema,
  DisagreedEntrySchema,
  InferenceCandidateSchema,
  InferenceEvidenceSchema,
  InferenceKindSchema,
  InferenceRunMetaSchema,
  InferredEntrySchema,
  OwnPaperEntrySchema,
  ProfileSnapshotSchema,
  ProjectProfileEntrySchema,
  ReactionEntrySchema,
} from "./schema.js";

export type {
  CitedPaperEntry,
  DisagreedEntry,
  DisagreedEntryInput,
  InferenceCandidate,
  InferenceCandidateInput,
  InferenceEvidence,
  InferenceKind,
  InferenceRunMeta,
  InferredEntry,
  InferredEntryInput,
  OwnPaperEntry,
  ProfileSnapshot,
  ProjectProfileEntry,
  ReactionEntry,
} from "./schema.js";

export {
  addCitedPaper,
  addDisagreed,
  addInferred,
  addOwnPaper,
  addPendingCandidates,
  appendInferenceRun,
  approveCandidate,
  defaultProfileDir,
  readActiveInferred,
  readCitedPapers,
  readDisagreed,
  readInferenceRuns,
  readInferred,
  readOwnPapers,
  readPendingCandidates,
  readProjects,
  readReactions,
  readSnapshot,
  rejectCandidate,
  removeCitedPaper,
  removeInferred,
  removeOwnPaper,
  removeProject,
  upsertProject,
} from "./store.js";
