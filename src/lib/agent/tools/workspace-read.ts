// IMPL [pworkspace-mvp] read_workspace_file — read a file from the user's
// persistent personal sandbox workspace via the daemon.

import type { ToolDefinition } from "./types";
import { getUserSandbox, touchSandbox } from "./sandbox-common";

const MAX_BYTES = 1024 * 1024; // 1 MB cap returned to the LLM
const ALLOWED_PREFIXES = ["/workspace/", "/memory/", "/tmp/"];

function normalizePath(p: string): string {
  let path = p.trim();
  if (!path.startsWith("/")) path = `/workspace/${path}`;
  // Disallow traversal — daemon should re-check, but fail fast here.
  if (path.includes("..")) throw new Error("Path traversal ('..') is not allowed.");
  if (!ALLOWED_PREFIXES.some((pre) => path.startsWith(pre))) {
    throw new Error(
      `Path must start with one of: ${ALLOWED_PREFIXES.join(", ")}.`,
    );
  }
  return path;
}

export const readWorkspaceFileTool: ToolDefinition = {
  name: "read_workspace_file",
  description:
    "Read a file from your persistent personal sandbox. Default root is /workspace; " +
    "you may also read from /memory or /tmp. Returns up to 1 MB of UTF-8 content. " +
    "Use list_workspace first if you don't know the path.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path inside the sandbox (e.g. '/workspace/notes.md') or a name " +
          "relative to /workspace (e.g. 'notes.md').",
      },
    },
    required: ["path"],
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
      const result = await daemon.readFile(path);
      void touchSandbox(sandboxId);
      let content = result.content;
      let truncated = false;
      const byteLen = Buffer.byteLength(content, "utf8");
      if (byteLen > MAX_BYTES) {
        // Return a UTF-8-safe prefix.
        content = Buffer.from(content, "utf8").subarray(0, MAX_BYTES).toString("utf8");
        truncated = true;
      }
      return {
        success: true,
        data: { path, content, bytes: result.bytes, truncated },
        displayText: truncated
          ? `Read ${path} (${result.bytes} bytes, truncated to ${MAX_BYTES}).`
          : `Read ${path} (${result.bytes} bytes).`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { path, error: msg },
        displayText: `Failed to read ${path}: ${msg}`,
      };
    }
  },
};
