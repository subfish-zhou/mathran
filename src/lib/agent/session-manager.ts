import type OpenAI from "openai";
import { randomUUID } from "crypto";
import { assign as assignNickname, release as releaseNickname } from "./agent-nickname-pool";

export interface AgentSession {
  id: string;
  parentId?: string;
  userId?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: Date;
  // #1(a): updated on every updateSession / activity heartbeat. Used by cleanup
  // to detect stuck `running` sessions (loop hang) that would otherwise never be
  // reclaimed. Defaults to startedAt on creation.
  lastActivityAt: Date;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  result?: string;
  abortController?: AbortController;
  // #A: which provider's token bucket this session reserved against, and how
  // many tokens are currently held. Set at admission (reserveSpawn); refunded
  // exactly once when the session reaches a terminal state. `undefined`
  // providerKey ⇒ no reservation was made (e.g. legacy createSession path).
  providerKey?: string;
  reservedTokens?: number;
  // [commit-4b] codex-parity identity fields. Set at admission time by
  // reserveAndCreateSession(); never mutated afterwards. Used for human-
  // facing UI ("Frieren spawned by Heiter") and for hook payloads so
  // observers can route events without needing to re-join with
  // assistant_subagent_runs.
  //   - agentName: the *tool* name that spawned this session (the kind of
  //     work it does, e.g. "deep_research"). Stable identifier.
  //   - agentRole: optional codex "role" tag (architect / coder / researcher
  //     / reviewer / generalist). Currently always undefined; commit 4c may
  //     wire it from agent-roles.ts.
  //   - nickname: human-readable handle from the AGENT_NAMES pool. Released
  //     back to the pool on terminal status. Empty string only when the pool
  //     code itself failed (never expected; defensive).
  //   - agentPath: ancestry chain "[grandparentNick/agentName,
  //     parentNick/agentName, thisNick/agentName]". Used by list-subagents
  //     and get-subagent-status to render the tree.
  agentName?: string;
  agentRole?: string;
  nickname?: string;
  agentPath?: string[];
}

