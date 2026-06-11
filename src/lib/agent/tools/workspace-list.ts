// IMPL [pworkspace-mvp] list_workspace — directory listing inside the user's
// persistent personal sandbox.

import type { ToolDefinition } from "./types";
import { getUserSandbox, touchSandbox } from "./sandbox-common";

const ALLOWED_PREFIXES = ["/workspace", "/memory", "/tmp"];
const MAX_ENTRIES = 500;

function normalizePath(p: string): string {
  let path = (p ?? "").trim() || "/workspace";
  if (!path.startsWith("/")) path = `/workspace/${path}`;
  if (path.includes("..")) throw new Error("Path traversal ('..') is not allowed.");
  if (!ALLOWED_PREFIXES.some((pre) => path === pre || path.startsWith(`${pre}/`))) {
    throw new Error(
      `Path must be under one of: ${ALLOWED_PREFIXES.join(", ")}.`,
    );
  }
  // strip trailing slash except for root
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

export const listWorkspaceTool: ToolDefinition = {
  name: "list_workspace",
  description:
    "List files and subdirectories inside your persistent personal sandbox. " +
    "Defaults to /workspace. Returns up to 500 entries with name, type, and size.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute directory path inside the sandbox (default '/workspace'). " +
          "Allowed roots: /workspace, /memory, /tmp.",
      },
    },
  },
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
      const entries = await daemon.listDir(path);
      void touchSandbox(sandboxId);
      const trimmed = entries.slice(0, MAX_ENTRIES);
      return {
        success: true,
        data: {
          path,
          entries: trimmed,
          count: trimmed.length,
          truncated: entries.length > MAX_ENTRIES,
        },
        displayText:
          entries.length > MAX_ENTRIES
            ? `Listed ${MAX_ENTRIES} of ${entries.length} entries in ${path} (truncated).`
            : `Listed ${entries.length} entries in ${path}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { path, error: msg },
        displayText: `Failed to list ${path}: ${msg}`,
      };
    }
  },
};
