/**
 * Tests for compact-strategies — TODO-2 §9.1 / C3.
 *
 * Covers the dispatcher registry: pickStrategy precedence, supports()
 * filtering, error when no strategy matches, ensureBuiltInsRegistered
 * idempotency, and test-only reset.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { LLMMessage, LLMProvider } from "../../providers/llm.js";
import type {
  CompactionRequest,
  CompactionOutcome,
  CompactionStatus,
} from "./compact-types.js";
import {
  registerCompactionStrategy,
  pickStrategy,
  registeredStrategyNames,
  ensureBuiltInsRegistered,
  _resetStrategiesForTest,
  type CompactionStrategyImpl,
} from "./compact-strategies.js";

class StubStrategy implements CompactionStrategyImpl {
  constructor(
    readonly name: string,
    private readonly supportsFn: (req: CompactionRequest) => boolean = () => true,
  ) {}
  supports(req: CompactionRequest): boolean {
    return this.supportsFn(req);
  }
  async run(_req: CompactionRequest): Promise<CompactionOutcome> {
    return {
      ok: true,
      status: "ok" as CompactionStatus,
      newMessages: [],
      summaryText: "",
      telemetry: {
        reason: _req.reason,
        phase: _req.phase,
        trigger: _req.trigger,
        policy: _req.policy,
        strategy: this.name,
        startedAtMs: 0,
        endedAtMs: 0,
        durationMs: 0,
        status: "ok",
        originalTokens: 0,
        newTokens: 0,
        droppedRoundCount: 0,
        retryAttempts: 0,
      },
    };
  }
}

function fakeReq(): CompactionRequest {
  const llm: LLMProvider = {
    async describe() { return { name: "fake" }; },
    async *stream() { /* unused */ },
    chat: (async () => { throw new Error("not used"); }) as unknown as LLMProvider["chat"],
  } as unknown as LLMProvider;
  const messages: LLMMessage[] = [{ role: "user", content: "x" }];
  return {
    messages,
    reason: "budget_exceeded",
    phase: "pre_turn",
    trigger: "auto",
    policy: "do_not_inject",
    llm,
  };
}

describe("compact-strategies dispatcher", () => {
  beforeEach(() => {
    _resetStrategiesForTest();
  });

  it("pickStrategy returns the only registered strategy", () => {
    registerCompactionStrategy(new StubStrategy("local"));
    expect(pickStrategy(fakeReq()).name).toBe("local");
  });

  it("pickStrategy returns the most recently registered (plugin overrides built-in)", () => {
    registerCompactionStrategy(new StubStrategy("local")); // built-in first
    registerCompactionStrategy(new StubStrategy("plugin")); // plugin second
    // unshift semantics: 'plugin' is at index 0 → picked first
    expect(pickStrategy(fakeReq()).name).toBe("plugin");
  });

  it("pickStrategy skips strategies whose supports() returns false", () => {
    registerCompactionStrategy(new StubStrategy("only-mid-turn", (req) => req.phase === "mid_turn"));
    registerCompactionStrategy(new StubStrategy("catch-all"));
    // catch-all was registered LATER → unshift → at index 0 → picked first.
    // (Verifies supports() doesn't even need to fire when an earlier strategy claims it.)
    const req = fakeReq(); // phase: pre_turn
    expect(pickStrategy(req).name).toBe("catch-all");
  });

  it("pickStrategy falls through to a later strategy when the earlier declines", () => {
    // Register catch-all FIRST so it ends up at the END of the list (unshift =>
    // first-registered is last in the array). Then register only-mid-turn,
    // which ends up at the front of the array. For a pre_turn request, only-mid-turn
    // declines (supports → false), so we fall through to catch-all.
    registerCompactionStrategy(new StubStrategy("catch-all"));
    registerCompactionStrategy(new StubStrategy("only-mid-turn", (req) => req.phase === "mid_turn"));
    expect(pickStrategy(fakeReq()).name).toBe("catch-all"); // pre_turn falls through
  });

  it("pickStrategy throws a helpful error when no strategy is registered", () => {
    expect(() => pickStrategy(fakeReq())).toThrow(/no strategy supports/);
  });

  it("pickStrategy throws when all registered strategies decline", () => {
    registerCompactionStrategy(new StubStrategy("only-mid-turn", (req) => req.phase === "mid_turn"));
    const req = fakeReq(); // pre_turn — no match
    expect(() => pickStrategy(req)).toThrow(/no strategy supports/);
  });

  it("registeredStrategyNames reports the registered list in lookup order", () => {
    registerCompactionStrategy(new StubStrategy("first-registered"));
    registerCompactionStrategy(new StubStrategy("second-registered"));
    expect(registeredStrategyNames()).toEqual(["second-registered", "first-registered"]);
  });

  it("ensureBuiltInsRegistered registers exactly once", () => {
    let factoryCalls = 0;
    const factory = (): CompactionStrategyImpl => {
      factoryCalls++;
      return new StubStrategy("local");
    };
    ensureBuiltInsRegistered(factory);
    ensureBuiltInsRegistered(factory);
    ensureBuiltInsRegistered(factory);
    expect(factoryCalls).toBe(1);
    expect(registeredStrategyNames()).toEqual(["local"]);
  });

  it("_resetStrategiesForTest clears the registry AND the built-ins flag", () => {
    let factoryCalls = 0;
    const factory = (): CompactionStrategyImpl => {
      factoryCalls++;
      return new StubStrategy("local");
    };
    ensureBuiltInsRegistered(factory);
    _resetStrategiesForTest();
    expect(registeredStrategyNames()).toEqual([]);
    ensureBuiltInsRegistered(factory);
    expect(factoryCalls).toBe(2); // ran again after reset
  });
});
