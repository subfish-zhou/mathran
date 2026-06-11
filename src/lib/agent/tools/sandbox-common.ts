// IMPL [pworkspace-mvp] sandbox-common — routes execution + helper accessors
// to UserSandboxManager + DaemonClient. Reconstructed after a 3-worker
// concurrent-edit race accidentally reverted Worker B's rewrite.
//
// Contract (mirrored in _sandbox-shims.d.ts and consumed by workspace-* tools):
//   - getUserSandbox(ctx) → { sandboxId, daemon }
//   - touchSandbox(sandboxId) → updates last_activity_at (best effort)
//   - createSandboxTool(language, description) → ToolDefinition
//
// Worker A's UserSandboxManager.getOrProvision(userId) returns { id, daemon }.

import type { ToolDefinition, ToolContext } from "./types";
import { UserSandboxManager } from "@/lib/sandbox/user-sandbox-manager";
import type { DaemonClient } from "@/lib/sandbox/daemon-client";
import { checkCodeSafety, checkRateLimit } from "@/lib/sandbox/security";

type SandboxLanguage = "python" | "sage";

const DISPLAY_NAMES: Record<SandboxLanguage, string> = {
  python: "Python",
  sage: "SageMath",
};

const CODE_DESCRIPTIONS: Record<SandboxLanguage, string> = {
  python: "Python code to execute",
  sage: "SageMath code to execute",
};

// Singleton accessor — delegates to UserSandboxManager.shared() so that every
// caller (chat-handler, upload/file routes, idle-reaper cron) uses ONE manager
// instance and ONE daemon-client cache. Previously this kept its own _manager,
// creating a second singleton divergent from .shared() — fixed 2026-06-03.
export function getManager(): UserSandboxManager {
  return UserSandboxManager.shared();
}

/**
 * Resolve (or lazily provision) the calling user's persistent sandbox and
 * return both its id and a ready DaemonClient. Callers should `void
 * touchSandbox(sandboxId)` after a successful operation.
 */
export async function getUserSandbox(
  ctx: ToolContext,
): Promise<{ sandboxId: string; daemon: DaemonClient }> {
  if (!ctx.userId) throw new Error("Sandbox requires an authenticated user.");
  const handle = await getManager().getOrProvision(ctx.userId);
  return { sandboxId: handle.id, daemon: handle.daemon };
}

/** Best-effort activity bump; failures are swallowed. */
export async function touchSandbox(sandboxId: string): Promise<void> {
  try {
    await getManager().touch(sandboxId);
  } catch {
    /* non-fatal */
  }
}

export function createSandboxTool(
  language: SandboxLanguage,
  description: string,
): ToolDefinition {
  const displayName = DISPLAY_NAMES[language];

  const properties: Record<string, unknown> = {
    code: {
      type: "string",
      description: CODE_DESCRIPTIONS[language],
    },
  };

  if (language === "python") {
    properties.packages = {
      type: "array",
      items: { type: "string" },
      description:
        "Package names used (informational only; install via install_package if missing)",
    };
  }

  return {
    name: `run_${language}`,
    description,
    parameters: {
      type: "object",
      properties,
      required: ["code"],
    },
    requiresConfirmation: false,
    async execute(args, ctx) {
      const code = String(args.code);

      const safety = checkCodeSafety(code);
      if (!safety.allowed) {
        return {
          success: false,
          data: null,
          displayText: `Code rejected: ${safety.reason}`,
        };
      }

      const rateLimit = await checkRateLimit(ctx.userId);
      if (!rateLimit.allowed) {
        return { success: false, data: null, displayText: rateLimit.reason! };
      }

      let sandboxId: string;
      let daemon: DaemonClient;
      try {
        ({ sandboxId, daemon } = await getUserSandbox(ctx));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          data: null,
          displayText: `Sandbox unavailable: ${msg}`,
        };
      }

      try {
        const result = await daemon.execute({ language, code });
        void touchSandbox(sandboxId);
        return {
          success: result.exitCode === 0 && !result.timedOut,
          data: {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            executionTimeMs: result.executionTimeMs,
            outputFiles: result.outputFiles,
          },
          displayText: result.timedOut
            ? "Execution timed out"
            : result.exitCode === 0
              ? `${displayName} executed successfully (${result.executionTimeMs}ms)`
              : `${displayName} execution failed (exit code ${result.exitCode})`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          data: null,
          displayText: `${displayName} execution failed: ${msg}`,
        };
      }
    },
  };
}
