// IMPL [pworkspace-mvp] delete_workspace_file — remove a file from the user's
// persistent personal sandbox. Marked requiresConfirmation: true.

import type { ToolDefinition } from "./types";
import { getUserSandbox, touchSandbox } from "./sandbox-common";

const ALLOWED_PREFIXES = ["/workspace/", "/memory/", "/tmp/"];

function normalizePath(p: string): string {
  let path = p.trim();
  if (!path.startsWith("/")) path = `/workspace/${path}`;
  if (path.includes("..")) throw new Error("Path traversal ('..') is not allowed.");
  if (!ALLOWED_PREFIXES.some((pre) => path.startsWith(pre))) {
    throw new Error(
      `Path must start with one of: ${ALLOWED_PREFIXES.join(", ")}.`,
    );
  }
  // Be extra paranoid: refuse to delete the workspace root itself.
  for (const pre of ALLOWED_PREFIXES) {
    if (path === pre || path === pre.slice(0, -1)) {
      throw new Error("Refusing to delete a workspace root directory.");
    }
  }
  return path;
}

export const deleteWorkspaceFileTool: ToolDefinition = {
  name: "delete_workspace_file",
  description:
    "Delete a file from your persistent personal sandbox. This action is destructive " +
    "and requires explicit user confirmation. Allowed roots: /workspace, /memory, /tmp.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path inside the sandbox (e.g. '/workspace/old-notes.md') or a " +
          "name relative to /workspace.",
      },
    },
    required: ["path"],
  },
  requiresConfirmation: true,
  async execute(args, ctx) {
    let path: string;
    try {
      path = normalizePath(String(args.path ?? ""));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "invalid path";
      return { success: false, data: null, displayText: msg };
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
      await daemon.deleteFile(path);
      void touchSandbox(sandboxId);
      return {
        success: true,
        data: { path, deleted: true },
        displayText: `Deleted ${path}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { path, error: msg },
        displayText: `Failed to delete ${path}: ${msg}`,
      };
    }
  },
};
