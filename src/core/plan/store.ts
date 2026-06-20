/**
 * Filesystem-backed Plan store (v0.3 §13).
 *
 * A Plan is a draft outline produced by `mathran plan "<objective>"` running
 * a constrained, read-only ChatSession. The user reviews drafts with
 * `mathran plan list/show` and either promotes one into a real effort+goal
 * via `mathran plan accept <id>` or shelves it with `mathran plan reject`.
 *
 * Storage: one `<plan-id>.jsonl` per plan under
 * `<workspace>/.mathran/plans/`. Each line is a complete Plan record; the
 * **last** line wins (mirrors how chat conversation jsonl works). This gives
 * us a free undo log for free without forcing migrations whenever the schema
 * grows.
 *
 * Atomic-write helper: we reuse `atomicWriteFile` (T3 / v0.2 §3) for whole-
 * file rewrites (full history rewrite) but use plain `fs.appendFile` for
 * normal updates because each update writes a single self-describing JSON
 * line; an interrupted append leaves at most one half-written tail line that
 * `JSON.parse` will reject and `list()` will skip.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import { atomicWriteFile } from "../chat/atomic-write.js";

/** Persisted plan record. */
export interface Plan {
  /** Stable id, prefixed with `plan-`. */
  id: string;
  /** Objective text the user passed on the CLI. Frozen at creation. */
  objective: string;
  /** Lifecycle status. */
  status: "draft" | "accepted" | "rejected";
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
  /** Markdown plan body produced by the planning ChatSession. */
  body: string;
  /** Effort slug (in the default/active project) created on `accept`. */
  acceptedEffortId: string | null;
  /** Model used by the planning runner, when known. */
  modelHint?: string;
}

const PLANS_DIR = path.join(".mathran", "plans");

/** Slug-safe id matcher (defense-in-depth). */
function isSafePlanId(s: string): boolean {
  if (typeof s !== "string" || s.length === 0 || s.length > 64) return false;
  return /^plan-[a-z0-9]+$/.test(s);
}

/** Generate a fresh plan id `plan-XXXXXX` (6 hex chars, ~24 bits). */
function newPlanId(): string {
  return `plan-${randomBytes(3).toString("hex")}`;
}

/** Path on disk for one plan. */
export function planFileFor(workspace: string, planId: string): string {
  if (!isSafePlanId(planId)) {
    throw new Error(`invalid plan id: ${planId}`);
  }
  return path.join(workspace, PLANS_DIR, `${planId}.jsonl`);
}

/** Path on disk for the plans directory. */
export function plansDirFor(workspace: string): string {
  return path.join(workspace, PLANS_DIR);
}

export interface PlanStoreOptions {
  workspace: string;
}

/**
 * High-level wrapper around the on-disk plan files.
 *
 * Methods are stateless w.r.t. the instance — the workspace path is the only
 * thing held — so it's safe to share one across requests/CLI invocations.
 */
export class PlanStore {
  readonly workspace: string;

  constructor(opts: PlanStoreOptions) {
    this.workspace = opts.workspace;
  }

  /**
   * Make a brand-new draft plan with an empty body. Caller fills the body
   * via `setBody` once the runner has produced markdown.
   */
  async create(objective: string, modelHint?: string): Promise<Plan> {
    const now = new Date().toISOString();
    const plan: Plan = {
      id: newPlanId(),
      objective,
      status: "draft",
      createdAt: now,
      updatedAt: now,
      body: "",
      acceptedEffortId: null,
      ...(modelHint !== undefined ? { modelHint } : {}),
    };
    await this.writeRecord(plan);
    return plan;
  }

  /** Get the latest record for one plan. Returns null if not found. */
  async get(id: string): Promise<Plan | null> {
    if (!isSafePlanId(id)) return null;
    return await this.readLatest(id);
  }

