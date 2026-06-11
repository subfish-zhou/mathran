// IMPL [pworkspace-mvp] write_workspace_file — create or overwrite a file in
// the user's persistent personal sandbox workspace via the daemon.

import type { ToolDefinition } from "./types";
import { getUserSandbox, touchSandbox } from "./sandbox-common";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB write cap per call
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
  return path;
}

export const writeWorkspaceFileTool: ToolDefinition = {
  name: "write_workspace_file",
  description:
    "Create or overwrite a file in your persistent personal sandbox. Default root " +
    "is /workspace; /memory and /tmp are also writable. Max 2 MB per call. " +
    "Parent directories are created automatically by the daemon.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path inside the sandbox (e.g. '/workspace/notes.md') or a name " +
          "relative to /workspace (e.g. 'notes.md').",
      },
      content: {
        type: "string",
        description: "UTF-8 text content to write. Stringify JSON if structured.",
      },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    let path: string;
    try {
      path = normalizePath(String(args.path ?? ""));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "invalid path";
      return { success: false, data: null, displayText: msg };
    }
    const content = String(args.content ?? "");
    const byteLen = Buffer.byteLength(content, "utf8");
    if (byteLen > MAX_BYTES) {
      return {
        success: false,
        data: null,
        displayText: `Content exceeds ${MAX_BYTES} bytes (${byteLen}).`,
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
      const result = await daemon.writeFile(path, content);
      void touchSandbox(sandboxId);
      return {
        success: true,
        data: { path, bytes: result.bytes },
        displayText: `Wrote ${path} (${result.bytes} bytes).`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: { path, error: msg },
        displayText: `Failed to write ${path}: ${msg}`,
      };
    }
  },
};
