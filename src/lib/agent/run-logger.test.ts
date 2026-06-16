import { describe, it, expect, beforeEach } from "vitest";
import { AgentRunLogger } from "./run-logger";
import { InMemoryStorage } from "../../providers/storage/in-memory";

type Payload = Record<string, unknown>;

let storage: InMemoryStorage;

beforeEach(() => {
  storage = new InMemoryStorage();
});

async function payloadOf(runId: string): Promise<Payload> {
  const rec = await storage.getRun(runId);
  expect(rec).not.toBeNull();
  return rec!.payload as Payload;
}

describe("AgentRunLogger", () => {
  it("creates a run record on start", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init", userId: "u1" });
    expect(logger.runId).toBeTruthy();
    const rec = await storage.getRun(logger.runId);
    expect(rec?.status).toBe("running");
    expect((rec?.payload as Payload).agentType).toBe("init");
    expect((rec?.payload as Payload).userId).toBe("u1");
  });

  it("buffers events without flushing before the batch threshold", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    for (let i = 0; i < 9; i++) {
      logger.appendEvent({ type: "log", message: `event ${i}` });
    }
    // Below the every-10 threshold, nothing is flushed yet.
    expect((await payloadOf(logger.runId)).eventCount).toBe(0);
  });

  it("flushes on every 10 events", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    for (let i = 0; i < 10; i++) {
      logger.appendEvent({ type: "log", message: `event ${i}` });
    }
    // Allow the fire-and-forget flush() promise to settle.
    await new Promise((r) => setTimeout(r, 0));
    const payload = await payloadOf(logger.runId);
    expect(payload.eventCount).toBe(10);
    expect((payload.events as unknown[]).length).toBe(10);
  });

  it("completes a run", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    await logger.complete({ summary: "done" });
    const rec = await storage.getRun(logger.runId);
    expect(rec?.status).toBe("completed");
    expect((rec?.payload as Payload).resultSummary).toEqual({ summary: "done" });
  });

  it("fails a run", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    await logger.fail("something broke");
    const rec = await storage.getRun(logger.runId);
    expect(rec?.status).toBe("failed");
    expect((rec?.payload as Payload).errorMessage).toBe("something broke");
  });

  it("updates progress", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    await logger.updateProgress(50);
    expect((await payloadOf(logger.runId)).progress).toBe(50);
  });

  it("clamps progress to 0-100", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    await logger.updateProgress(150);
    expect((await payloadOf(logger.runId)).progress).toBe(100);
    await logger.updateProgress(-10);
    expect((await payloadOf(logger.runId)).progress).toBe(0);
  });

  it("saves checkpoint", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    await logger.saveCheckpoint("deep_crawl", { round: 3 });
    const payload = await payloadOf(logger.runId);
    expect(payload.checkpointPhase).toBe("deep_crawl");
    expect(payload.checkpointData).toEqual({ round: 3 });
  });

  it("appendLog persists a (truncated) log line", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    await logger.appendLog("test message");
    expect((await payloadOf(logger.runId)).logs).toEqual(["test message"]);

    await logger.appendLog("x".repeat(5000));
    const logs = (await payloadOf(logger.runId)).logs as string[];
    expect(logs.length).toBe(2);
    expect(logs[1]!.length).toBe(4094);
    expect(logs[1]!.endsWith("…")).toBe(true);
  });

  it("fromExistingAsync seeds the event buffer from storage", async () => {
    const logger = await AgentRunLogger.start(storage, { agentType: "init" });
    for (let i = 0; i < 10; i++) logger.appendEvent({ i });
    await new Promise((r) => setTimeout(r, 0));

    const resumed = await AgentRunLogger.fromExistingAsync(storage, logger.runId);
    resumed.appendEvent({ i: 10 });
    await resumed.complete();

    const payload = await payloadOf(logger.runId);
    expect(payload.eventCount).toBe(11);
    expect((payload.events as unknown[]).length).toBe(11);
  });
});
