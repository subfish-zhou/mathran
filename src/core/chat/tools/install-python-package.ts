/**
 * Built-in `install_python_package` tool (gap #4).
 *
 * Install a single pip package into the conversation's virtualenv (created
 * lazily if absent), recording it in the per-venv manifest so a later
 * `run_python` with the same `needs` skips the install. A focused companion to
 * `run_python` for when the model wants to provision a dependency up front.
 */

import type { ToolSpec, ToolExecuteContext } from "../session.js";
import {
  ensureVenv,
  runProc,
  readManifest,
  writeManifest,
} from "./python-venv.js";

export interface InstallPythonPackageToolOptions {
  workspace?: string;
  /** Conversation id this tool is bound to (injected by the session). */
  conversationId?: string;
  /** Output cap per stream in bytes (default 32 KiB). */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 32 * 1024;
const PIP_TIMEOUT_MS = 300_000;

export function createInstallPythonPackageTool(
  opts: InstallPythonPackageToolOptions = {},
): ToolSpec {
  const builderWorkspace = opts.workspace;
  const conversationId = opts.conversationId;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return {
    name: "install_python_package",
    riskClass: "exec",
    readOnly: false,
    description:
      "Install a pip package into this conversation's isolated virtualenv " +
      "(created lazily if needed). Subsequent run_python calls can import it. " +
      "Optionally pin an exact version.",
    parameters: {
      type: "object",
      properties: {
        package: {
          type: "string",
          description: "pip package name to install.",
        },
        version: {
          type: "string",
          description: "Optional exact version (installed as `<package>==<version>`).",
        },
      },
      required: ["package"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, ctx?: ToolExecuteContext) {
      const pkg = typeof args.package === "string" ? args.package.trim() : "";
      if (!pkg) {
        return {
          ok: false,
          content: "error: install_python_package requires 'package'",
        };
      }
      // 2026-06-25 audit I7 — reject pkg specs that start with `-` so the
      // model can't accidentally pass a pip flag (e.g. `--target=/etc/foo`,
      // `-r /etc/passwd`) where a package name was expected. URL specs
      // (git+https://, https://) and PEP 508 markers (name[extras]) are
      // still allowed because they don't start with `-`.
      if (pkg.startsWith("-")) {
        return {
          ok: false,
          content: "error: install_python_package 'package' must be a name or URL, not a pip flag",
        };
      }
      if (!conversationId) {
        return {
          ok: false,
          content: "error: install_python_package has no conversationId set",
        };
      }
      const workspace = builderWorkspace ?? ctx?.workspace;
      if (!workspace) {
        return {
          ok: false,
          content: "error: install_python_package has no workspace",
        };
      }
      const version =
        typeof args.version === "string" && args.version.trim() !== ""
          ? args.version.trim()
          : undefined;
      const spec = version ? `${pkg}==${version}` : pkg;

      let venv;
      try {
        venv = await ensureVenv(workspace, conversationId);
      } catch (err: any) {
        return {
          ok: false,
          content: `install_python_package error: ${err?.message ?? String(err)}`,
        };
      }

      const pip = await runProc(venv.pipBin, ["install", spec], {
        timeoutMs: PIP_TIMEOUT_MS,
        maxOutputBytes,
      });
      if (pip.spawnError) {
        return {
          ok: false,
          content: `install_python_package error: pip failed to spawn: ${pip.spawnError.message}`,
        };
      }
      if (pip.timedOut) {
        return {
          ok: false,
          content: `install_python_package: timed out installing ${spec}`,
        };
      }
      if (pip.exit !== 0) {
        return {
          ok: false,
          content:
            `install_python_package: pip install ${spec} failed (exit ${pip.exit})\n` +
            `${pip.stdout}\n${pip.stderr}`,
        };
      }

      const manifest = await readManifest(venv.manifestPath);
      manifest[pkg] = true;
      await writeManifest(venv.manifestPath, manifest);

      return {
        ok: true,
        content: `installed ${spec}\nlog:\n${pip.stdout}\n${pip.stderr}`,
      };
    },
  };
}
