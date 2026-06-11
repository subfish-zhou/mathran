import { exec, execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { parseLeanOutput, countSorriesInSource } from "./lean-parser";
import {
  generateLeanFile,
  computeLeanFilePath,
  generateLakefile,
  generateToolchain,
  slugToPascal,
} from "./lean-file-generator";
import type {
  LeanCheckResult,
  SyncResult,
  ProjectLeanStatus,
  LeanWorkspaceState,
  EffortForLean,
  EffortWithRelations,
} from "./lean-types";
import { resolveChildPath } from "@/lib/server-safe-paths";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const SAFE_PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

// In-memory state tracking for workspace initialization
const workspaceStates = new Map<string, LeanWorkspaceState>();

export class LeanService {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? path.join(process.env.HOME ?? "/home/azureuser", "lean-workspaces");
  }

  private projectDir(projectSlug: string): string {
    if (!SAFE_PROJECT_SLUG.test(projectSlug)) {
      throw new Error("Invalid Lean project slug");
    }
    // P1-15: Canonicalize every project workspace under the configured root.
    return resolveChildPath(this.basePath, projectSlug);
  }

  private async leanAvailable(): Promise<boolean> {
    try {
      await execAsync("which lean");
      return true;
    } catch {
      return false;
    }
  }

  private async lakeAvailable(): Promise<boolean> {
    try {
      await execAsync("which lake");
      return true;
    } catch {
      return false;
    }
  }

  private ensureLeanTools(): void {
    // This is checked at call sites using leanAvailable/lakeAvailable
  }

  /**
   * Initialize a Lean workspace for a project.
   */
  async initWorkspace(projectSlug: string): Promise<{ status: string; message: string }> {
    if (!(await this.lakeAvailable())) {
      return { status: "error", message: "Lean4 not installed: `lake` not found in PATH" };
    }

    const dir = this.projectDir(projectSlug);
    workspaceStates.set(projectSlug, "INITIALIZING");

    try {
      // Create directory structure
      const pascalName = slugToPascal(projectSlug);
      await fs.mkdir(resolveChildPath(dir, "Mathub", pascalName), { recursive: true });

      // Write lakefile.lean
      await fs.writeFile(resolveChildPath(dir, "lakefile.lean"), generateLakefile(projectSlug));

      // Write lean-toolchain
      await fs.writeFile(resolveChildPath(dir, "lean-toolchain"), generateToolchain());

      // Run lake update (this downloads mathlib, can take a long time)
      await execAsync("lake update", {
        cwd: dir,
        timeout: 30 * 60 * 1000, // 30 minutes
        env: { ...process.env, PATH: process.env.PATH },
      });

      workspaceStates.set(projectSlug, "READY");
      return { status: "ready", message: "Lean workspace initialized successfully" };
    } catch (error) {
      workspaceStates.set(projectSlug, "ERROR");
      const msg = error instanceof Error ? error.message : String(error);
      return { status: "error", message: `Initialization failed: ${msg}` };
    }
  }

  /**
   * Write/update a lean file for an effort.
   */
  async writeEffortFile(
    projectSlug: string,
    effort: EffortForLean,
    dependencies: Array<{ id: string; title: string; leanFilePath: string | null }>
  ): Promise<string> {
    const dir = this.projectDir(projectSlug);
    const filePath = computeLeanFilePath(projectSlug, effort);
    const fullPath = resolveChildPath(dir, filePath);

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const content = generateLeanFile(projectSlug, effort, dependencies);
    await fs.writeFile(fullPath, content, "utf-8");

    return filePath;
  }

  /**
   * Run lean check on a project or specific file.
   */
  async check(projectSlug: string, filePath?: string): Promise<LeanCheckResult> {
    if (!(await this.lakeAvailable())) {
      return {
        success: false,
        errors: [{ file: "", line: 0, column: 0, severity: "error", message: "Lean4 not installed" }],
        warnings: [],
        sorryCount: 0,
        buildDurationMs: 0,
      };
    }

    const dir = this.projectDir(projectSlug);
    const start = Date.now();

    try {
      const args = filePath
        ? ["env", "lean", path.relative(dir, resolveChildPath(dir, filePath))]
        : ["build"];

      workspaceStates.set(projectSlug, "BUILDING");
      const { stdout, stderr } = await execFileAsync("lake", args, {
        cwd: dir,
        timeout: 10 * 60 * 1000,
        env: { ...process.env, PATH: process.env.PATH },
      });

      const output = stdout + "\n" + stderr;
      const result = parseLeanOutput(output);
      workspaceStates.set(projectSlug, "READY");

      return {
        success: result.errors.length === 0,
        errors: result.errors,
        warnings: result.warnings,
        sorryCount: result.sorryCount,
        buildDurationMs: Date.now() - start,
      };
    } catch (error) {
      workspaceStates.set(projectSlug, "READY");
      const msg = error instanceof Error ? (error as { stderr?: string }).stderr ?? error.message : String(error);
      const result = parseLeanOutput(msg);

      return {
        success: false,
        errors: result.errors.length > 0
          ? result.errors
          : [{ file: "", line: 0, column: 0, severity: "error", message: msg.slice(0, 2000) }],
        warnings: result.warnings,
        sorryCount: result.sorryCount,
        buildDurationMs: Date.now() - start,
      };
    }
  }

  /**
   * Check a code snippet by writing it to a scratch file.
   */
  async checkSnippet(
    projectSlug: string,
    snippet: string,
    imports?: string[]
  ): Promise<LeanCheckResult> {
    const dir = this.projectDir(projectSlug);
    const scratchPath = resolveChildPath(dir, "Mathub", "_Scratch.lean");

    let content = "";
    if (imports) {
      content += imports.map((i) => `import ${i}`).join("\n") + "\n\n";
    }
    content += snippet;

    try {
      await fs.mkdir(path.dirname(scratchPath), { recursive: true });
      await fs.writeFile(scratchPath, content, "utf-8");
      const result = await this.check(projectSlug, "Mathub/_Scratch.lean");
      return result;
    } finally {
      try {
        await fs.unlink(scratchPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /**
   * Sync all efforts with formal statements to lean files.
   */
  async syncAll(
    projectSlug: string,
    efforts: EffortWithRelations[]
  ): Promise<SyncResult> {
    const result: SyncResult = { filesWritten: 0, filesDeleted: 0, errors: [] };

    for (const effort of efforts) {
      if (!effort.formalStatement) continue;
      try {
        await this.writeEffortFile(projectSlug, effort, effort.dependencies);
        result.filesWritten++;
      } catch (error) {
        result.errors.push(
          `Failed to write ${effort.title}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return result;
  }

  /**
   * Get project lean workspace status.
   */
  async getStatus(projectSlug: string): Promise<ProjectLeanStatus> {
    const dir = this.projectDir(projectSlug);
    let state: LeanWorkspaceState = workspaceStates.get(projectSlug) ?? "NOT_INITIALIZED";

    // Check if workspace exists on disk
    try {
      await fs.access(resolveChildPath(dir, "lakefile.lean"));
      if (state === "NOT_INITIALIZED") {
        state = "READY";
        workspaceStates.set(projectSlug, state);
      }
    } catch {
      state = "NOT_INITIALIZED";
    }

    let leanVersion: string | undefined;
    try {
      const { stdout } = await execAsync("lean --version");
      const match = stdout.match(/lean \(version ([^)]+)\)/i) ?? stdout.match(/([\d.]+)/);
      leanVersion = match?.[1];
    } catch {
      // lean not installed
    }

    return {
      state,
      leanVersion,
      totalEfforts: 0, // Caller should fill from DB
      formalizedEfforts: 0,
      verifiedEfforts: 0,
      totalSorryCount: 0,
    };
  }

  /**
   * Count sorries by scanning .lean files (fast, no compilation).
   */
  async countSorries(projectSlug: string): Promise<number> {
    const dir = this.projectDir(projectSlug);
    let total = 0;

    try {
      const mathubDir = resolveChildPath(dir, "Mathub");
      const files = await this.findLeanFiles(mathubDir);
      for (const file of files) {
        const content = await fs.readFile(file, "utf-8");
        total += countSorriesInSource(content);
      }
    } catch {
      // directory doesn't exist yet
    }

    return total;
  }

  private async findLeanFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...(await this.findLeanFiles(fullPath)));
        } else if (entry.name.endsWith(".lean") && !entry.name.startsWith("_")) {
          results.push(fullPath);
        }
      }
    } catch {
      // ignore
    }
    return results;
  }
}

// Singleton
let _instance: LeanService | undefined;
export function getLeanService(): LeanService {
  if (!_instance) {
    _instance = new LeanService();
  }
  return _instance;
}
