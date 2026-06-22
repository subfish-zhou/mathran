/**
 * Hook execution history (in-memory ring + optional JSONL append).
 *
 * Powers `/hooks list` (per-hook trigger counts + last outcome) and
 * `/hooks log <name>` (the last few executions of a named hook). The in-memory
 * ring is the source of truth for the live session; the JSONL file (when a path
 * is configured) is a best-effort audit trail that survives restarts.
 *
 * Stored stdout/stderr is capped to a small preview here — the full (already
 * 100 KB-capped) output lives in the {@link HookExecutionResult} the executor
 * returns; history keeps just enough to render a log line.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HookType } from "./loader.js";
import type { LayerName } from "../skills/loader.js";

/** A single recorded hook execution. */
export interface HookExecutionRecord {
  name: string;
  type: HookType;
  layer: LayerName;
  exitCode: number;
  blocked: boolean;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  /** Epoch ms when the execution finished. */
  at: number;
  /** Short preview of stdout (capped). */
  stdoutPreview?: string;
  /** Short preview of stderr (capped). */
  stderrPreview?: string;
}

const PREVIEW_CAP = 2_000;
const DEFAULT_MAX_IN_MEMORY = 500;

export interface HookHistoryOptions {
  /** Max records kept in memory (ring buffer). Default 500. */
  maxInMemory?: number;
  /** Absolute path to a JSONL audit file. When set, records are appended. */
  jsonlPath?: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

function preview(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s.length > PREVIEW_CAP ? `${s.slice(0, PREVIEW_CAP)}…` : s;
}

export class HookHistory {
  private readonly records: HookExecutionRecord[] = [];
  private readonly maxInMemory: number;
  private readonly jsonlPath?: string;
  private readonly now: () => number;

  constructor(opts: HookHistoryOptions = {}) {
    this.maxInMemory = opts.maxInMemory ?? DEFAULT_MAX_IN_MEMORY;
    this.jsonlPath = opts.jsonlPath;
    this.now = opts.now ?? Date.now;
  }

  /** Record one execution. `at` is filled from the clock when omitted. */
  record(
    rec: Omit<HookExecutionRecord, "at" | "stdoutPreview" | "stderrPreview"> & {
      at?: number;
      stdout?: string;
      stderr?: string;
    },
  ): HookExecutionRecord {
    const full: HookExecutionRecord = {
      name: rec.name,
      type: rec.type,
      layer: rec.layer,
      exitCode: rec.exitCode,
      blocked: rec.blocked,
      timedOut: rec.timedOut,
      durationMs: rec.durationMs,
      truncated: rec.truncated,
      at: rec.at ?? this.now(),
      stdoutPreview: preview(rec.stdout),
      stderrPreview: preview(rec.stderr),
    };
    this.records.push(full);
    if (this.records.length > this.maxInMemory) {
      this.records.splice(0, this.records.length - this.maxInMemory);
    }
    this.appendJsonl(full);
    return full;
  }

  private appendJsonl(rec: HookExecutionRecord): void {
    if (!this.jsonlPath) return;
    try {
      fs.mkdirSync(path.dirname(this.jsonlPath), { recursive: true });
      fs.appendFileSync(this.jsonlPath, `${JSON.stringify(rec)}\n`);
    } catch {
      /* best-effort audit trail; never let logging break a hook run */
    }
  }

  /** All records (oldest first), optionally filtered by hook name. */
  all(name?: string): HookExecutionRecord[] {
    return name ? this.records.filter((r) => r.name === name) : [...this.records];
  }

  /** The most recent `limit` records for `name` (newest first). */
  recent(name: string, limit = 5): HookExecutionRecord[] {
    return this.records
      .filter((r) => r.name === name)
      .slice(-limit)
      .reverse();
  }

  /** The single most recent record for `name`, if any. */
  last(name: string): HookExecutionRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].name === name) return this.records[i];
    }
    return undefined;
  }

  /** Count of executions of `name` since local midnight (today). */
  countToday(name: string): number {
    const start = startOfDay(this.now());
    return this.records.filter((r) => r.name === name && r.at >= start).length;
  }

  /** Distinct hook names seen, in first-seen order. */
  names(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of this.records) {
      if (!seen.has(r.name)) {
        seen.add(r.name);
        out.push(r.name);
      }
    }
    return out;
  }
}

function startOfDay(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Render a human-readable relative age (e.g. `1.2s ago`, `5min ago`). */
export function relativeAge(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 1_000) return `${ms}ms ago`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Render a one-line outcome tag for a record (`ok` / `blocked` / `failed`). */
export function outcomeTag(rec: HookExecutionRecord): "ok" | "blocked" | "failed" {
  if (rec.blocked) return "blocked";
  if (rec.exitCode !== 0 || rec.timedOut) return "failed";
  return "ok";
}
