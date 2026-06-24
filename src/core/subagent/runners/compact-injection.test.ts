/**
 * Tests for compact-injection — TODO-2 §9.1 / C2.
 *
 * Covers isRealUser (codex `is_summary_message` parity + mathran daemon
 * extension), injectionPolicyForPhase, and rebuildHistory's two policies
 * + 4 fallback layers (real user → any user/summary → append).
 */

import { describe, it, expect } from "vitest";
import type { LLMMessage } from "../../providers/llm.js";
import {
  isRealUser,
  injectionPolicyForPhase,
  rebuildHistory,
  COMPACT_SUMMARY_PREFIX,
  DAEMON_USER_PREFIX,
} from "./compact-injection.js";

const realUser = (text: string): LLMMessage => ({ role: "user", content: text });
const daemonUser = (text = "continue"): LLMMessage => ({ role: "user", content: `${DAEMON_USER_PREFIX} ${text}]` });
const summaryUser = (text: string): LLMMessage => ({ role: "user", content: `${COMPACT_SUMMARY_PREFIX}${text}` });
const sys = (text: string): LLMMessage => ({ role: "system", content: text });
const asst = (text: string): LLMMessage => ({ role: "assistant", content: text });
const tool = (text: string, name = "read_file"): LLMMessage => ({
  role: "tool",
  content: text,
  toolCallId: "call_x",
  name,
});

describe("isRealUser", () => {
  it("returns true for a plain user message", () => {
    expect(isRealUser(realUser("solve goldbach"))).toBe(true);
  });

  it("returns false for a compaction summary item (codex is_summary_message parity)", () => {
    expect(isRealUser(summaryUser("we covered X..."))).toBe(false);
  });

  it("returns false for a daemon synthetic user message (mathran extension)", () => {
    expect(isRealUser(daemonUser("continue"))).toBe(false);
    expect(isRealUser(daemonUser("steer"))).toBe(false);
  });

  it("returns false for assistant / tool / system messages", () => {
    expect(isRealUser(asst("ok"))).toBe(false);
    expect(isRealUser(tool("file content"))).toBe(false);
    expect(isRealUser(sys("you are mathran"))).toBe(false);
  });

  it("only treats role==='user' as candidate even if content matches prefix", () => {
    // a hypothetical assistant message whose body starts with [daemon: ...]
    // must still be classified by role, not content
    expect(isRealUser({ role: "assistant", content: `${DAEMON_USER_PREFIX} weirdness]` })).toBe(false);
  });

  it("treats non-string content (vision multimodal) as real user", () => {
    // content can be ContentPart[] in vision mode; predicate plays it safe:
    // since prefix-matching is impossible on an array, the message can never
    // be a summary item or daemon synthetic — it's a genuine vision message.
    const visionUser: LLMMessage = { role: "user", content: [] as unknown as string };
    expect(isRealUser(visionUser)).toBe(true);
  });
});

describe("injectionPolicyForPhase", () => {
  it("maps mid_turn to before_last_user_message", () => {
    expect(injectionPolicyForPhase("mid_turn")).toBe("before_last_user_message");
  });

  it("maps pre_turn, standalone, post_turn to do_not_inject", () => {
    expect(injectionPolicyForPhase("pre_turn")).toBe("do_not_inject");
    expect(injectionPolicyForPhase("standalone")).toBe("do_not_inject");
    expect(injectionPolicyForPhase("post_turn")).toBe("do_not_inject");
  });
});

