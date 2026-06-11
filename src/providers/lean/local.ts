/**
 * LocalLeanProvider — shells out to the user's local elan/lake/lean.
 *
 * The provider runs `lake env lean <file>` for project-aware checks, falling
 * back to bare `lean <file>` for standalone files. Output (stderr + stdout) is
 * parsed for `<file>:<line>:<col>: error|warning|info: <message>` lines per
 * the standard Lean 4 message format.
 *
 * Path conventions:
 *   - Absolute paths only
 *   - If the file lives inside a directory with `lakefile.lean` (walking up),
 *     `lake env lean <file>` runs from that lake root so imports resolve.
 *   - Otherwise bare `lean <file>` runs from `dirname(file)`.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  LeanProvider,
  LeanCheckRequest,
  LeanCheckResult,
} from "../../core/providers/lean.js";

export interface LocalLeanProviderOptions {
  /** Override path to `lean`; defaults to `lean` on PATH. */
  leanBin?: string;
  /** Override path to `lake`; defaults to `lake` on PATH. */
  lakeBin?: string;
  /** Default check timeout in ms; can be overridden per-request. */
  defaultTimeoutMs?: number;
}

const LEAN_MESSAGE_RE =
  /^(?<file>.+?):(?<line>\d+):(?<col>\d+):\s+(?<severity>error|warning|info):\s+(?<message>.*)$/;

async function findLakeRoot(filePath: string): Promise<string | null> {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 32; i++) {
    try {
      await fs.access(path.join(dir, "lakefile.lean"));
      return dir;
    } catch {
      /* not here */
    }
    try {
      await fs.access(path.join(dir, "lakefile.toml"));
      return dir;
    } catch {
      /* not here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      resolve({ code: -1, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        stderr += "\n[lean timeout: process killed]";
      }
      resolve({ code, stdout, stderr });
    });
  });
}

export class LocalLeanProvider implements LeanProvider {
  private readonly leanBin: string;
  private readonly lakeBin: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: LocalLeanProviderOptions = {}) {
    this.leanBin = opts.leanBin ?? "lean";
    this.lakeBin = opts.lakeBin ?? "lake";
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
  }

  async describe(): Promise<{ name: string; version?: string; toolchain?: string }> {
    const r = await runProcess(this.leanBin, ["--version"], { cwd: process.cwd(), timeoutMs: 5_000 });
    const versionLine = r.stdout.split("\n")[0]?.trim() || r.stderr.split("\n")[0]?.trim() || "unknown";
    return { name: "local-lean", version: versionLine, toolchain: "elan" };
  }

  async check(req: LeanCheckRequest): Promise<LeanCheckResult> {
    const startedAt = Date.now();

    // Resolve file to absolute, normalize
    const filePath = path.isAbsolute(req.filePath)
      ? req.filePath
      : path.resolve(req.filePath);

    // Ensure file exists
    try {
      await fs.access(filePath);
    } catch {
      return {
        ok: false,
        messages: [
          {
            severity: "error",
            message: `lean source not found: ${filePath}`,
          },
        ],
        durationMs: Date.now() - startedAt,
      };
    }

    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const lakeRoot = await findLakeRoot(filePath);
    const cwd = req.cwd ?? lakeRoot ?? path.dirname(filePath);

    let proc: SpawnResult;
    if (lakeRoot) {
      // Run inside the lake project so imports resolve.
      proc = await runProcess(this.lakeBin, ["env", "lean", filePath], { cwd, timeoutMs });
    } else {
      proc = await runProcess(this.leanBin, [filePath], { cwd, timeoutMs });
    }

    // Lean prints diagnostics to stderr (typically) — parse both streams.
    const combined = `${proc.stdout}\n${proc.stderr}`;
    const messages: LeanCheckResult["messages"] = [];
    for (const line of combined.split("\n")) {
      const m = LEAN_MESSAGE_RE.exec(line);
      if (m && m.groups) {
        messages.push({
          severity: m.groups.severity as "error" | "warning" | "info",
          message: m.groups.message,
          line: parseInt(m.groups.line, 10),
          column: parseInt(m.groups.col, 10),
        });
      }
    }

    // Compiler succeeds iff exit code 0 AND no error-severity messages.
    const hasError = messages.some((m) => m.severity === "error");
    const ok = proc.code === 0 && !hasError;

    // If non-zero exit but no parsed messages, surface the raw stderr so
    // callers don't get a silent failure.
    if (!ok && messages.length === 0 && (proc.stderr.trim() || proc.code !== 0)) {
      messages.push({
        severity: "error",
        message:
          proc.stderr.trim() ||
          `lean exited with code ${proc.code} and no parseable output`,
      });
    }

    return {
      ok,
      messages,
      durationMs: Date.now() - startedAt,
    };
  }
}

// CLI smoke-test: `tsx src/providers/lean/local.ts <file>`
const moduleUrl = import.meta.url;
const invokedAsScript = process.argv[1] && fileURLToPath(moduleUrl) === path.resolve(process.argv[1]);
if (invokedAsScript) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx src/providers/lean/local.ts <leanfile>");
    process.exit(2);
  }
  const provider = new LocalLeanProvider();
  provider.describe().then((d) => {
    console.error(`[describe] ${JSON.stringify(d)}`);
    return provider.check({ filePath: file });
  }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}