/** #A: structured spawn-admission verdict (replaces the bare boolean canSpawn). */
export interface SpawnDecision {
  ok: boolean;
  /** machine-readable gate that blocked, when !ok */
  reason?: "DEPTH_LIMIT" | "GLOBAL_CONCURRENCY" | "PARENT_QUOTA" | "PROVIDER_TPM";
  /** human-facing detail for the tool result surfaced to the agent */
  detail?: string;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// #1(a): a `running` session with no activity for longer than this is treated as
// stuck (the agent loop hung). We abort() its controller and mark it failed so a
// later cleanup pass can reclaim it. Sub-agent tools can run long (deep_research
// timeoutMs = 1h); pick max(env override, 30min) + a buffer so we never kill a
// genuinely-active long task.
const STUCK_TTL_MS = Math.max(
  Number(process.env.ASSISTANT_SUBAGENT_STUCK_TTL_MS ?? 0) || 0,
  30 * 60 * 1000, // 30 minutes floor
) + 5 * 60 * 1000; // + 5 min buffer

// #2: GLOBAL concurrency hard cap — the absolute ceiling on live `running`
// sub-agents across the whole process. Counted against the real map so it can
// never drift. NOTE: the *effective* throughput limiter under load is the
// per-provider token bucket below (TPM), not this number; 100 is the
// blow-up guard, the bucket is what prevents self-inflicted 429 storms.
export const MAX_CONCURRENT_SUBAGENTS = Math.max(
  1,
  Number(process.env.ASSISTANT_MAX_CONCURRENT_SUBAGENTS ?? 100) || 100,
);

// #A: PER-PARENT concurrency quota — max live `running` *direct* children a
// single parent may have at once. Prevents one parent from monopolizing the
// global pool (and bounds the N^depth fan-out together with the depth gate).
export const MAX_SUBAGENT_PER_PARENT = Math.max(
  1,
  Number(process.env.ASSISTANT_SUBAGENT_PER_PARENT ?? 8) || 8,
);

// #5: sub-agent recursion depth ceiling, no longer a hard-coded literal in the
// executor. Configurable via env (default 5 — deep enough for real task trees,
// shallow enough that parent-context accretion doesn't degrade LLM planning).
export const MAX_SUBAGENT_DEPTH = Math.max(
  1,
  Number(process.env.ASSISTANT_SUBAGENT_MAX_DEPTH ?? 5) || 5,
);

// #A: per-provider TPM (tokens-per-minute) budgets for the spawn-admission
// token bucket. The real throughput limiter when global concurrency is high.
// Azure gpt-55 has 15M TPM; default reserves ~70% (10.5M) for sub-agents and
// leaves headroom for the main conversation stream. 0/undefined = unlimited
// (bucket disabled for that provider).
const PROVIDER_TPM: Record<string, number> = {
  azure: Number(process.env.ASSISTANT_PROVIDER_TPM_AZURE ?? 10_500_000) || 0,
  anthropic: Number(process.env.ASSISTANT_PROVIDER_TPM_ANTHROPIC ?? 0) || 0,
  openai: Number(process.env.ASSISTANT_PROVIDER_TPM_OPENAI ?? 0) || 0,
};

// #A: rough per-spawn token reservation when the caller doesn't supply an
// estimate. Tuned to a typical sub-agent request+response envelope. The bucket
// is reconciled to actual usage on release when known.
const DEFAULT_SPAWN_TOKEN_EST = Math.max(
  1,
  Number(process.env.ASSISTANT_SPAWN_TOKEN_EST ?? 12_000) || 12_000,
);

// #A: per-provider token bucket for spawn admission. Classic leaky/refill
// bucket: capacity == TPM (one minute of budget), refilled continuously at
// TPM/60000 tokens per ms. tryAcquire() succeeds only if enough tokens are
// available *and* there's at least one would-be slot, otherwise the spawn is
// rejected (back-pressure, not queueing). release() refunds unused tokens when
// a session ends, reconciling an over/under estimate. A provider with TPM<=0 is
// treated as unlimited (bucket bypassed).
interface TokenBucket {
  capacity: number; // == TPM
  tokens: number; // current available
  ratePerMs: number; // TPM / 60000
  lastRefill: number; // ms epoch
}

const tokenBuckets = new Map<string, TokenBucket>();

function getBucket(providerKey: string): TokenBucket | null {
  const tpm = PROVIDER_TPM[providerKey] ?? 0;
  if (tpm <= 0) return null; // unlimited / disabled
  let b = tokenBuckets.get(providerKey);
  if (!b) {
    b = { capacity: tpm, tokens: tpm, ratePerMs: tpm / 60_000, lastRefill: Date.now() };
    tokenBuckets.set(providerKey, b);
  }
  return b;
}

function refill(b: TokenBucket): void {
  const now = Date.now();
  const elapsed = now - b.lastRefill;
  if (elapsed <= 0) return;
  b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.ratePerMs);
  b.lastRefill = now;
}

/**
 * #A: try to reserve `cost` tokens from a provider's bucket. Returns true and
 * debits on success; returns false (no debit) when the bucket lacks the tokens.
 * Unlimited providers always succeed. A single request larger than capacity is
 * clamped so it can still eventually run (never permanently starves).
 */
function tryAcquireTokens(providerKey: string, cost: number): boolean {
  const b = getBucket(providerKey);
  if (!b) return true; // unlimited
  refill(b);
  const need = Math.min(Math.max(1, cost), b.capacity);
  if (b.tokens >= need) {
    b.tokens -= need;
    return true;
  }
  return false;
}

/** #A: refund tokens to a provider bucket (on session end / reconciliation).
 *  [P0-2 fix] amount can be NEGATIVE — meaning actual usage exceeded the
 *  spawn-time reservation. A negative amount DEBITS the bucket so TPM
 *  accounting stays honest. Without this, over-burning sessions would
 *  silently inflate bucket capacity. */
function releaseTokens(providerKey: string | undefined, amount: number | undefined): void {
  if (!providerKey || !amount || amount === 0) return;
  const b = getBucket(providerKey);
  if (!b) return;
  refill(b);
  // Clamp to [0, capacity]; positive amount refills, negative debits.
  b.tokens = Math.max(0, Math.min(b.capacity, b.tokens + amount));
}

let lastCleanupTime = 0;

// #1(b): single-process cleanup interval. Guarded on globalThis so Next.js dev
// HMR / multiple module evaluations don't register duplicate timers, and
// `.unref()`-ed so it never blocks process exit.
const GLOBAL_INTERVAL_KEY = "__mathub_subagent_cleanup_interval__";
type IntervalGlobal = typeof globalThis & {
  [GLOBAL_INTERVAL_KEY]?: ReturnType<typeof setInterval>;
};

