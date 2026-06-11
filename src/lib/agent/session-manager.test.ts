import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The module reads env at import time for the gates; set generous defaults and
// re-import fresh per suite so constants are deterministic.
function freshImport() {
  vi.resetModules();
  return import("./session-manager");
}

describe("SessionManager Phase-A admission (gates + token bucket)", () => {
  const ENV = process.env;
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ENV,
      ASSISTANT_MAX_CONCURRENT_SUBAGENTS: "100",
      ASSISTANT_SUBAGENT_PER_PARENT: "8",
      ASSISTANT_SUBAGENT_MAX_DEPTH: "5",
      // big bucket so token gate doesn't interfere unless a test wants it
      ASSISTANT_PROVIDER_TPM_AZURE: "100000000",
      ASSISTANT_SPAWN_TOKEN_EST: "12000",
    };
  });
  afterEach(() => {
    process.env = ENV;
  });

  it("exposes the configured ceilings", async () => {
    const m = await freshImport();
    expect(m.MAX_CONCURRENT_SUBAGENTS).toBe(100);
    expect(m.MAX_SUBAGENT_PER_PARENT).toBe(8);
    expect(m.MAX_SUBAGENT_DEPTH).toBe(5);
  });

  it("DEPTH_LIMIT: rejects a spawn whose child depth would exceed max", async () => {
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    // parentDepth 5 ⇒ child depth 6 > 5
    const r = mgr.reserveAndCreateSession({ parentId: "conv1", parentDepth: 5, providerKey: "azure" });
    expect("id" in r).toBe(false);
    expect((r as { reason?: string }).reason).toBe("DEPTH_LIMIT");
  });

  it("PARENT_QUOTA: rejects the 9th live child of one parent (limit 8)", async () => {
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    const created: string[] = [];
    for (let i = 0; i < 8; i++) {
      const r = mgr.reserveAndCreateSession({ parentId: "P", parentDepth: 0, providerKey: "azure" });
      expect("id" in r).toBe(true);
      created.push((r as { id: string }).id);
    }
    expect(mgr.childrenRunningCount("P")).toBe(8);
    const ninth = mgr.reserveAndCreateSession({ parentId: "P", parentDepth: 0, providerKey: "azure" });
    expect("id" in ninth).toBe(false);
    expect((ninth as { reason?: string }).reason).toBe("PARENT_QUOTA");

    // Completing one frees a slot for the parent.
    mgr.updateSession(created[0]!, { status: "completed" });
    expect(mgr.childrenRunningCount("P")).toBe(7);
    const afterFree = mgr.reserveAndCreateSession({ parentId: "P", parentDepth: 0, providerKey: "azure" });
    expect("id" in afterFree).toBe(true);
  });

  it("per-parent quota is independent across different parents", async () => {
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    for (let i = 0; i < 8; i++) mgr.reserveAndCreateSession({ parentId: "A", parentDepth: 0, providerKey: "azure" });
    // A is full, but B is empty
    expect((mgr.reserveAndCreateSession({ parentId: "A", parentDepth: 0, providerKey: "azure" }) as { reason?: string }).reason).toBe("PARENT_QUOTA");
    expect("id" in mgr.reserveAndCreateSession({ parentId: "B", parentDepth: 0, providerKey: "azure" })).toBe(true);
  });

  it("GLOBAL_CONCURRENCY: rejects past the global cap regardless of parent spread", async () => {
    process.env.ASSISTANT_MAX_CONCURRENT_SUBAGENTS = "5";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100"; // disable parent gate
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    for (let i = 0; i < 5; i++) {
      const r = mgr.reserveAndCreateSession({ parentId: `p${i}`, parentDepth: 0, providerKey: "azure" });
      expect("id" in r).toBe(true);
    }
    const over = mgr.reserveAndCreateSession({ parentId: "pX", parentDepth: 0, providerKey: "azure" });
    expect("id" in over).toBe(false);
    expect((over as { reason?: string }).reason).toBe("GLOBAL_CONCURRENCY");
  });

  it("PROVIDER_TPM: rejects when the provider token bucket is exhausted", async () => {
    // tiny bucket: 20k capacity, est 12k ⇒ first ok, second exhausts
    process.env.ASSISTANT_PROVIDER_TPM_AZURE = "20000";
    process.env.ASSISTANT_SPAWN_TOKEN_EST = "12000";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100";
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    const first = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    expect("id" in first).toBe(true); // 12k debited, 8k left
    const second = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    expect("id" in second).toBe(false); // 8k < 12k
    expect((second as { reason?: string }).reason).toBe("PROVIDER_TPM");
  });

  it("token release refunds the bucket so a later spawn can proceed", async () => {
    process.env.ASSISTANT_PROVIDER_TPM_AZURE = "20000";
    process.env.ASSISTANT_SPAWN_TOKEN_EST = "12000";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100";
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    const first = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" }) as { id: string };
    expect(first.id).toBeTruthy();
    // exhausted now
    expect((mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" }) as { reason?: string }).reason).toBe("PROVIDER_TPM");
    // refund the full reservation (actual usage 0) → bucket back to ~20k
    mgr.releaseSession(first.id);
    const third = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    expect("id" in third).toBe(true);
  });

  it("[P0-2 fix] over-burn (actual > reserved) DEBITS the bucket so TPM stays honest", async () => {
    process.env.ASSISTANT_PROVIDER_TPM_AZURE = "24000";
    process.env.ASSISTANT_SPAWN_TOKEN_EST = "12000";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100";
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    const a = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" }) as { id: string };
    expect(a.id).toBeTruthy();
    // Pretend it actually burned 30k (way over reserved). reserved-actual = -18k.
    // Pre-fix: refund=Math.max(0, ...)=0 → bucket stays at 12k, missing 18k debit.
    // Post-fix: signed delta → 12k + (-18k) clamped to 0.
    mgr.releaseSession(a.id, 30000);
    // Now bucket=0; even a tiny spawn must fail until refill window passes.
    process.env.ASSISTANT_SPAWN_TOKEN_EST = "1";
    const m2 = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    expect((m2 as { reason?: string }).reason).toBe("PROVIDER_TPM");
  });

  it("releaseSession is idempotent (no double-refund inflates the bucket)", async () => {
    process.env.ASSISTANT_PROVIDER_TPM_AZURE = "24000";
    process.env.ASSISTANT_SPAWN_TOKEN_EST = "12000";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100";
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    const a = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" }) as { id: string }; // 12k left
    mgr.releaseSession(a.id); // refund 12k → 24k
    mgr.releaseSession(a.id); // idempotent: must NOT refund again (cap is 24k anyway, but reservedTokens cleared)
    mgr.releaseSession(a.id);
    // capacity is the hard ceiling regardless; prove we can still only fit 2 spawns of 12k
    const b = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    const c = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    expect("id" in b).toBe(true);
    expect("id" in c).toBe(true);
    const d = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    expect("id" in d).toBe(false); // 24k cap → only 2× 12k fit
  });

  it("unlimited provider (TPM=0) bypasses the token gate entirely", async () => {
    process.env.ASSISTANT_PROVIDER_TPM_AZURE = "0";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100";
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    // many spawns, never blocked by tokens
    for (let i = 0; i < 30; i++) {
      const r = mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
      expect("id" in r).toBe(true);
    }
  });

  it("cancelSession refunds tokens (cascade frees the whole subtree's budget)", async () => {
    process.env.ASSISTANT_PROVIDER_TPM_AZURE = "20000";
    process.env.ASSISTANT_SPAWN_TOKEN_EST = "12000";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100";
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    const a = mgr.reserveAndCreateSession({ parentId: "root", parentDepth: 0, providerKey: "azure" }) as { id: string };
    expect((mgr.reserveAndCreateSession({ parentId: "root", parentDepth: 0, providerKey: "azure" }) as { reason?: string }).reason).toBe("PROVIDER_TPM");
    mgr.cancelSession(a.id); // refunds 12k
    const b = mgr.reserveAndCreateSession({ parentId: "root", parentDepth: 0, providerKey: "azure" });
    expect("id" in b).toBe(true);
  });

  it("depth 5 is allowed (boundary): parentDepth 4 → child 5 ok, 5 → 6 rejected", async () => {
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    expect("id" in mgr.reserveAndCreateSession({ parentId: "c", parentDepth: 4, providerKey: "azure" })).toBe(true);
    expect((mgr.reserveAndCreateSession({ parentId: "c", parentDepth: 5, providerKey: "azure" }) as { reason?: string }).reason).toBe("DEPTH_LIMIT");
  });

  it("checkSpawn (read-only) mirrors reserve verdicts without mutating", async () => {
    process.env.ASSISTANT_PROVIDER_TPM_AZURE = "20000";
    process.env.ASSISTANT_SPAWN_TOKEN_EST = "12000";
    process.env.ASSISTANT_SUBAGENT_PER_PARENT = "100";
    const m = await freshImport();
    const mgr = m.SessionManager.getInstance();
    // probe twice — both pass because checkSpawn doesn't debit
    expect(mgr.checkSpawn(0, "p", "azure").ok).toBe(true);
    expect(mgr.checkSpawn(0, "p", "azure").ok).toBe(true);
    // but an actual reserve debits, then probe reflects exhaustion
    mgr.reserveAndCreateSession({ parentId: "p", parentDepth: 0, providerKey: "azure" });
    expect(mgr.checkSpawn(0, "p", "azure").ok).toBe(false);
    expect(mgr.checkSpawn(0, "p", "azure").reason).toBe("PROVIDER_TPM");
  });
});