  /** Enumerate every plan on disk (latest-line-wins per file), newest first. */
  async list(): Promise<Plan[]> {
    const dir = plansDirFor(this.workspace);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }
    const plans: Plan[] = [];
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!isSafePlanId(id)) continue;
      const plan = await this.readLatest(id);
      if (plan) plans.push(plan);
    }
    plans.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return plans;
  }

  /** Replace the body and bump `updatedAt`. Throws when the plan is missing. */
  async setBody(id: string, body: string): Promise<Plan> {
    const cur = await this.requireExisting(id);
    const next: Plan = { ...cur, body, updatedAt: new Date().toISOString() };
    await this.writeRecord(next);
    return next;
  }

  /**
   * Mark the plan accepted and record the effort id it spawned. Refuses to
   * transition unless the current status is `draft` (idempotent re-accept on
   * the same effort id is allowed for retry-safety).
   */
  async accept(id: string, effortId: string): Promise<Plan> {
    const cur = await this.requireExisting(id);
    if (cur.status === "accepted" && cur.acceptedEffortId === effortId) {
      return cur;
    }
    if (cur.status !== "draft") {
      throw new Error(`plan ${id} is ${cur.status}; cannot accept`);
    }
    const next: Plan = {
      ...cur,
      status: "accepted",
      acceptedEffortId: effortId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecord(next);
    return next;
  }

  /**
   * SPA-flavoured accept: flip a draft plan to `accepted` without binding
   * it to an effort. The CLI/full accept flow keeps using {@link accept}
   * with an effort id; the web overlay (v0.16 §9 audit #2) only needs to
   * mark the plan saved-and-reviewed so it stops showing up as a pending
   * draft. Idempotent on already-accepted draft-acceptances (i.e. when
   * `acceptedEffortId === null`).
   */
  async acceptDraft(id: string): Promise<Plan> {
    const cur = await this.requireExisting(id);
    if (cur.status === "accepted" && cur.acceptedEffortId === null) {
      return cur;
    }
    if (cur.status !== "draft") {
      throw new Error(`plan ${id} is ${cur.status}; cannot accept`);
    }
    const next: Plan = {
      ...cur,
      status: "accepted",
      acceptedEffortId: null,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecord(next);
    return next;
  }

  /**
   * Mark the plan rejected. Refuses unless the current status is `draft` —
   * `accepted` plans are immutable so the audit trail back to the effort
   * stays intact. (Reject-of-rejected is a no-op.)
   */
  async reject(id: string): Promise<Plan> {
    const cur = await this.requireExisting(id);
    if (cur.status === "rejected") return cur;
    if (cur.status !== "draft") {
      throw new Error(`plan ${id} is ${cur.status}; cannot reject`);
    }
    const next: Plan = {
      ...cur,
      status: "rejected",
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecord(next);
    return next;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Append one record line to the plan jsonl, creating dirs as needed. */
  private async writeRecord(plan: Plan): Promise<void> {
    const file = planFileFor(this.workspace, plan.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Append-only: each line is a full snapshot. JSON.stringify never produces
    // an embedded newline, so one record == one line. atomicWriteFile would
    // require us to read+rewrite the whole history; appendFile is simpler and
    // crash-safe enough (a torn last line is skipped on read).
    await fs.appendFile(file, JSON.stringify(plan) + "\n", "utf-8");
  }

  /** Parse the file and return the last well-formed record, or null. */
  private async readLatest(id: string): Promise<Plan | null> {
    let raw: string;
    try {
      raw = await fs.readFile(planFileFor(this.workspace, id), "utf-8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    let last: Plan | null = null;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const v = JSON.parse(t);
        if (
          v &&
          typeof v === "object" &&
          typeof v.id === "string" &&
          typeof v.objective === "string" &&
          typeof v.status === "string" &&
          typeof v.body === "string" &&
          typeof v.createdAt === "string" &&
          typeof v.updatedAt === "string" &&
          (v.acceptedEffortId === null || typeof v.acceptedEffortId === "string")
        ) {
          last = v as Plan;
        }
      } catch {
        // skip malformed line (e.g. torn append)
      }
    }
    return last;
  }

  private async requireExisting(id: string): Promise<Plan> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`plan not found: ${id}`);
    return cur;
  }

  /**
   * Compact a plan's history to a single line (the latest snapshot). Useful
   * for tests and (eventually) a `plan compact` command. Uses the atomic
   * write helper so a crash mid-rewrite leaves the original file intact.
   */
  async compact(id: string): Promise<Plan | null> {
    const latest = await this.get(id);
    if (!latest) return null;
    const file = planFileFor(this.workspace, id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(latest) + "\n");
    return latest;
  }
}