export class SessionManager {
  private static instance: SessionManager;
  private sessions = new Map<string, AgentSession>();

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
      SessionManager.instance.ensureCleanupTimer();
      SessionManager.instance.rehydrateOnce();
    }
    return SessionManager.instance;
  }

  // #B Step 3: one-time orphan rehydrate on first singleton creation in this
  // process. Any DB row left `running` from a previous process can never resume
  // (its in-memory promise died with that process) — mark it orphaned. Done via
  // a lazy dynamic import so this otherwise DB-free module (and its unit tests)
  // never statically pull in `@/server/db`. Fire-and-forget + guarded so it runs
  // at most once; failures are swallowed inside rehydrateOrphans.
  private rehydrateDone = false;
  private rehydrateOnce(): void {
    if (this.rehydrateDone) return;
    this.rehydrateDone = true;
    // Skip in unit tests (no DB / Vitest env) to avoid spurious connection logs.
    if (process.env.VITEST || process.env.NODE_ENV === "test") return;
    void import("./subagent-persistence")
      .then((m) => m.rehydrateOrphans())
      .catch((err: unknown) => {
        console.error("[session-manager] orphan rehydrate failed:", err);
      });
  }

  /**
   * #1(b): install a single global setInterval that runs cleanup() every
   * CLEANUP_INTERVAL_MS. Idempotent across HMR / repeated module evaluation via
   * a globalThis guard. The handle is `.unref()`-ed so it does not keep the
   * Node process alive on shutdown.
   */
  ensureCleanupTimer(): void {
    const g = globalThis as IntervalGlobal;
    if (g[GLOBAL_INTERVAL_KEY]) return;
    const handle = setInterval(() => {
      try {
        SessionManager.getInstance().cleanup();
      } catch (err) {
        // Never let a cleanup error kill the timer or crash the process.
        console.error("[session-manager] periodic cleanup failed:", err);
      }
    }, CLEANUP_INTERVAL_MS);
    // unref so the interval never blocks process exit (and is a no-op in
    // environments where the handle lacks unref, e.g. some edge runtimes).
    (handle as { unref?: () => void }).unref?.();
    g[GLOBAL_INTERVAL_KEY] = handle;
  }

  createSession(parentId?: string, userId?: string): AgentSession {
    // Lazy cleanup: run if >10 minutes since last cleanup (kept as a backstop
    // alongside the periodic timer for low-traffic / serverless cold paths).
    const now = Date.now();
    if (now - lastCleanupTime > CLEANUP_INTERVAL_MS) {
      lastCleanupTime = now;
      this.cleanup();
    }

    const startedAt = new Date();
    const session: AgentSession = {
      id: randomUUID(),
      parentId,
      userId,
      status: "running",
      startedAt,
      lastActivityAt: startedAt,
      messages: [],
      abortController: new AbortController(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  updateSession(id: string, updates: Partial<AgentSession>): void {
    const session = this.sessions.get(id);
    if (!session) return;
    Object.assign(session, updates);
    // #1(a): any update counts as activity (status change, result write, etc.).
    session.lastActivityAt = new Date();
  }

  /** #1(a): explicit activity heartbeat without mutating other fields. */
  touchSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastActivityAt = new Date();
  }

  /**
   * #2: current number of live `running` sessions. Computed from the map so it
   * cannot drift from reality (no standalone counter).
   */
  runningCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "running") n++;
    }
    return n;
  }

  /**
   * #A: number of live `running` *direct* children of `parentId`. Drives the
   * per-parent quota gate. Still an O(n) scan of the map, but n is small and
   * Phase B moves the authoritative count to an indexed DB column.
   */
  childrenRunningCount(parentId: string): number {
    let n = 0;
    for (const session of this.sessions.values()) {
      if (session.parentId === parentId && session.status === "running") n++;
    }
    return n;
  }

  /** #2: legacy boolean gate (global cap only). Kept for back-compat. */
  canSpawn(): boolean {
    return this.runningCount() < MAX_CONCURRENT_SUBAGENTS;
  }

  /**
   * #A: full structured admission check — depth, global cap, per-parent quota,
   * and per-provider token budget — WITHOUT mutating anything. Use
   * `reserveAndCreateSession` to admit+create atomically; this read-only form
   * is for callers that want to probe first. NOTE: because it doesn't debit the
   * bucket, two probes can both pass; only the atomic reserve path is race-free.
   */
  checkSpawn(parentDepth: number, parentId: string, providerKey?: string, estTokens?: number): SpawnDecision {
    if (parentDepth + 1 > MAX_SUBAGENT_DEPTH) {
      return { ok: false, reason: "DEPTH_LIMIT", detail: `Sub-agent recursion depth exceeded (max ${MAX_SUBAGENT_DEPTH})` };
    }
    if (this.runningCount() >= MAX_CONCURRENT_SUBAGENTS) {
      return { ok: false, reason: "GLOBAL_CONCURRENCY", detail: `Max ${MAX_CONCURRENT_SUBAGENTS} concurrent sub-agents reached` };
    }
    if (this.childrenRunningCount(parentId) >= MAX_SUBAGENT_PER_PARENT) {
      return { ok: false, reason: "PARENT_QUOTA", detail: `Parent already has ${MAX_SUBAGENT_PER_PARENT} running children (per-parent quota)` };
    }
    // Token availability probe (no debit): mirror tryAcquire's success test.
    if (providerKey) {
      const tpm = PROVIDER_TPM[providerKey] ?? 0;
      if (tpm > 0) {
        const b = getBucket(providerKey)!;
        refill(b);
        const need = Math.min(Math.max(1, estTokens ?? DEFAULT_SPAWN_TOKEN_EST), b.capacity);
        if (b.tokens < need) {
          return { ok: false, reason: "PROVIDER_TPM", detail: `Provider ${providerKey} token budget exhausted, retry shortly` };
        }
      }
    }
    return { ok: true };
  }

  /**
   * #A: atomic admit + create. Runs every gate AND debits the token bucket AND
   * inserts the session in one synchronous step — no `await` in between, so the
   * single-threaded event loop guarantees no TOCTOU race between two concurrent
   * spawns. Returns the created session on success, or a SpawnDecision on
   * rejection (caller surfaces it as a tool result for back-pressure).
   */
  reserveAndCreateSession(opts: {
    parentId?: string;
    parentDepth: number;
    userId?: string;
    providerKey?: string;
    estTokens?: number;
    /** [commit-4b] codex-parity: which tool spawned this sub-agent. */
    agentName?: string;
    /** [commit-4b] codex-parity: optional role tag. Reserved for 4c. */
    agentRole?: string;
    /**
     * [commit-4b] Parent's agentPath (ancestry). The new session's path is
     * `[...parentPath, `${nickname}/${agentName}`]`. Top-level spawns pass
     * undefined or an empty array.
     */
    parentAgentPath?: string[];
  }): AgentSession | SpawnDecision {
    const { parentId, parentDepth, userId, providerKey, agentName, agentRole, parentAgentPath } = opts;
    const estTokens = opts.estTokens ?? DEFAULT_SPAWN_TOKEN_EST;

    // Gates first (cheap, no side-effects).
    if (parentDepth + 1 > MAX_SUBAGENT_DEPTH) {
      return { ok: false, reason: "DEPTH_LIMIT", detail: `Sub-agent recursion depth exceeded (max ${MAX_SUBAGENT_DEPTH})` };
    }
    if (this.runningCount() >= MAX_CONCURRENT_SUBAGENTS) {
      return { ok: false, reason: "GLOBAL_CONCURRENCY", detail: `Max ${MAX_CONCURRENT_SUBAGENTS} concurrent sub-agents reached` };
    }
    // Per-parent quota only applies when there's a real parent key. A
    // top-level agent without a conversationId has no parent to quota against.
    if (parentId && this.childrenRunningCount(parentId) >= MAX_SUBAGENT_PER_PARENT) {
      return { ok: false, reason: "PARENT_QUOTA", detail: `Parent already has ${MAX_SUBAGENT_PER_PARENT} running children (per-parent quota)` };
    }
    // Token debit LAST (only side-effecting gate). If it fails, nothing was
    // mutated, so no rollback needed.
    if (providerKey && !tryAcquireTokens(providerKey, estTokens)) {
      return { ok: false, reason: "PROVIDER_TPM", detail: `Provider ${providerKey} token budget exhausted, retry shortly` };
    }

    const session = this.createSession(parentId, userId);
    session.providerKey = providerKey;
    session.reservedTokens = providerKey ? Math.min(Math.max(1, estTokens), getBucket(providerKey)?.capacity ?? estTokens) : undefined;
    // [commit-4b] Identity fields. nicknamePool.assign() never throws and
    // never returns the empty string, but we defensively default to '' so a
    // bug there can't crash spawn admission (the human label is decorative).
    session.agentName = agentName;
    session.agentRole = agentRole;
    try {
      session.nickname = assignNickname();
    } catch {
      session.nickname = "";
    }
    const segment = `${session.nickname || "anon"}/${agentName ?? "unknown"}`;
    session.agentPath = parentAgentPath && parentAgentPath.length > 0
      ? [...parentAgentPath, segment]
      : [segment];
    return session;
  }

  /**
   * #A: refund a session's token reservation, optionally reconciling to the
   * actual tokens used. Idempotent: clears reservedTokens so a second call (or
   * cleanup racing with the resolve handler) can't double-refund. Call this
   * exactly when a session reaches a terminal state.
   *   - actualTokens given  → refund (reserved - actual), clamped ≥ 0
   *   - actualTokens omitted → refund the full reservation (we never charged it)
   */
  releaseSession(id: string, actualTokens?: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    // [commit-4b] Return the nickname to the pool unconditionally — failed /
    // completed / cancelled all release. Idempotent against double calls
    // because we clear the field after release.
    if (session.nickname) {
      try {
        releaseNickname(session.nickname);
      } catch {
        // Pool release errors are non-fatal; the nickname slot is leased not
        // owned, and pool.assign() always falls back to roman-numeral wrap.
      }
      session.nickname = undefined;
    }
    const reserved = session.reservedTokens;
    if (!session.providerKey || !reserved) return;
    // [P0-2 fix] When actualTokens is provided, refund OR debit by the
    // signed delta. Previously `Math.max(0, reserved - actualTokens)`
    // silently dropped the over-burn, leaving the bucket inflated.
    const delta = actualTokens === undefined
      ? reserved
      : reserved - Math.max(0, actualTokens);
    releaseTokens(session.providerKey, delta);
    session.reservedTokens = undefined; // idempotency guard
  }

  cancelSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.status !== "running") return false;
    session.abortController?.abort();
    session.status = "cancelled";
    session.lastActivityAt = new Date();
    // #A: a cancelled session will never finish — refund its full reservation.
    this.releaseSession(id);
    return true;
  }

  /**
   * #4: cascade-cancel a session and its entire descendant sub-tree. Returns the
   * list of session ids that were actually cancelled (running → cancelled).
   * DAG/tree is finite (depth ≤ MAX_DEPTH) so recursion terminates; a visited
   * set additionally guards against any accidental cycle.
   */
  cancelSessionCascade(id: string, _visited?: Set<string>): string[] {
    const visited = _visited ?? new Set<string>();
    if (visited.has(id)) return [];
    visited.add(id);

    const cancelled: string[] = [];
    if (this.cancelSession(id)) cancelled.push(id);

    for (const child of this.getChildSessions(id)) {
      cancelled.push(...this.cancelSessionCascade(child.id, visited));
    }
    return cancelled;
  }

  getChildSessions(parentId: string): AgentSession[] {
    const children: AgentSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.parentId === parentId) {
        children.push(session);
      }
    }
    return children;
  }

  /**
   * commit 4/6 of mathub-ai-codex-upgrade: read-only snapshot of all live
   * sessions for the new `list_subagents` tool. Returns a shallow copy of the
   * value iterator so callers cannot mutate the internal map. Callers MUST
   * filter by `userId` before exposing results to a user-visible surface
   * (the tool itself enforces this).
   */
  allSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  cleanup(): void {
    const now = Date.now();

    // #1(a) PASS 1: reclaim stuck `running` sessions. A running session whose
    // lastActivityAt is older than STUCK_TTL_MS is assumed hung — abort its
    // controller (release the loop) and mark it failed. It is NOT deleted here;
    // the next pass (or a later cleanup) removes it once past SESSION_TTL_MS, so
    // its failure result stays readable in the interim.
    for (const session of this.sessions.values()) {
      if (
        session.status === "running" &&
        now - session.lastActivityAt.getTime() > STUCK_TTL_MS
      ) {
        try {
          session.abortController?.abort();
        } catch {
          // abort() must never throw the cleanup loop.
        }
        session.status = "failed";
        session.result = "stuck: no activity timeout";
        session.lastActivityAt = new Date();
        // #A: stuck session reclaimed — refund its token reservation.
        this.releaseSession(session.id);
      }
    }

    // PASS 2: delete terminal sessions past their TTL. Never deletes a session
    // that is still `running` (only PASS 1 may transition those to failed).
    for (const [id, session] of this.sessions) {
      if (
        session.status !== "running" &&
        now - session.startedAt.getTime() > SESSION_TTL_MS
      ) {
        this.sessions.delete(id);
      }
    }
  }
}
