/**
 * Goal-supervisor summarizer agent (design §5.1, §2.3).
 *
 * NOT a single `chatCompletion` call. A long math-research thinking chain can't
 * be captured by `slice(-1500)` — so this is a map-reduce summarizer:
 *
 *   hourly:  read the run's channel_messages for [periodStart, periodEnd)
 *            → MAP: chunk the turns into windows, summarize each chunk
 *            → REDUCE: fold chunk summaries into one structured hourly summary
 *            → persist `assistant_goal_summaries` (level='hourly')
 *
 *   daily:   read the day's hourly summaries (already condensed, ~24 short blocks)
 *            → REDUCE: fold into one structured daily summary
 *            → persist `assistant_goal_summaries` (level='daily')
 *
 * Structured output (NOT a flat transcript): 目标 / 已完成(带证据指针) /
 * 进行中 / 卡点 / 下一步.
 *
 * Driven by the `/api/cron/goal-watch` sweep (not bound to a live loop), so a
 * dead/closed worker no longer takes the summary down with it.
 */

import { getDb } from "@/server/db";
import {
  conversations,
  channelMessages,
} from "@/server/db/schema";
import { assistantGoalSummaries } from "@/server/db/schema/assistant_goal";
import { and, eq, gte, lt, asc, desc } from "drizzle-orm";
import { LLMRouter } from "@/lib/agent/llm-router";
import type { ChatChunk } from "@/lib/agent/llm-provider";
import { getRun } from "./run-state";

/** Max turns fed into a single MAP chunk before it's split. */
const CHUNK_SIZE = 25;
/** Cap on total turns pulled for one hourly window (defensive). */
const MAX_TURNS_PER_HOUR = 600;
/** Token budget per MAP chunk summary. */
const MAP_MAX_TOKENS = 500;
/** Token budget for the REDUCE (final structured) summary. */
const REDUCE_MAX_TOKENS = 900;

const STRUCT_INSTRUCTION =
  "你是一个数学研究进度摘要器。请用中文输出**结构化**摘要，严格按以下五节，每节用 markdown 小标题：\n" +
  "## 目标\n## 已完成（附证据指针，如消息/文件/迭代号）\n## 进行中\n## 卡点\n## 下一步\n" +
  "要点：吸收完整思考链、按状态进展整理、不要流水账、不要逐条复述对话。没有内容的节写「（无）」。";

type TurnRow = {
  id: string;
  authorKind: string;
  content: string;
  toolName: string | null;
  toolStatus: string | null;
  createdAt: Date;
};

