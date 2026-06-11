/**
 * Mathran — AI math prover agent core.
 *
 * Self-hosted, BYO Lean / LLM / DB. See packages/mathran-core/README.md for
 * design philosophy and v0.1 scope.
 *
 * This entry file will export the public surface as we migrate modules out
 * of the Mathub monorepo. Today (v0.0.0-pre) it exports only the abstract
 * provider interfaces that Mathub will start to implement.
 */

export type { LeanProvider, LeanCheckResult, LeanCheckRequest } from "./providers/lean";
export type { LLMProvider, LLMRequest, LLMResponse } from "./providers/llm";
export type { Storage } from "./providers/storage";
export type { ArtifactSink, PageInput, CommitInput, NotificationPayload, ActivityEntry } from "./providers/artifact-sink";
export type { IPrincipal, PrincipalKind } from "./principal";

export const MATHRAN_VERSION = "0.0.0-pre";
