#!/usr/bin/env node
/**
 * prune-failed-goals.ts — TODO-3 / data-cleanup-1.
 *
 * Mathran's goal-mode creates a chat-conversation per goal. Failed
 * goals (status: failed | cancelled | exhausted with no real work
 * preserved) and their associated conversations pile up in
 * .mathran/global-chat/ and clutter the SPA "Recent" rail.
 *
 * This script:
 *   1. Walks every goal record under .mathran/goals/<id>.json.
 *   2. Identifies goals with status in {failed, cancelled, exhausted}
 *      AND tools-touched == 0 (test goals that never produced real
 *      work) OR an --include-large flag to ALSO include large failed
 *      goals (those that did real work but ended in failure).
 *   3. For each such goal, plans deletion of:
 *        - .mathran/goals/<goalId>.json
 *        - .mathran/goals/<goalId>.summary.md (if exists)
 *        - .mathran/goals/<goalId>.plan.md (if exists)
 *      AND for each conversationId on the goal:
 *        - .mathran/<scope>-chat/<convId>.jsonl
 *        - .mathran/<scope>-chat/<convId>.jsonl.bak.* (any backups)
 *        - .mathran/<scope>-chat/<convId>.todos.json
 *        - the conversation's entry in .mathran/<scope>-chat/.index.json
 *
 * Dry-run by default. Pass --apply to actually delete.
 *
 * Backs up .mathran/global-chat/.index.json before mutating.
 *
 * Usage:
 *   tsx scripts/prune-failed-goals.ts --workspace ~/mathran-workspace
 *   tsx scripts/prune-failed-goals.ts --workspace ~/mathran-workspace --apply
 *   tsx scripts/prune-failed-goals.ts --workspace ~/mathran-workspace --include-large --apply
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

type GoalStatus = "active" | "paused" | "complete" | "failed" | "cancelled" | "exhausted" | "stalled";

interface GoalRecord {
  id: string;
  objective: string;
  status: GoalStatus;
  scope: { kind: "global" | "project" | "effort"; projectSlug?: string; effortSlug?: string };
  conversationIds: string[];
  stats: { toolCallCount?: number; iterationsRun?: number; tokensUsed?: number };
  endReason?: string | null;
}

interface PrunePlanItem {
  goalId: string;
  status: GoalStatus;
  scope: GoalRecord["scope"];
  reason: string;
  objectivePreview: string;
  filesToDelete: string[];
  conversationsToDelete: string[];
}

function parseArgs(argv: string[]): { workspace: string; apply: boolean; includeLarge: boolean } {
  let workspace = "";
  let apply = false;
  let includeLarge = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--include-large") includeLarge = true;
    else if (a === "--workspace") workspace = argv[++i] ?? "";
    else if (a.startsWith("--workspace=")) workspace = a.slice("--workspace=".length);
    else if (a === "-h" || a === "--help") {
      console.log("usage: prune-failed-goals.ts --workspace <path> [--apply] [--include-large]");
      process.exit(0);
    }
  }
  if (!workspace) {
    console.error("error: --workspace is required");
    process.exit(2);
  }
  return { workspace: path.resolve(workspace.replace(/^~/, process.env.HOME ?? "")), apply, includeLarge };
}

function scopeChatDir(workspace: string, scope: GoalRecord["scope"]): string {
  if (scope.kind === "global") return path.join(workspace, ".mathran", "global-chat");
  if (scope.kind === "project")
    return path.join(workspace, "projects", scope.projectSlug ?? "_", ".mathran", "chat");
  return path.join(
    workspace,
    "projects",
    scope.projectSlug ?? "_",
    "efforts",
    scope.effortSlug ?? "_",
    ".mathran",
    "chat",
  );
}

async function listGoalFiles(workspace: string): Promise<string[]> {
  const dir = path.join(workspace, ".mathran", "goals");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".json") && !e.endsWith(".bak.json"))
    .map((e) => path.join(dir, e));
}

async function readGoal(file: string): Promise<GoalRecord | null> {
  try {
    const text = await fs.readFile(file, "utf-8");
    return JSON.parse(text) as GoalRecord;
  } catch {
    return null;
  }
}

async function buildPrunePlan(
  workspace: string,
  includeLarge: boolean,
): Promise<PrunePlanItem[]> {
  const files = await listGoalFiles(workspace);
  const plan: PrunePlanItem[] = [];

  for (const file of files) {
    const g = await readGoal(file);
    if (!g) continue;

    // Only prune goals in terminal failure states.
    const isFailed =
      g.status === "failed" || g.status === "cancelled" || g.status === "exhausted";
    if (!isFailed) continue;

    const toolCount = g.stats?.toolCallCount ?? 0;
    const iterationsRun = g.stats?.iterationsRun ?? 0;

    // Skip "large failed" goals (real work happened) unless --include-large.
    const isLarge = toolCount > 5 || iterationsRun > 3;
    if (isLarge && !includeLarge) continue;

    const reason =
      g.objective?.toLowerCase().includes("test")
        ? `status=${g.status} (literal 'test' in objective)`
        : `status=${g.status}, tools=${toolCount}, iter=${iterationsRun}`;

    const filesToDelete: string[] = [file];
    for (const ext of [".summary.md", ".plan.md"]) {
      const sib = file.replace(/\.json$/, ext);
      try {
        await fs.access(sib);
        filesToDelete.push(sib);
      } catch {}
    }

    const conversationsToDelete: string[] = [];
    for (const convId of g.conversationIds ?? []) {
      const dir = scopeChatDir(workspace, g.scope);
      const jsonl = path.join(dir, `${convId}.jsonl`);
      const todos = path.join(dir, `${convId}.todos.json`);
      try {
        await fs.access(jsonl);
        conversationsToDelete.push(jsonl);
      } catch {}
      try {
        await fs.access(todos);
        conversationsToDelete.push(todos);
      } catch {}
      // Backups: <convId>.jsonl.bak.<timestamp>
      try {
        const entries = await fs.readdir(dir);
        for (const e of entries) {
          if (e.startsWith(`${convId}.jsonl.bak.`)) {
            conversationsToDelete.push(path.join(dir, e));
          }
        }
      } catch {}
    }

    plan.push({
      goalId: g.id,
      status: g.status,
      scope: g.scope,
      reason,
      objectivePreview: (g.objective ?? "").slice(0, 80),
      filesToDelete,
      conversationsToDelete,
    });
  }

  return plan;
}

interface IndexFile {
  conversations: Record<string, { id: string; title: string; createdAt: string; lastUsedAt: string; messageCount: number }>;
}

async function readIndex(file: string): Promise<IndexFile | null> {
  try {
    const t = await fs.readFile(file, "utf-8");
    return JSON.parse(t) as IndexFile;
  } catch {
    return null;
  }
}

async function applyPlan(workspace: string, plan: PrunePlanItem[]): Promise<void> {
  // Group convIds by scope so we touch each index file once.
  const indexByScope = new Map<string, { file: string; convIds: Set<string> }>();
  for (const item of plan) {
    const dir = scopeChatDir(workspace, item.scope);
    const indexFile = path.join(dir, ".index.json");
    if (!indexByScope.has(indexFile)) {
      indexByScope.set(indexFile, { file: indexFile, convIds: new Set() });
    }
    for (const conv of item.conversationsToDelete) {
      const m = path.basename(conv).match(/^([^.]+)\./);
      if (m) indexByScope.get(indexFile)!.convIds.add(m[1]);
    }
  }

  // 1. Update each .index.json (backup first).
  for (const { file: indexFile, convIds } of indexByScope.values()) {
    const idx = await readIndex(indexFile);
    if (!idx) continue;
    const backup = `${indexFile}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(indexFile, backup);
    let removed = 0;
    for (const convId of convIds) {
      if (idx.conversations[convId]) {
        delete idx.conversations[convId];
        removed++;
      }
    }
    await fs.writeFile(indexFile, JSON.stringify(idx, null, 2) + "\n", "utf-8");
    console.log(`  ✓ ${path.relative(workspace, indexFile)}: removed ${removed} entries (backup at ${path.basename(backup)})`);
  }

  // 2. Delete files.
  let deletedFiles = 0;
  for (const item of plan) {
    for (const f of [...item.filesToDelete, ...item.conversationsToDelete]) {
      try {
        await fs.unlink(f);
        deletedFiles++;
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== "ENOENT") {
          console.warn(`  ! failed to unlink ${f}: ${(err as Error).message}`);
        }
      }
    }
  }
  console.log(`  ✓ deleted ${deletedFiles} file(s) total`);
}

async function main(): Promise<void> {
  const { workspace, apply, includeLarge } = parseArgs(process.argv.slice(2));
  console.log(`prune-failed-goals: workspace=${workspace} apply=${apply} includeLarge=${includeLarge}`);

  const plan = await buildPrunePlan(workspace, includeLarge);
  if (plan.length === 0) {
    console.log("nothing to prune ✓");
    return;
  }

  console.log(`\n${plan.length} goal(s) would be pruned:\n`);
  for (const item of plan) {
    console.log(`  goal ${item.goalId} [${item.status}] ${item.scope.kind}`);
    console.log(`    reason: ${item.reason}`);
    console.log(`    objective: ${JSON.stringify(item.objectivePreview)}`);
    console.log(`    goal files (${item.filesToDelete.length}):`);
    for (const f of item.filesToDelete) console.log(`      - ${path.relative(workspace, f)}`);
    console.log(`    conv files (${item.conversationsToDelete.length}):`);
    for (const f of item.conversationsToDelete) console.log(`      - ${path.relative(workspace, f)}`);
    console.log();
  }

  if (!apply) {
    console.log("(dry-run — rerun with --apply to actually delete; --include-large to ALSO prune failed goals with substantial work)");
    process.exit(plan.length === 0 ? 0 : 1);
  }

  console.log("=== APPLYING ===\n");
  await applyPlan(workspace, plan);
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(`fatal: ${err?.message ?? err}`);
  process.exit(2);
});