/** Resolve the channelId for a run's conversation (summaries read its turns). */
async function resolveChannelId(conversationId: string): Promise<string | null> {
  const db = getDb();
  const [conv] = await db
    .select({ channelId: conversations.channelId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return conv?.channelId ?? null;
}

/** Render a turn into a compact text line for the MAP prompt. */
function renderTurn(t: TurnRow): string {
  const who =
    t.authorKind === "user"
      ? "用户"
      : t.authorKind === "assistant" || t.authorKind === "bot"
        ? "助手"
        : t.authorKind === "tool"
          ? `工具${t.toolName ? `:${t.toolName}` : ""}${t.toolStatus ? `(${t.toolStatus})` : ""}`
          : t.authorKind;
  // Trim each turn so one runaway turn can't blow the chunk budget.
  const body = (t.content ?? "").slice(0, 4000);
  return `[${who}] ${body}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function collect(stream: AsyncIterable<ChatChunk>): Promise<string> {
  let acc = "";
  for await (const chunkResp of stream) {
    const d = chunkResp.choices?.[0]?.delta?.content;
    if (d) acc += d;
  }
  return acc.trim();
}

/**
 * Shared MAP-REDUCE core: given the turns of a window, produce ONE structured
 * summary. Factored out of generateHourlySummary so the hourly and milestone
 * (run-window) paths don't duplicate ~90 lines. `headerHint` (optional) is
 * prepended to the REDUCE user prompt to label the summary kind (e.g. milestone
 * "阶段性进展" vs "停止时总结"). Returns null if nothing usable.
 */
async function summarizeWindow(
  runId: string,
  objective: string,
  turns: TurnRow[],
  opts?: { headerHint?: string },
): Promise<string | null> {
  if (turns.length === 0) return null;

  const router = new LLMRouter();
  const model = router.defaultModel;

  // ── MAP: summarize each chunk of turns ───────────────────────────────────
  const chunks = chunk(turns, CHUNK_SIZE);
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const lines = chunks[i].map(renderTurn).join("\n");
    try {
      const s = await collect(
        router.chatCompletion({
          model,
          messages: [
            {
              role: "system" as const,
              content:
                "你是数学研究摘要器。把这一段对话/工具记录压缩成要点（中文），保留关键结论、证据指针、卡点。不超过 8 行。",
            },
            {
              role: "user" as const,
              content: `目标：${objective}\n\n第 ${i + 1}/${chunks.length} 段记录：\n${lines}`,
            },
          ],
          maxTokens: MAP_MAX_TOKENS,
        }),
      );
      if (s) chunkSummaries.push(`【段${i + 1}】${s}`);
    } catch (err) {
      console.warn(`[summarizer] map chunk ${i} failed for run ${runId}:`, err);
    }
  }

  let reduceInput: string;
  if (chunkSummaries.length === 0) {
    reduceInput = turns.map(renderTurn).join("\n").slice(0, 12000);
  } else {
    reduceInput = chunkSummaries.join("\n\n");
  }

  // ── REDUCE: fold chunk summaries into one structured summary ──────────────
  const headerHint = opts?.headerHint ? `${opts.headerHint}\n\n` : "";
  let final: string;
  try {
    final = await collect(
      router.chatCompletion({
        model,
        messages: [
          { role: "system" as const, content: STRUCT_INSTRUCTION },
          {
            role: "user" as const,
            content: `${headerHint}目标：${objective}\n\n本窗口各段要点：\n${reduceInput}`,
          },
        ],
        maxTokens: REDUCE_MAX_TOKENS,
      }),
    );
  } catch (err) {
    console.warn(`[summarizer] reduce failed for run ${runId}:`, err);
    final = reduceInput.slice(0, 4000);
  }
  return final || null;
}

/**
 * Generate (and persist) an hourly summary for a run over [periodStart,
 * periodEnd). Returns the summary text, or null if there was nothing to
 * summarize (no turns in the window) — caller may skip persistence/notify.
 */
export async function generateHourlySummary(
  runId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<string | null> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || !run.conversationId) return null;

  const channelId = await resolveChannelId(run.conversationId);
  if (!channelId) return null;

  const turns = (await db
    .select({
      id: channelMessages.id,
      authorKind: channelMessages.authorKind,
      content: channelMessages.content,
      toolName: channelMessages.toolName,
      toolStatus: channelMessages.toolStatus,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        gte(channelMessages.createdAt, periodStart),
        lt(channelMessages.createdAt, periodEnd),
      ),
    )
    .orderBy(asc(channelMessages.createdAt))
    .limit(MAX_TURNS_PER_HOUR)) as TurnRow[];

  if (turns.length === 0) return null;

  const objective = run.objective ?? "(未记录)";
  const final = await summarizeWindow(runId, objective, turns);
  if (!final) return null;

  await db.insert(assistantGoalSummaries).values({
    runId,
    level: "hourly",
    periodStart,
    periodEnd,
    content: final,
  });

  return final;
}

/**
 * Generate (and persist) a daily summary for a run over [dayStart, dayEnd) by
 * REDUCING that day's hourly summaries (already condensed). Returns text or
 * null if there were no hourly summaries to aggregate.
 */
export async function generateDailySummary(
  runId: string,
  dayStart: Date,
  dayEnd: Date,
): Promise<string | null> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run) return null;

  const hourlies = await db
    .select({
      content: assistantGoalSummaries.content,
      periodStart: assistantGoalSummaries.periodStart,
    })
    .from(assistantGoalSummaries)
    .where(
      and(
        eq(assistantGoalSummaries.runId, runId),
        eq(assistantGoalSummaries.level, "hourly"),
        gte(assistantGoalSummaries.periodStart, dayStart),
        lt(assistantGoalSummaries.periodStart, dayEnd),
      ),
    )
    .orderBy(asc(assistantGoalSummaries.periodStart));

  if (hourlies.length === 0) return null;

  const router = new LLMRouter();
  const model = router.defaultModel;
  const objective = run.objective ?? "(未记录)";
  const blocks = hourlies
    .map((h, i) => `【${i + 1} 时段】${h.content}`)
    .join("\n\n");

  let final: string;
  try {
    final = await collect(
      router.chatCompletion({
        model,
        messages: [
          { role: "system" as const, content: STRUCT_INSTRUCTION },
          {
            role: "user" as const,
            content:
              `目标：${objective}\n\n今天 ${hourlies.length} 个小时级摘要（已浓缩）：\n${blocks}\n\n` +
              "请聚合成今天的整体进展（同样五节结构）。重点突出跨时段的累积进展与仍未解决的卡点。",
          },
        ],
        maxTokens: REDUCE_MAX_TOKENS,
      }),
    );
  } catch (err) {
    console.warn(`[summarizer] daily reduce failed for run ${runId}:`, err);
    final = blocks.slice(0, 6000);
  }
  if (!final) return null;

  await db.insert(assistantGoalSummaries).values({
    runId,
    level: "daily",
    periodStart: dayStart,
    periodEnd: dayEnd,
    content: final,
  });

  return final;
}

/** Map a stopKind to a short Chinese label for the milestone header hint. */
function stopKindLabel(stopKind?: string): string {
  switch (stopKind) {
    case "complete": return "目标已完成";
    case "needs_decision": return "需要用户决策";
    case "max_rounds": return "达到轮次上限（可继续）";
    case "error": return "出错停止";
    default: return stopKind ?? "停止";
  }
}

/**
 * Generate (and persist) a milestone (run-window) summary for a run (design
 * §3.2). Reuses the same MAP-REDUCE core as generateHourlySummary via
 * summarizeWindow, but windows over the RUN since the last milestone summary
 * (or run start) and persists level='milestone'. Fires periodically (D1) inside
 * the goal-run outer loop and once at every intentional stop (D2). Returns the
 * summary text, or null if there was nothing new to summarize.
 */
export async function generateRunSummary(
  runId: string,
  level: "milestone",
  opts?: { round?: number; stopKind?: string },
): Promise<string | null> {
  const db = getDb();
  const run = await getRun(runId);
  if (!run || !run.conversationId) return null;

  const channelId = await resolveChannelId(run.conversationId);
  if (!channelId) return null;

  // Window = [previous milestone end ?? run start, now]. Summarize only the NEW
  // turns since the last milestone so periodic summaries don't re-chew the whole
  // run each time (keeps cost + rebuilt context bounded).
  const prev = await latestMilestoneSummary(runId);
  const periodStart = prev?.periodEnd ?? run.startedAt;
  const periodEnd = new Date();

  const turns = (await db
    .select({
      id: channelMessages.id,
      authorKind: channelMessages.authorKind,
      content: channelMessages.content,
      toolName: channelMessages.toolName,
      toolStatus: channelMessages.toolStatus,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        gte(channelMessages.createdAt, periodStart),
        lt(channelMessages.createdAt, periodEnd),
      ),
    )
    .orderBy(asc(channelMessages.createdAt))
    .limit(MAX_TURNS_PER_HOUR)) as TurnRow[];

  if (turns.length === 0) return null;

  const objective = run.objective ?? "(未记录)";
  const headerHint = opts?.stopKind
    ? `这是一次【停止时总结】（原因：${stopKindLabel(opts.stopKind)}，已完成 ${opts?.round ?? "?"} 轮）。`
    : `这是第 ${opts?.round ?? "?"} 轮的【阶段性进展总结】。`;

  const final = await summarizeWindow(runId, objective, turns, { headerHint });
  if (!final) return null;

  await db.insert(assistantGoalSummaries).values({
    runId,
    level: "milestone",
    periodStart,
    periodEnd,
    content: final,
  });
  return final;
}

/**
 * Whether an hourly summary already exists for a run covering a given hour
 * boundary (idempotency guard — a sweep may run more than once per hour).
 */
export async function hasHourlySummaryFor(
  runId: string,
  periodStart: Date,
): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: assistantGoalSummaries.id })
    .from(assistantGoalSummaries)
    .where(
      and(
        eq(assistantGoalSummaries.runId, runId),
        eq(assistantGoalSummaries.level, "hourly"),
        eq(assistantGoalSummaries.periodStart, periodStart),
      ),
    )
    .limit(1);
  return !!row;
}

/** Same idempotency guard for daily summaries. */
export async function hasDailySummaryFor(
  runId: string,
  dayStart: Date,
): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: assistantGoalSummaries.id })
    .from(assistantGoalSummaries)
    .where(
      and(
        eq(assistantGoalSummaries.runId, runId),
        eq(assistantGoalSummaries.level, "daily"),
        eq(assistantGoalSummaries.periodStart, dayStart),
      ),
    )
    .limit(1);
  return !!row;
}

/** Most-recent summary (any level) for a run — used by callers that surface it. */
export async function latestSummary(
  runId: string,
): Promise<typeof assistantGoalSummaries.$inferSelect | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(assistantGoalSummaries)
    .where(eq(assistantGoalSummaries.runId, runId))
    .orderBy(desc(assistantGoalSummaries.createdAt))
    .limit(1);
  return row ?? null;
}

/** Most-recent milestone summary for a run (run-window summaries). */
export async function latestMilestoneSummary(
  runId: string,
): Promise<typeof assistantGoalSummaries.$inferSelect | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(assistantGoalSummaries)
    .where(
      and(
        eq(assistantGoalSummaries.runId, runId),
        eq(assistantGoalSummaries.level, "milestone"),
      ),
    )
    .orderBy(desc(assistantGoalSummaries.createdAt))
    .limit(1);
  return row ?? null;
}
