// IMPL [pworkspace-mvp] install_package — install a Python (pip) or system
// (apt) package into the user's persistent personal sandbox. Audited via the
// daemon; requires explicit user confirmation.

import type { ToolDefinition } from "./types";
import { getUserSandbox, touchSandbox } from "./sandbox-common";

// Reasonable belt-and-braces validation. The daemon performs the real check.
const PIP_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-+]*(\[[A-Za-z0-9_,\-]+\])?(==|>=|<=|~=|!=|>|<)?[A-Za-z0-9._\-+]*$/;
const APT_NAME = /^[a-z0-9][a-z0-9.+\-]+$/;

export const installPackageTool: ToolDefinition = {
  name: "install_package",
  description:
    "Install a package into your persistent personal sandbox. Use 'pip' for Python " +
    "packages (e.g. 'requests', 'numpy>=2'); use 'apt' for system packages " +
    "(e.g. 'graphviz'). Requires user confirmation. The install persists across " +
    "future tool calls until the sandbox is destroyed.",
  parameters: {
    type: "object",
    properties: {
      manager: {
        type: "string",
        enum: ["pip", "apt"],
        description: "Package manager: 'pip' for Python, 'apt' for system packages.",
      },
      name: {
        type: "string",
        description:
          "Package name (with optional pip version specifier, e.g. 'pandas>=2.0').",
      },
    },
    required: ["manager", "name"],
  },
  requiresConfirmation: true,
  // Installs can be slow (esp. apt). Give them headroom.
  timeoutMs: 120_000,
  async execute(args, ctx) {
    const manager = args.manager === "apt" ? "apt" : args.manager === "pip" ? "pip" : null;
    if (!manager) {
      return {
        success: false,
        data: null,
        displayText: "manager must be 'pip' or 'apt'.",
      };
    }
    const name = String(args.name ?? "").trim();
    if (!name) {
      return { success: false, data: null, displayText: "name is required." };
    }
    const re = manager === "pip" ? PIP_NAME : APT_NAME;
    if (!re.test(name)) {
      return {
        success: false,
        data: null,
        displayText: `Invalid ${manager} package name: ${name}`,
      };
    }

    let sandboxId: string;
    let daemon: Awaited<ReturnType<typeof getUserSandbox>>["daemon"];
    try {
      ({ sandboxId, daemon } = await getUserSandbox(ctx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: null, displayText: `Sandbox unavailable: ${msg}` };
    }

    try {
      const result = await daemon.installPackage(manager, name);
      void touchSandbox(sandboxId);
      return {
        success: result.ok && result.exitCode === 0,
        data: result,
        displayText: result.ok
          ? `Installed ${manager}:${name} (${result.durationMs}ms).`
          : `Install failed for ${manager}:${name} (exit ${result.exitCode}).`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { manager, name, error: msg },
        displayText: `Install failed for ${manager}:${name}: ${msg}`,
      };
    }
  },
};
