/** Public re-exports for the hypothesis-spine module (Layer 3). */

export * from "./types.js";
export {
  buildHypothesisSpine,
  reconcileSpines,
  type BuildHypothesisSpineDeps,
  type BuildHypothesisSpineInput,
  type ReconcileSpinesInput,
} from "./builder.js";
export {
  buildHypothesisSpinePrompt,
  parseAndValidateHypothesisSpine,
  type BuildHypothesisSpinePromptInput,
} from "./prompts.js";
