/**
 * Session-manager × nickname-pool integration tests — spec/04-subagent.md §4.11.
 *
 * 1. reserveAndCreateSession assigns a non-empty nickname
 * 2. Sequential spawns get distinct nicknames
 * 3. Pool wrap appends roman-numeral suffix (Frieren II)
 * 4. agentPath is built as [...parentPath, `${nickname}/${agentName}`]
 * 5. Root-level spawn (no parentAgentPath) starts a fresh single-segment path
 * 6. releaseSession returns the nickname to the pool (re-usable next assign)
 * 7. cancelSession also releases the nickname (cleanup path)
 * 8. SpawnDecision rejections never burn a nickname
 *
 * Ported: 2026-06-10 (commit 4b/6 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager, type AgentSession } from "../session-manager";
import {
  _resetForTest as resetNicknamePool,
  snapshot as snapshotNicknamePool,
} from "../agent-nickname-pool";
import { AGENT_NAMES } from "../agent-names";

function isSession(v: AgentSession | { ok: boolean }): v is AgentSession {
  return "id" in v;
}

beforeEach(() => {
  resetNicknamePool();
});

describe("SessionManager × nickname pool", () => {
  it("assigns a non-empty nickname on reserveAndCreateSession", () => {
    const mgr = new SessionManager();
    const s = mgr.reserveAndCreateSession({
      parentId: "conv-1",
      parentDepth: 0,
      providerKey: "azure",
      agentName: "deep_research",
    });
    expect(isSession(s)).toBe(true);
    if (!isSession(s)) return;
    expect(s.nickname).toBeTruthy();
    expect(typeof s.nickname).toBe("string");
    expect(s.nickname!.length).toBeGreaterThan(0);
    expect(s.agentName).toBe("deep_research");
  });

  it("sequential spawns get distinct nicknames", () => {
    const mgr = new SessionManager();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const s = mgr.reserveAndCreateSession({
        parentId: `p${i}`,
        parentDepth: 0,
        providerKey: "azure",
        agentName: "researcher",
      });
      expect(isSession(s)).toBe(true);
      if (!isSession(s)) return;
      expect(seen.has(s.nickname!)).toBe(false);
      seen.add(s.nickname!);
    }
    expect(seen.size).toBe(5);
  });

  it("pool wrap appends roman-numeral suffix once exhausted", () => {
    const mgr = new SessionManager();
    const sessions: AgentSession[] = [];
    // Pool size = AGENT_NAMES.length; one more spawn = wrap → "X II"
    for (let i = 0; i < AGENT_NAMES.length + 1; i++) {
      const s = mgr.reserveAndCreateSession({
        parentId: `p${i}`,
        parentDepth: 0,
        providerKey: "azure",
        agentName: "researcher",
      });
      if (isSession(s)) sessions.push(s);
    }
    expect(sessions.length).toBe(AGENT_NAMES.length + 1);
    const last = sessions.at(-1)!;
    expect(last.nickname).toMatch(/ II$/);
  });

  it("builds agentPath = [...parentPath, `${nickname}/${agentName}`]", () => {
    const mgr = new SessionManager();
    const parent = mgr.reserveAndCreateSession({
      parentId: "conv-1",
      parentDepth: 0,
      providerKey: "azure",
      agentName: "root_tool",
    });
    if (!isSession(parent)) return;
    expect(parent.agentPath).toEqual([`${parent.nickname}/root_tool`]);

    const child = mgr.reserveAndCreateSession({
      parentId: parent.id,
      parentDepth: 1,
      providerKey: "azure",
      agentName: "leaf_tool",
      parentAgentPath: parent.agentPath,
    });
    if (!isSession(child)) return;
    expect(child.agentPath).toEqual([
      `${parent.nickname}/root_tool`,
      `${child.nickname}/leaf_tool`,
    ]);
  });

  it("root-level spawn without parentAgentPath starts a single-segment path", () => {
    const mgr = new SessionManager();
    const s = mgr.reserveAndCreateSession({
      parentDepth: 0,
      providerKey: "azure",
      agentName: "rootless",
    });
    if (!isSession(s)) return;
    expect(s.agentPath).toEqual([`${s.nickname}/rootless`]);
  });

  it("releaseSession returns the nickname to the pool", () => {
    const mgr = new SessionManager();
    const s1 = mgr.reserveAndCreateSession({
      parentDepth: 0,
      providerKey: "azure",
      agentName: "tool",
    });
    if (!isSession(s1)) return;
    const nick1 = s1.nickname!;
    mgr.releaseSession(s1.id, 100);
    expect(snapshotNicknamePool().inUse).not.toContain(nick1);

    // Drain the rest of the pool to force the next assign to reuse the
    // released slot (otherwise the pool's monotonic cursor would prefer a
    // fresh name).
    for (let i = 0; i < AGENT_NAMES.length - 1; i++) {
      mgr.reserveAndCreateSession({
        parentDepth: 0,
        providerKey: "azure",
        agentName: "tool",
      });
    }
    const s2 = mgr.reserveAndCreateSession({
      parentDepth: 0,
      providerKey: "azure",
      agentName: "tool",
    });
    if (!isSession(s2)) return;
    expect(s2.nickname).toBe(nick1);
  });

  it("cancelSession releases the nickname (cancel path)", () => {
    const mgr = new SessionManager();
    const s = mgr.reserveAndCreateSession({
      parentDepth: 0,
      providerKey: "azure",
      agentName: "tool",
    });
    if (!isSession(s)) return;
    const nick = s.nickname!;
    expect(snapshotNicknamePool().inUse).toContain(nick);
    mgr.cancelSession(s.id);
    expect(snapshotNicknamePool().inUse).not.toContain(nick);
  });

  it("rejected spawn never burns a nickname (DEPTH_LIMIT)", () => {
    const mgr = new SessionManager();
    const before = snapshotNicknamePool().inUse.length;
    const decision = mgr.reserveAndCreateSession({
      parentDepth: 999,
      providerKey: "azure",
      agentName: "tool",
    });
    expect(isSession(decision)).toBe(false);
    expect(snapshotNicknamePool().inUse.length).toBe(before);
  });
});
