/**
 * Permission Profiles (#2) — public barrel.
 */

export type {
  ProfileDefinition,
  ProfileEffects,
} from "./types.js";
export {
  BUILTIN_PROFILES,
  BUILTIN_PROFILE_NAMES,
} from "./builtin-profiles.js";
export {
  ProfileDefinitionSchema,
  type ParsedProfileDefinition,
} from "./schema.js";
export {
  UnknownProfileError,
  loadProfileDefinition,
  resolveProfileEffects,
  resolveProfile,
  readSettingsDefaultProfile,
  listAvailableProfiles,
  isMutatingCall,
  isReadOnlyShellCommand,
  matchAutoApprovePattern,
  type ProfileResolveOpts,
  type AvailableProfile,
} from "./profile-resolver.js";
export { buildProfileBanner } from "./profile-message.js";
