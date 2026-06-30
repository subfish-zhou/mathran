/**
 * Sandbox module — barrel exports.
 *
 * Linux Sandbox v1 (Bubblewrap based). See `docs/sandbox.md` for the
 * profile matrix and opt-in instructions.
 *
 * Typical wiring:
 *
 *     import { spawnSandboxed, loadSandboxConfig } from "@/core/sandbox";
 *
 *     const { config } = loadSandboxConfig(settings.sandbox);
 *     const result = await spawnSandboxed({
 *       config,
 *       kind: "workspace-write",
 *       workspace,
 *       toolName: "bash",
 *       command: "bash",
 *       args: ["-lc", userCommand],
 *       spawnOpts: { timeoutMs, maxOutputBytes, cwd },
 *     });
 */

export {
  spawnSandboxed,
  resolveSandboxDecision,
  DEFAULT_SANDBOX_CONFIG,
} from "./wrapper.js";
export type { SpawnSandboxedInput } from "./wrapper.js";
export {
  detectSandboxCapabilities,
  whichSync,
  _resetSandboxDetectionCache,
  markFallbackWarned,
} from "./detect.js";
export {
  buildBwrapArgv,
  expandHome,
  systemReadOnlyBinds,
} from "./bwrap.js";
export type { BwrapArgvOpts, BwrapArgvResult } from "./bwrap.js";
export { loadSandboxConfig } from "./settings.js";
export type { LoadSandboxConfigResult } from "./settings.js";
export type {
  SandboxKind,
  SandboxConfig,
  SandboxRequest,
  SandboxResult,
  SandboxCapabilities,
  SandboxSpawnOptions,
} from "./types.js";
