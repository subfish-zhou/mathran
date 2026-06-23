/**
 * ChatSession reasoning-effort wiring (#6): the session threads its current
 * effort level into every LLMRequest, and `/effort` (setEffort) changes it
 * live for the next turn. Acceptance #2 — `/effort max` in a session takes
 * effect on the next LLM call.
 */
import { describe, it, expect } from "vitest";
import { ChatSession } from "./session.js";
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
} from "../providers/llm.js";

class RecordingLLM implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  async describe() {
    return { name: "recording" };
  }
  async chat(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    return {
      stream: async function* (): AsyncIterable<LLMStreamChunk> {
        yield { type: "text", delta: "ok" };
        yield { type: "done", finishReason: "stop" };
      },
    };
  }
}

async function drain(session: ChatSession, msg: string): Promise<void> {
  for await (const _ of session.send(msg)) {
    /* consume */
  }
}

describe("ChatSession effort threading", () => {
  it("omits effort from the request when none is configured", async () => {
    const llm = new RecordingLLM();
    const session = new ChatSession({ llm, model: "m" });
    await drain(session, "hi");
    expect(llm.requests[0]!.effort).toBeUndefined();
  });

  it("threads the constructed effort into the request", async () => {
    const llm = new RecordingLLM();
    const session = new ChatSession({ llm, model: "m", effort: "high" });
    expect(session.getEffort()).toBe("high");
    await drain(session, "hi");
    expect(llm.requests[0]!.effort).toBe("high");
  });

  it("setEffort changes the level for the next turn (/effort max)", async () => {
    const llm = new RecordingLLM();
    const session = new ChatSession({ llm, model: "m", effort: "low" });
    await drain(session, "first");
    expect(llm.requests[0]!.effort).toBe("low");

    session.setEffort("max");
    await drain(session, "second");
    expect(llm.requests[1]!.effort).toBe("max");
  });

  it("setEffort(undefined) clears it", async () => {
    const llm = new RecordingLLM();
    const session = new ChatSession({ llm, model: "m", effort: "high" });
    session.setEffort(undefined);
    await drain(session, "hi");
    expect(llm.requests[0]!.effort).toBeUndefined();
  });
});
