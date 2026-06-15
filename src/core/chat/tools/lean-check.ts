/**
 * lean_check — the kernel's built-in Lean tool.
 *
 * Takes Lean 4 source from the model, writes it to a temp file, runs it through
 * a `LeanProvider`, and reports ok/messages back to the conversation. The
 * provider is injected so tests can supply a fake and `serve` can share one.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { LeanProvider } from "../../providers/lean.js";
import type { ToolSpec } from "../session.js";

export interface LeanCheckToolOptions {
  /** Directory for temp .lean files; defaults to the OS temp dir. */
  tmpDir?: string;
  /** Per-check timeout in ms. */
  timeoutMs?: number;
}

const PARAMETERS = {
  type: "object",
  properties: {
    leanSource: {
      type: "string",
      description: "Complete Lean 4 source to type-check.",
    },
  },
  required: ["leanSource"],
  additionalProperties: false,
} as const;

/** Build a `lean_check` ToolSpec bound to a concrete LeanProvider. */
export function createLeanCheckTool(
  lean: LeanProvider,
  opts: LeanCheckToolOptions = {},
): ToolSpec {
  return {
    name: "lean_check",
    description:
      "Type-check a complete Lean 4 source snippet with the local Lean toolchain. " +
      "Returns whether it compiles plus any error/warning messages.",
    parameters: PARAMETERS as unknown as Record<string, unknown>,
    async execute(args: Record<string, unknown>) {
      const leanSource = typeof args.leanSource === "string" ? args.leanSource : "";
      if (leanSource.trim().length === 0) {
        return { ok: false, content: 'error: missing required argument "leanSource"' };
      }

      const dir = await fs.mkdtemp(
        path.join(opts.tmpDir ?? os.tmpdir(), "mathran-leancheck-"),
      );
      const file = path.join(dir, "snippet.lean");
      try {
        await fs.writeFile(file, leanSource, "utf-8");
        const result = await lean.check({
          filePath: file,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });

        if (result.ok) {
          return {
            ok: true,
            content: `lean_check: OK (compiled cleanly${
              result.durationMs !== undefined ? ` in ${result.durationMs}ms` : ""
            })`,
          };
        }

        const lines = result.messages.map((m) => {
          const loc =
            m.line !== undefined
              ? `:${m.line}${m.column !== undefined ? `:${m.column}` : ""}`
              : "";
          return `[${m.severity}${loc}] ${m.message}`;
        });
        return {
          ok: false,
          content: `lean_check: FAILED\n${lines.join("\n") || "(no messages)"}`,
        };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
