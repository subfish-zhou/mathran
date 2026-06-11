import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 3.2 compaction hardening — #2 (transaction atomicity) + #3 (summary
 * merge, ≤1 live summary).
 *
 * These exercise `maybeCompactConversation` end-to-end against an in-memory
 * mock DB + a stubbed Azure LLM, asserting:
 *   • #2: the mark-isCompacted UPDATE and the insert-summary INSERT happen
 *         inside ONE `db.transaction`. If the INSERT throws, the whole thing
 *         rolls back — no row is left marked isCompacted without a summary, and
 *         the error propagates (never silently swallowed).
 *   • #3: a pre-existing (live) summary row is folded into the new summary
 *         (`[prior summary]:` transcript prefix) and marked isCompacted, so the
 *         count of live summary rows stays ≤ 1 across repeated compactions and
 *         no prior-summary content is lost.
 */

// ---- Mock the schema module to a plain column-name map (drizzle column refs) ----
vi.mock("@/server/db/schema", () => ({
  channelMessages: {
    id: "id",
    authorKind: "authorKind",
    content: "content",
    toolCallId: "toolCallId",
    toolResult: "toolResult",
    metadata: "metadata",
    isSummary: "isSummary",
    isCompacted: "isCompacted",
    channelId: "channelId",
    createdAt: "createdAt",
  },
}));

// drizzle-orm condition helpers are pure markers in our mock — return undefined.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  sql: Object.assign(
    (strings: TemplateStringsArray) => ({ __sql: strings.join("") }),
    {},
  ),
  inArray: vi.fn(),
}));

// Stub Azure LLM so summarization returns a deterministic string.
vi.mock("../azure-llm", () => ({
  DEFAULT_AZURE_MODEL: "gpt-test",
  logLLMUsage: vi.fn(),
  getAzureClient: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: "MERGED_SUMMARY" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })),
      },
    },
  })),
}));

vi.mock("../constants", () => ({
  COMPACTION_PROMPT_LIMIT: 12_000,
  MESSAGE_CONTENT_SLICE: 500,
}));

// ---- In-memory mock DB ----
type Row = {
  id: string;
  authorKind: string;
  content: string | null;
  toolCallId: string | null;
  toolResult: unknown;
  metadata: unknown;
  isSummary: boolean;
  isCompacted: boolean;
  channelId: string;
  createdAt: Date;
};

let store: Row[] = [];
let insertShouldThrow = false;
const ops: string[] = []; // ordered log of mutating ops (for atomicity assertions)

function selectBuilder() {
  // Mirrors db.select(cols).from(t).where(c).orderBy(o) — resolves to rows.
  const builder: any = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    // thenable so `await` resolves to the live (non-compacted) rows in order.
    then: (resolve: (rows: any[]) => void) => {
      const rows = store
        .filter((r) => !r.isCompacted)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        // compaction.ts selects `role: channelMessages.authorKind` (aliased).
        .map((r) => ({ ...r, role: r.authorKind }));
      resolve(rows);
    },
  };
  return builder;
}

function updateBuilder(target: { aborted: boolean }) {
  let pendingIds: string[] = [];
  const builder: any = {
    set: () => builder,
    where: () => {
      // The compaction UPDATE marks idsToCompact isCompacted=true. We capture
      // them via a module-level "next update ids" channel set by the caller.
      pendingIds = pendingUpdateIds;
      return builder;
    },
    then: (resolve: () => void) => {
      if (!target.aborted) {
        for (const r of store) {
          if (pendingIds.includes(r.id)) r.isCompacted = true;
        }
        ops.push(`update:${pendingIds.join(",")}`);
      }
      resolve();
    },
  };
  return builder;
}

