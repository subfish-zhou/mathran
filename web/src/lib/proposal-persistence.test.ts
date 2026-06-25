// @vitest-environment happy-dom
/**
 * Tests for proposal-persistence — TODO-3 UI #4.F.
 *
 * Covers the localStorage-backed propose_plan / propose_goal banner
 * persistence helpers: defaults, save/clear, TTL expiry, per-conversation
 * isolation, and error tolerance for corrupt cache.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  loadProposals,
  saveGoalProposal,
  savePlanProposal,
  clearProposals,
} from "./proposal-persistence";

const conv1 = "conv-001";
const conv2 = "conv-002";

describe("proposal-persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("loadProposals", () => {
    it("returns empty object when nothing is stored", () => {
      expect(loadProposals(conv1)).toEqual({ goal: null, plan: null });
    });

    it("returns null for both fields when conversation has no entry", () => {
      saveGoalProposal(conv2, {
        goalId: "g-1",
        objective: "x",
        maxRounds: 5,
        tokensCap: 1000,
        autoRun: false,
      });
      // Different conversation — should be empty.
      expect(loadProposals(conv1)).toEqual({ goal: null, plan: null });
    });

    it("tolerates corrupt JSON in localStorage", () => {
      window.localStorage.setItem(`mathran.proposal.${conv1}`, "not json {{{");
      expect(loadProposals(conv1)).toEqual({ goal: null, plan: null });
    });
  });

  describe("saveGoalProposal", () => {
    it("persists and round-trips", () => {
      saveGoalProposal(conv1, {
        goalId: "g-1",
        objective: "do thing",
        maxRounds: 10,
        tokensCap: 2000,
        autoRun: true,
      });
      const got = loadProposals(conv1);
      expect(got.goal).not.toBeNull();
      expect(got.goal!.goalId).toBe("g-1");
      expect(got.goal!.objective).toBe("do thing");
      expect(got.goal!.maxRounds).toBe(10);
      expect(got.goal!.tokensCap).toBe(2000);
      expect(got.goal!.autoRun).toBe(true);
      expect(typeof got.goal!.ts).toBe("number");
    });

    it("clears when called with null", () => {
      saveGoalProposal(conv1, {
        goalId: "g-1",
        objective: "x",
        maxRounds: 5,
        tokensCap: null,
        autoRun: false,
      });
      expect(loadProposals(conv1).goal).not.toBeNull();
      saveGoalProposal(conv1, null);
      expect(loadProposals(conv1).goal).toBeNull();
    });

    it("preserves plan when clearing goal", () => {
      savePlanProposal(conv1, { planId: "p-1", objective: "plan", autoRun: false });
      saveGoalProposal(conv1, {
        goalId: "g-1",
        objective: "g",
        maxRounds: 5,
        tokensCap: null,
        autoRun: false,
      });
      saveGoalProposal(conv1, null);
      expect(loadProposals(conv1).plan).not.toBeNull();
      expect(loadProposals(conv1).goal).toBeNull();
    });
  });

  describe("savePlanProposal", () => {
    it("persists and round-trips", () => {
      savePlanProposal(conv1, { planId: "p-99", objective: "outline", autoRun: false });
      const got = loadProposals(conv1);
      expect(got.plan).not.toBeNull();
      expect(got.plan!.planId).toBe("p-99");
      expect(got.plan!.objective).toBe("outline");
      expect(got.plan!.autoRun).toBe(false);
    });

    it("clears when called with null", () => {
      savePlanProposal(conv1, { planId: "p-1", objective: "x", autoRun: true });
      savePlanProposal(conv1, null);
      expect(loadProposals(conv1).plan).toBeNull();
    });
  });

  describe("clearProposals", () => {
    it("removes both goal and plan", () => {
      saveGoalProposal(conv1, {
        goalId: "g-1",
        objective: "g",
        maxRounds: 5,
        tokensCap: null,
        autoRun: false,
      });
      savePlanProposal(conv1, { planId: "p-1", objective: "p", autoRun: false });
      clearProposals(conv1);
      expect(loadProposals(conv1)).toEqual({ goal: null, plan: null });
    });

    it("does not throw when nothing is stored", () => {
      expect(() => clearProposals("nonexistent")).not.toThrow();
    });
  });

  describe("TTL expiry (7 days)", () => {
    it("expires goal proposal after 7 days", () => {
      const TTL_MS = 7 * 24 * 60 * 60 * 1000;
      const baseTs = Date.now();
      saveGoalProposal(conv1, {
        goalId: "g-1",
        objective: "x",
        maxRounds: 5,
        tokensCap: null,
        autoRun: false,
      });
      // Fast-forward Date.now past TTL by mocking the global.
      vi.useFakeTimers();
      vi.setSystemTime(baseTs + TTL_MS + 1000);
      expect(loadProposals(conv1).goal).toBeNull();
    });

    it("expires plan proposal after 7 days", () => {
      const TTL_MS = 7 * 24 * 60 * 60 * 1000;
      const baseTs = Date.now();
      savePlanProposal(conv1, { planId: "p-1", objective: "x", autoRun: false });
      vi.useFakeTimers();
      vi.setSystemTime(baseTs + TTL_MS + 1000);
      expect(loadProposals(conv1).plan).toBeNull();
    });

    it("keeps proposal within TTL window", () => {
      const baseTs = Date.now();
      saveGoalProposal(conv1, {
        goalId: "g-1",
        objective: "x",
        maxRounds: 5,
        tokensCap: null,
        autoRun: false,
      });
      vi.useFakeTimers();
      vi.setSystemTime(baseTs + 6 * 24 * 60 * 60 * 1000); // 6 days
      expect(loadProposals(conv1).goal).not.toBeNull();
    });
  });

  describe("per-conversation isolation", () => {
    it("does not leak between conversations", () => {
      saveGoalProposal(conv1, {
        goalId: "g-A",
        objective: "A",
        maxRounds: 5,
        tokensCap: null,
        autoRun: false,
      });
      saveGoalProposal(conv2, {
        goalId: "g-B",
        objective: "B",
        maxRounds: 10,
        tokensCap: 999,
        autoRun: true,
      });
      const got1 = loadProposals(conv1);
      const got2 = loadProposals(conv2);
      expect(got1.goal!.goalId).toBe("g-A");
      expect(got2.goal!.goalId).toBe("g-B");
    });
  });
});
