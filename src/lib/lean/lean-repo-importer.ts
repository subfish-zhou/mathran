import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { eq } from "drizzle-orm";
import { workspaceEfforts, workspaceEffortFiles } from "@/server/db/schema";
import { parseLeanFile, parseLakefileVersion } from "./lean-declaration-parser";
import type { RepoImportResult, LakefileInfo, ParsedDeclaration } from "./lean-types";
import { resolveChildPath } from "@/lib/server-safe-paths";

const execFileAsync = promisify(execFile);

/** Validate git URL to prevent command injection */
function validateRepoUrl(url: string): boolean {
  return /^https:\/\/[^\s;|&]+$/.test(url) || /^git@[^\s;|&]+$/.test(url);
}

function validateBranch(branch: string): boolean {
  return /^[A-Za-z0-9._\-/]+$/.test(branch);
}

function validateProjectId(projectId: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(projectId);
}

async function findLeanFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".lake" || entry.name === "lake-packages" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findLeanFiles(full, base));
    } else if (entry.name.endsWith(".lean") && entry.name !== "lakefile.lean") {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

/**
 * Import a Lean repository as a single effort (or update an existing one).
 * 
 * The entire repo maps to ONE effort. Individual declarations (theorem/lemma/def)
 * are stored as effort files (workspace_effort_files), not as separate efforts.
 * Sorry count and verification status are aggregated at the effort level.
 */
 
export async function importLeanRepo(
  db: import("@/server/db").Database,
  projectId: string,
  userId: string,
  repoUrl: string,
  branch: string,
  options?: { effortId?: string; effortTitle?: string }
): Promise<RepoImportResult> {
  const result: RepoImportResult = {
    effortsCreated: 0,
    effortsUpdated: 0,
    relationsCreated: 0,
    declarationsParsed: 0,
    errors: [],
  };

  const workspaceRoot = path.resolve(process.env.HOME || "/home/azureuser", "lean-workspaces");

  // Validate inputs
  if (!validateRepoUrl(repoUrl)) {
    result.errors.push("Invalid repo URL format");
    return result;
  }
  if (!validateBranch(branch)) {
    result.errors.push("Invalid branch name");
    return result;
  }
  if (!validateProjectId(projectId)) {
    result.errors.push("Invalid project id");
    return result;
  }
  // P1-15: Recursive rm/clone target must stay below lean-workspaces.
  const repoDir = resolveChildPath(workspaceRoot, projectId, "repo");

  // Clone
  try {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", "--branch", branch, repoUrl, repoDir], { timeout: 120000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Clone failed: ${msg}`);
    return result;
  }

  // Parse lakefile / lean-toolchain
  const lakefileInfo: LakefileInfo = {};
  try {
    const toolchain = await fs.readFile(path.join(repoDir, "lean-toolchain"), "utf-8").catch(() => "");
    if (toolchain) {
      const m = toolchain.match(/leanprover\/lean4:v?([\d.]+)/);
      if (m) lakefileInfo.leanVersion = m[1];
    }
    const toml = await fs.readFile(path.join(repoDir, "lakefile.toml"), "utf-8").catch(() => "");
    if (toml) {
      const revMatch = toml.match(/name\s*=\s*"mathlib"[\s\S]*?rev\s*=\s*"([^"]+)"/);
      if (revMatch) lakefileInfo.mathlibVersion = revMatch[1];
    }
    if (!lakefileInfo.mathlibVersion) {
      const lakefile = await fs.readFile(path.join(repoDir, "lakefile.lean"), "utf-8").catch(() => "");
      if (lakefile) {
        const info = parseLakefileVersion(lakefile);
        if (info.mathlibVersion) lakefileInfo.mathlibVersion = info.mathlibVersion;
        if (!lakefileInfo.leanVersion && info.leanVersion) lakefileInfo.leanVersion = info.leanVersion;
      }
    }
  } catch { /* ignore */ }
  result.lakefileInfo = lakefileInfo;

  // Find and parse all .lean files
  const leanFiles = await findLeanFiles(repoDir, repoDir);
  const allDeclarations: ParsedDeclaration[] = [];
  const fileContents = new Map<string, string>();

  for (const relPath of leanFiles) {
    try {
      const content = await fs.readFile(path.join(repoDir, relPath), "utf-8");
      fileContents.set(relPath, content);
      const decls = parseLeanFile(content, relPath);
      allDeclarations.push(...decls);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Parse error ${relPath}: ${msg}`);
    }
  }
  result.declarationsParsed = allDeclarations.length;

  // Aggregate stats
  const totalSorry = allDeclarations.reduce((sum, d) => sum + d.sorryCount, 0);
  const hasAnySorry = totalSorry > 0;
  const totalTheorems = allDeclarations.filter(d => d.kind === "theorem" || d.kind === "lemma").length;
  const totalDefs = allDeclarations.filter(d => d.kind === "def" || d.kind === "abbrev" || d.kind === "structure" || d.kind === "class" || d.kind === "instance").length;
  const sorryDecls = allDeclarations.filter(d => d.hasSorry);

  // Build summary for effort document
  const repoName = repoUrl.replace(/\.git$/, "").split("/").pop() || "repo";
  const summaryLines: string[] = [
    `## Lean Formalization: ${repoName}`,
    "",
    `- **Repository**: ${repoUrl}`,
    `- **Branch**: ${branch}`,
    lakefileInfo.leanVersion ? `- **Lean version**: ${lakefileInfo.leanVersion}` : "",
    lakefileInfo.mathlibVersion ? `- **Mathlib version**: ${lakefileInfo.mathlibVersion}` : "",
    `- **Files**: ${leanFiles.length}`,
    `- **Declarations**: ${allDeclarations.length} (${totalTheorems} theorems/lemmas, ${totalDefs} definitions)`,
    `- **Sorry count**: ${totalSorry}`,
    "",
  ];

  if (sorryDecls.length > 0) {
    summaryLines.push("### Declarations with sorry");
    summaryLines.push("");
    for (const d of sorryDecls) {
      summaryLines.push(`- \`${d.name}\` (${d.file}:${d.line}) — ${d.sorryCount} sorry`);
    }
    summaryLines.push("");
  }

  // Build formal statement as combined Lean4 signatures of key theorems
  const keyTheorems = allDeclarations
    .filter(d => d.kind === "theorem" && !d.hasSorry)
    .slice(0, 20); // Top 20 key theorems
  const formalStatement = keyTheorems.length > 0
    ? keyTheorems.map(d => `-- ${d.file}:${d.line}\n${d.kind} ${d.signature}`).join("\n\n")
    : null;

  const document = summaryLines.filter(Boolean).join("\n");

  // DB writes in transaction
  try {
    await db.transaction(async (tx) => {
      let effortId = options?.effortId;

      if (effortId) {
        // Update existing effort
        await tx
          .update(workspaceEfforts)
          .set({
            formalStatement,
            leanFilePath: repoUrl,
            statementStatus: formalStatement ? "FORMALIZED" : "NOT_READY",
            proofStatus: hasAnySorry ? "HAS_SORRY" : (formalStatement ? "FORMALIZED" : "NOT_READY"),
            sorryCount: totalSorry,
            verificationStatus: hasAnySorry ? "SORRY" : (formalStatement ? "VERIFIED" : "UNFORMALIZED"),
            document,
            structuredContent: { declarations: allDeclarations },
            updatedAt: new Date(),
          })
          .where(eq(workspaceEfforts.id, effortId));
        result.effortsUpdated = 1;
      } else {
        // Create new effort
        const title = options?.effortTitle || `Formalization: ${repoName}`;
        const [created] = await tx
          .insert(workspaceEfforts)
          .values({
            projectId,
            type: "FORMALIZATION",
            title,
            description: `Lean4 formalization imported from ${repoUrl} (branch: ${branch})`,
            formalStatement,
            leanFilePath: repoUrl,
            statementStatus: formalStatement ? "FORMALIZED" as const : "NOT_READY" as const,
            proofStatus: hasAnySorry ? "HAS_SORRY" as const : (formalStatement ? "FORMALIZED" as const : "NOT_READY" as const),
            inMathlib: false,
            sorryCount: totalSorry,
            verificationStatus: hasAnySorry ? "SORRY" : (formalStatement ? "VERIFIED" : "UNFORMALIZED"),
            status: "ACTIVE",
            authorId: userId,
            document,
            structuredContent: { declarations: allDeclarations },
          })
          .returning({ id: workspaceEfforts.id });
        effortId = (created as { id: string }).id;
        result.effortsCreated = 1;
      }

      // Store each .lean file as an effort file
      if (effortId) {
        // Delete old imported files for this effort
        await tx
          .delete(workspaceEffortFiles)
          .where(eq(workspaceEffortFiles.effortId, effortId));

        // Insert .lean files as effort files (batch, chunks of 50)
        const fileRows = leanFiles.map(relPath => ({
          effortId: effortId!,
          name: path.basename(relPath),
          path: relPath,
          type: "lean" as const,
          content: fileContents.get(relPath) ?? null,
        }));

        for (let i = 0; i < fileRows.length; i += 50) {
          const chunk = fileRows.slice(i, i + 50);
          await tx.insert(workspaceEffortFiles).values(chunk);
        }
      }
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`DB error: ${msg}`);
  }

  return result;
}