function insertBuilder(target: { aborted: boolean }) {
  const builder: any = {
    values: (vals: any) => ({
      then: (resolve: () => void, reject: (e: unknown) => void) => {
        if (insertShouldThrow) {
          target.aborted = true;
          reject(new Error("INSERT_FAILED"));
          return;
        }
        store.push({
          id: `summary-${store.length}`,
          authorKind: vals.authorKind,
          content: vals.content,
          toolCallId: null,
          toolResult: null,
          metadata: null,
          isSummary: vals.isSummary ?? false,
          isCompacted: false,
          channelId: vals.channelId,
          createdAt: new Date(),
        });
        ops.push("insert:summary");
        resolve();
      },
    }),
  };
  return builder;
}

// The UPDATE .where() needs the ids the compaction computed. compaction.ts
// builds `idsToCompact` then calls update; we can't see them directly through
// the mock, so we recompute the same set the moment update runs: all live
// rows EXCEPT the kept tail. Simpler: capture via a transaction-scoped hook.
let pendingUpdateIds: string[] = [];

function makeDb() {
  return {
    select: () => selectBuilder(),
    // Non-transactional update/insert should NOT be used by the new code, but
    // provide them so accidental use is observable (they'd push ops without a
    // tx wrapper). We point them at a never-aborted target.
    update: () => updateBuilder({ aborted: false }),
    insert: () => insertBuilder({ aborted: false }),
    transaction: async (cb: (tx: any) => Promise<void>) => {
      const target = { aborted: false };
      const snapshot = JSON.parse(JSON.stringify(store.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))));
      const tx = {
        update: () => updateBuilder(target),
        insert: () => insertBuilder(target),
      };
      try {
        await cb(tx);
      } catch (e) {
        // Roll back: restore snapshot.
        store = snapshot.map((r: any) => ({ ...r, createdAt: new Date(r.createdAt) }));
        throw e;
      }
    },
  };
}

vi.mock("@/server/db", () => ({
  getDb: vi.fn(() => makeDb()),
}));

// Import AFTER mocks are registered.
import { maybeCompactConversation, rowTokens, snapToTurnStart } from "./compaction";

function mkRow(partial: Partial<Row> & { id: string; createdAt: Date }): Row {
  return {
    authorKind: "user",
    content: "x",
    toolCallId: null,
    toolResult: null,
    metadata: null,
    isSummary: false,
    isCompacted: false,
    channelId: "chan-1",
    ...partial,
  };
}

// Build a long enough conversation (> MESSAGE_COUNT_THRESHOLD=50) so compaction
// fires, with a turn structure that snaps cleanly and keeps a recent tail.
function seedConversation(opts: { withPriorSummary?: boolean } = {}) {
  store = [];
  ops.length = 0;
  let t = 0;
  const next = () => new Date(2026, 0, 1, 0, 0, t++);

  if (opts.withPriorSummary) {
    store.push(
      mkRow({
        id: "prior-sum",
        authorKind: "assistant",
        content: "OLD_SUMMARY_CONTENT",
        isSummary: true,
        createdAt: next(),
      }),
    );
  }
  // 60 turns of [user, assistant] = 120 rows. Content is padded large enough
  // that the running token total exceeds TARGET_TOKEN_BUDGET (40k), so the
  // backward-keep walk stops partway and toCompact is a real (≥5 row) prefix of
  // whole turns — not just the leading summary.
  const pad = "lorem ipsum dolor sit amet ".repeat(120); // ~ hundreds of tokens
  for (let i = 0; i < 60; i++) {
    store.push(mkRow({ id: `u${i}`, authorKind: "user", content: `question ${i} ${pad}`, createdAt: next() }));
    store.push(mkRow({ id: `a${i}`, authorKind: "assistant", content: `answer ${i} ${pad}`, createdAt: next() }));
  }
}

// Recompute idsToCompact EXACTLY as compaction.ts does, using the same exported
// rowTokens / snapToTurnStart primitives, so updateBuilder marks the right rows.
function expectedCompactedIds(): string[] {
  const live = store
    .filter((r) => !r.isCompacted)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((r) => ({ ...r, role: r.authorKind }));
  const TARGET = 40_000;
  let kept = 0;
  let keepFromIndex = live.length;
  for (let i = live.length - 1; i >= 0; i--) {
    const tok = rowTokens(live[i] as any);
    if (kept + tok > TARGET) break;
    kept += tok;
    keepFromIndex = i;
  }
  keepFromIndex = snapToTurnStart(live as any, keepFromIndex);
  return live.slice(0, keepFromIndex).map((r) => r.id);
}