describe("rebuildHistory", () => {
  describe("policy: do_not_inject", () => {
    it("places summary immediately after the system block", () => {
      const out = rebuildHistory({
        systemBlock: [sys("you are mathran")],
        tail: [realUser("hello"), asst("hi")],
        summary: "earlier work",
        policy: "do_not_inject",
      });

      expect(out.map(m => m.role)).toEqual(["system", "system", "user", "assistant"]);
      expect(out[0].content).toBe("you are mathran");
      expect(out[1].content).toBe(`${COMPACT_SUMMARY_PREFIX}earlier work`);
      expect(out[2].content).toBe("hello");
    });

    it("works with empty system block", () => {
      const out = rebuildHistory({
        systemBlock: [],
        tail: [realUser("hello")],
        summary: "earlier",
        policy: "do_not_inject",
      });
      expect(out.length).toBe(2);
      expect(out[0].role).toBe("system");
      expect(out[0].content).toBe(`${COMPACT_SUMMARY_PREFIX}earlier`);
    });
  });

  describe("policy: before_last_user_message", () => {
    it("inserts summary just above the last real user message", () => {
      const out = rebuildHistory({
        systemBlock: [sys("you are mathran")],
        tail: [
          realUser("first request"),
          asst("ok"),
          realUser("second request"),
          asst("working"),
        ],
        summary: "earlier",
        policy: "before_last_user_message",
      });

      // expected: [sys, user-first, asst, SUMMARY, user-second, asst-working]
      expect(out.map(m => m.role)).toEqual(["system", "user", "assistant", "system", "user", "assistant"]);
      expect(out[3].content).toBe(`${COMPACT_SUMMARY_PREFIX}earlier`);
      expect(out[4].content).toBe("second request");
    });

    it("falls back to last synthetic daemon user when no real user is present", () => {
      // tail has only a daemon synthetic user (long-running goal scenario)
      const out = rebuildHistory({
        systemBlock: [sys("you are mathran")],
        tail: [
          summaryUser("old summary"),
          asst("ok"),
          daemonUser("continue"),
          asst("working"),
        ],
        summary: "earlier",
        policy: "before_last_user_message",
      });

      // no real user → fall back to last user-or-summary (which is daemonUser)
      // expected: [sys, summary-old, asst, SUMMARY, daemon, asst]
      expect(out.length).toBe(6);
      expect(out[3].role).toBe("system");
      expect(out[3].content).toBe(`${COMPACT_SUMMARY_PREFIX}earlier`);
      expect(out[4].content).toBe(`${DAEMON_USER_PREFIX} continue]`);
    });

    it("falls back to last summary user when no real or daemon user", () => {
      const out = rebuildHistory({
        systemBlock: [sys("sys")],
        tail: [
          asst("hi"),
          summaryUser("prior summary"),
          asst("more"),
        ],
        summary: "even earlier",
        policy: "before_last_user_message",
      });

      // only user-role item in tail is the summaryUser; that's lastAnyUser
      // expected: [sys, asst, SUMMARY, summary-prior, asst]
      expect(out.length).toBe(5);
      expect(out[2].role).toBe("system");
      expect(out[2].content).toBe(`${COMPACT_SUMMARY_PREFIX}even earlier`);
      expect(out[3]).toEqual(summaryUser("prior summary"));
    });

    it("appends summary at end when tail has no user-role items at all", () => {
      const out = rebuildHistory({
        systemBlock: [sys("sys")],
        tail: [asst("alone"), tool("result")],
        summary: "earlier",
        policy: "before_last_user_message",
      });

      // no user/summary anywhere → append
      expect(out.length).toBe(4);
      expect(out[0]).toEqual(sys("sys"));
      expect(out[1]).toEqual(asst("alone"));
      expect(out[2]).toEqual(tool("result"));
      expect(out[3].role).toBe("system");
      expect(out[3].content).toBe(`${COMPACT_SUMMARY_PREFIX}earlier`);
    });

    it("prefers the last real user over a more recent daemon synthetic", () => {
      const out = rebuildHistory({
        systemBlock: [sys("sys")],
        tail: [
          realUser("my real request"),
          asst("ok"),
          tool("file content"),
          asst("more"),
          daemonUser("continue"),
          asst("auto-driven"),
        ],
        summary: "earlier",
        policy: "before_last_user_message",
      });

      // last REAL user is at index 0 of tail; lastAnyUser would be daemonUser
      // at index 4. Algorithm must pick real-user (index 0), per codex
      // "prefer last real user" semantics.
      // expected: [sys, SUMMARY, real-user, asst, tool, asst, daemon, asst]
      expect(out.length).toBe(8);
      expect(out[1].role).toBe("system");
      expect(out[1].content).toBe(`${COMPACT_SUMMARY_PREFIX}earlier`);
      expect(out[2]).toEqual(realUser("my real request"));
    });
  });

  it("returns clones, not aliases of input messages (no shared mutation)", () => {
    const inputUser = realUser("hello");
    const out = rebuildHistory({
      systemBlock: [],
      tail: [inputUser],
      summary: "x",
      policy: "do_not_inject",
    });
    // mutating output should not affect input
    out[1].content = "MUTATED";
    expect(inputUser.content).toBe("hello");
  });
});
