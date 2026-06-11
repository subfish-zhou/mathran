import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRunLogger } from "./run-logger";

// Mock DB and schema
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockExecute = vi.fn();
const mockWhere = vi.fn();
const mockSet = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();

const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
  execute: mockExecute,
} as any;

vi.mock("@/server/db/schema", () => ({
  agentRuns: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: vi.fn((...args: any[]) => args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: "run-123" }]);
  mockUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: mockWhere });
  mockWhere.mockResolvedValue(undefined);
  mockExecute.mockResolvedValue(undefined);
});

describe("AgentRunLogger", () => {
  it("creates a run record on start", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init", userId: "u1" });
    expect(logger.runId).toBe("run-123");
    expect(mockInsert).toHaveBeenCalled();
  });

  it("appends events", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    logger.appendEvent({ type: "log", message: "test" });
    // No flush yet (< 20 events)
  });

  it("flushes on every 20 events", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    for (let i = 0; i < 20; i++) {
      logger.appendEvent({ type: "log", message: `event ${i}` });
    }
    // Should have triggered a flush (update call)
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("completes a run", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    await logger.complete({ summary: "done" });
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("fails a run", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    await logger.fail("something broke");
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ status: "error", errorMessage: "something broke" }));
  });

  it("updates progress", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    await logger.updateProgress(50);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ progress: 50 }));
  });

  it("clamps progress to 0-100", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    await logger.updateProgress(150);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ progress: 100 }));
    await logger.updateProgress(-10);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ progress: 0 }));
  });

  it("saves checkpoint", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    await logger.saveCheckpoint("deep_crawl", { round: 3 });
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({
      checkpointPhase: "deep_crawl",
      checkpointData: JSON.stringify({ round: 3 }),
    }));
  });

  it("appendLog calls execute", async () => {
    const logger = await AgentRunLogger.start(mockDb, { agentType: "init" });
    await logger.appendLog("test message");
    expect(mockExecute).toHaveBeenCalled();
  });
});