describe("maybeCompactConversation — #2 transaction atomicity", () => {
  beforeEach(() => {
    insertShouldThrow = false;
  });

  it("commits mark-isCompacted + insert-summary together (happy path)", async () => {
    seedConversation();
    pendingUpdateIds = expectedCompactedIds();

    await maybeCompactConversation("chan-1", "topic-1", "asst-1");

    // A summary row was inserted (live, isSummary).
    const liveSummaries = store.filter((r) => r.isSummary && !r.isCompacted);
    expect(liveSummaries).toHaveLength(1);
    expect(liveSummaries[0]!.content).toContain("MERGED_SUMMARY");
    // The compacted ids are now marked.
    expect(pendingUpdateIds.length).toBeGreaterThan(0);
    for (const id of pendingUpdateIds) {
      expect(store.find((r) => r.id === id)!.isCompacted).toBe(true);
    }
    // Ordered within ONE transaction: update precedes insert.
    expect(ops).toEqual([`update:${pendingUpdateIds.join(",")}`, "insert:summary"]);
  });

  it("rolls back the UPDATE when the INSERT fails — no orphan compacted rows", async () => {
    seedConversation();
    pendingUpdateIds = expectedCompactedIds();
    insertShouldThrow = true;

    // The transaction must REJECT (error propagates, not swallowed).
    await expect(
      maybeCompactConversation("chan-1", "topic-1", "asst-1"),
    ).rejects.toThrow("INSERT_FAILED");

    // Rollback: NONE of the would-be-compacted rows are marked, and no summary
    // exists. This is the data-loss guard: never "compacted but no summary".
    for (const id of pendingUpdateIds) {
      expect(store.find((r) => r.id === id)!.isCompacted).toBe(false);
    }
    expect(store.filter((r) => r.isSummary)).toHaveLength(0);
  });
});

describe("maybeCompactConversation — #3 summary merge (≤1 live summary)", () => {
  beforeEach(() => {
    insertShouldThrow = false;
  });

  it("folds a prior summary into the new one and keeps live summaries ≤ 1", async () => {
    seedConversation({ withPriorSummary: true });
    // idsToCompact now includes the prior summary id (it's the oldest live row,
    // before the first user row → in toCompact prefix).
    pendingUpdateIds = expectedCompactedIds();
    expect(pendingUpdateIds).toContain("prior-sum");

    await maybeCompactConversation("chan-1", "topic-1", "asst-1");

    // Old summary is now compacted (folded), exactly one live summary remains.
    expect(store.find((r) => r.id === "prior-sum")!.isCompacted).toBe(true);
    const liveSummaries = store.filter((r) => r.isSummary && !r.isCompacted);
    expect(liveSummaries).toHaveLength(1);
    expect(liveSummaries[0]!.id).not.toBe("prior-sum");
  });

  it("transcript labels the prior summary as [prior summary] (content not lost)", async () => {
    seedConversation({ withPriorSummary: true });
    pendingUpdateIds = expectedCompactedIds();

    const { getAzureClient } = await import("../azure-llm");
    const created: any[] = [];
    (getAzureClient as any).mockReturnValueOnce({
      chat: {
        completions: {
          create: vi.fn(async (req: any) => {
            created.push(req);
            return {
              choices: [{ message: { content: "MERGED_SUMMARY" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          }),
        },
      },
    });

    await maybeCompactConversation("chan-1", "topic-1", "asst-1");

    const transcript = created[0]!.messages[1]!.content as string;
    expect(transcript).toContain("[prior summary]: OLD_SUMMARY_CONTENT");
    // Regular rows still labelled by role, not as prior summary.
    expect(transcript).toContain("[user]: question 0");
  });
});
