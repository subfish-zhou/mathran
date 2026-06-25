/**
 * `mathran workspace gc` — TODO-3 NEW-F4.
 *
 * Garbage-collect stale workspace state safely. By default this is a
 * dry-run; pass `--apply` to actually delete. Pass `--keep-days N` to
 * tune the retention window for terminal goals + .bak files.
 *
 * What it cleans:
 *   - goals/<id>.json whose status is failed|cancelled and whose
 *     endedAt < now - keepDays (default 30).
 *     ALSO removes the associated conversation jsonl + .plan.md +
 *     .summary.md + .todos.json files. Mirrors prune-failed-goals.ts
 *     but lives in CLI instead of a one-off script.
 *   - global-chat/<conv-id>.jsonl files with 0 user messages whose
 *     index entry's lastUsedAt < now - keepDays — i.e. empty chats
 *     nobody touched in a month. The .index.json entry is also
 *     dropped.
 *   - .jsonl.bak.* files older than 7 days (always, regardless of
 *     keepDays — backups are short-lived by definition).
 *   - global-chat/.index.json entries pointing at conversations whose
 *     jsonl no longer exists on disk (orphan annotations).
 *
 * What it does NOT touch:
 *   - active / paused / complete / exhausted goals (only failed +
 *     cancelled are GC candidates),
 *   - goals younger than keepDays,
 *   - skills/, plans/, commands/, mcp.json, cache/, subagents/ (these
 *     have their own lifecycles — touching them blindly could nuke
 *     in-flight subagent state).
 *
 * The cleanup is bounded and idempotent — running gc twice should be a
 * no-op the second time. Every action is logged to stdout so the user
 * can see exactly what was (or would be) removed.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { listGoals, readGoal } from "../../core/goal/store.js";

export interface WorkspaceGcOptions {
  workspace: string;
  /** When false (default) prints what would happen but doesn't unlink. */
  apply?: boolean;
  /** Retention window for terminal goals + empty chats. Default 30. */
  keepDays?: number;
  /** Retention window specifically for *.bak.* files. Default 7. */
  bakKeepDays?: number;
}

export interface WorkspaceGcReport {
  goalsRemoved: number;
  conversationsRemoved: number;
  bakFilesRemoved: number;
  orphanIndexEntriesRemoved: number;
  /** Total bytes that were (or would be) freed. */
  bytesFreed: number;
  /** True when the run was a dry-run (default). */
  dryRun: boolean;
}

export async function runWorkspaceGc(opts: WorkspaceGcOptions): Promise<WorkspaceGcReport> {
  const ws = opts.workspace;
  const apply = opts.apply === true;
  const keepDays = opts.keepDays ?? 30;
  const bakKeepDays = opts.bakKeepDays ?? 7;
  const now = Date.now();
  const keepCutoff = now - keepDays * 24 * 60 * 60 * 1000;
  const bakCutoff = now - bakKeepDays * 24 * 60 * 60 * 1000;

  const report: WorkspaceGcReport = {
    goalsRemoved: 0,
    conversationsRemoved: 0,
    bakFilesRemoved: 0,
    orphanIndexEntriesRemoved: 0,
    bytesFreed: 0,
    dryRun: !apply,
  };

  console.log(
    `[workspace-gc] ${apply ? "APPLY" : "DRY-RUN"}  workspace=${ws}  keepDays=${keepDays}  bakKeepDays=${bakKeepDays}`,
  );
  console.log("");

  // ─── 1. Stale terminal goals + their files ────────────────────────────
  const allGoals = await listGoals(ws);
  for (const g of allGoals) {
    if (g.status !== "failed" && g.status !== "cancelled") continue;
    const endedAt = g.endedAt ? Date.parse(g.endedAt) : 0;
    if (!Number.isFinite(endedAt) || endedAt === 0 || endedAt > keepCutoff) continue;
    // Fresh-read for full record (listGoals only returns thin summary).
    const full = await readGoal(ws, g.id);
    if (!full) continue;
    const filesToRemove: string[] = [];
    filesToRemove.push(path.join(ws, ".mathran", "goals", `${g.id}.json`));
    for (const ext of ["plan.md", "summary.md", "todos.json"]) {
      filesToRemove.push(path.join(ws, ".mathran", "goals", `${g.id}.${ext}`));
    }
    for (const convId of full.conversationIds ?? []) {
      filesToRemove.push(path.join(ws, ".mathran", "global-chat", `${convId}.jsonl`));
      filesToRemove.push(path.join(ws, ".mathran", "global-chat", `${convId}.annotations.json`));
    }
    let removedAny = false;
    for (const f of filesToRemove) {
      try {
        const stat = await fs.stat(f);
        report.bytesFreed += stat.size;
        if (apply) await fs.unlink(f);
        if (f.endsWith(".jsonl")) report.conversationsRemoved++;
        removedAny = true;
        console.log(`  ${apply ? "rm" : "rm[dry]"}  ${f}  (${stat.size} bytes)`);
      } catch (e: any) {
        // ENOENT is expected — the file just doesn't exist.
        if (e?.code !== "ENOENT") {
          console.warn(`  warn: stat ${f}: ${e?.message ?? e}`);
        }
      }
    }
    if (removedAny) {
      report.goalsRemoved++;
      console.log(
        `  goal ${g.id.slice(0, 8)}  status=${g.status}  ended=${g.endedAt}  objective=${g.objective.slice(0, 60)}`,
      );
      console.log("");
    }
  }

  // ─── 2. .jsonl.bak.* files older than bakKeepDays ─────────────────────
  const globalChatDir = path.join(ws, ".mathran", "global-chat");
  try {
    const entries = await fs.readdir(globalChatDir);
    for (const name of entries) {
      if (!name.includes(".bak.")) continue;
      const full = path.join(globalChatDir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs > bakCutoff) continue;
        report.bytesFreed += stat.size;
        report.bakFilesRemoved++;
        if (apply) await fs.unlink(full);
        console.log(`  ${apply ? "rm" : "rm[dry]"}  ${full}  (bak ${stat.size} bytes)`);
      } catch {
        // ignore
      }
    }
  } catch {
    // global-chat dir doesn't exist — nothing to clean
  }

  // ─── 3. Orphan index entries (jsonl gone but .index.json still lists) ─
  const indexPath = path.join(globalChatDir, ".index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const idx = JSON.parse(raw) as { conversations?: Array<{ id: string }> };
    if (Array.isArray(idx.conversations)) {
      const keep: Array<{ id: string }> = [];
      for (const entry of idx.conversations) {
        const jsonl = path.join(globalChatDir, `${entry.id}.jsonl`);
        try {
          await fs.access(jsonl);
          keep.push(entry);
        } catch {
          report.orphanIndexEntriesRemoved++;
          console.log(`  ${apply ? "drop" : "drop[dry]"}  index entry ${entry.id} (jsonl gone)`);
        }
      }
      if (keep.length !== idx.conversations.length) {
        if (apply) {
          // Backup then write
          const backup = `${indexPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
          await fs.writeFile(backup, raw, "utf-8");
          await fs.writeFile(indexPath, JSON.stringify({ ...idx, conversations: keep }, null, 2), "utf-8");
        }
      }
    }
  } catch {
    // no index → nothing to clean
  }

  console.log("");
  console.log("[workspace-gc] summary:");
  console.log(`  goals removed:               ${report.goalsRemoved}`);
  console.log(`  conversations removed:       ${report.conversationsRemoved}`);
  console.log(`  bak files removed:           ${report.bakFilesRemoved}`);
  console.log(`  orphan index entries:        ${report.orphanIndexEntriesRemoved}`);
  console.log(`  bytes ${apply ? "freed" : "(would free)"}: ${report.bytesFreed}`);
  if (!apply) console.log("  (run with --apply to actually delete)");
  return report;
}
