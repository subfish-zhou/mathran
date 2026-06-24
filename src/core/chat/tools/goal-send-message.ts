/**
 * goal_send_message — chat-mode tool that injects a steer message into
 * an existing long-running goal.
 *
 * Background (v0.18, June 2026 incident): a user wanted to update the
 * direction of a goal that was already running (mid-search) from inside
 * the chat conversation that originally spawned it. Until this tool
 * existed, the only options were:
 *
 *   (a) Call the goal HTTP API directly (`POST /api/goals/:id/steer`).
 *       This works but bypasses the chat conversation entirely — the
 *       chat history shows no record of the user's intervention, so the
 *       chat LLM has no context for what's happening in the background
 *       goal next time the user comes back.
 *
 *   (b) `propose_goal` again. This creates a SECOND goal record,
 *       leaving the first one orphaned. Wrong — we want to steer the
 *       existing goal, not fork.
 *
 * This tool gives chat mode the (a) capability while keeping the chat
 * transcript honest about what was done. It is the chat-side mirror of
 * the goal runner's live-steering probe (`src/server/steer-registry.ts`).
 *
 * Behaviour:
 *
 *   1. Look up the goal. If not found, return `ok:false`.
 *   2. Look up the goal's primary conversation (the goal-mode internal
 *      conversation, NOT the chat conversation calling this tool).
 *   3. `setPendingSteer(goalConversationId, message)`. The goal runner's
 *      round-top probe will inject it as `[Steer from user: …]` on the
 *      NEXT round.
 *   4. If the goal currently has an active stream, the message will be
 *      picked up automatically at the next round boundary.
 *   5. If the goal stream is idle OR the goal is in `failed` status, the
 *      tool can optionally KICK it via the host-provided `autoRunner`
 *      callback (fire-and-forget, same path propose_goal uses), and for
 *      `failed` goals also resurrect status to `active`.
 *
 * The tool intentionally does NOT block waiting for the steer to be
 * consumed — that would tie the chat round to the goal round duration,
 * which can be minutes. It returns immediately with `{queued: true}`
 * and the chat round completes. The user will see the steer take effect
 * the next time they look at the goal panel (or via SSE events the SPA
 * surfaces).
 */

import { hasActiveStream, setPendingSteer } from "../../../server/steer-registry.js";
import { listGoals, readGoal, appendStep, writeGoal } from "../../goal/store.js";
import type { ToolSpec, ToolExecuteContext } from "../session.js";

const DESCRIPTION =
  "Inject a user-style steer message into an existing long-running goal. " +
  "Use when the user wants to update the direction of, give new information " +
  "to, or course-correct a goal that is currently running in the background " +
  "(or that was paused/failed and needs to resume). The message is queued " +
  "and consumed by the goal at the next round boundary as a [Steer from user: …] " +
  "injection — the goal runner will see it as user input on its next LLM call. " +
  "Do NOT use this to start a new goal (use propose_goal for that). Do NOT use " +
  "this for the goal you yourself are currently running INSIDE; the runner " +
  "already polls for steers from its own loop. Typical chat usage: user comes " +
  "back to a long-running goal conversation and says 'tell the search to also " +
  "consider X' — call this tool with the goal id and the steer text.";

/**
 * Construction-time deps. The host (serve.ts) wires the workspace path
 * and the autoRunner callback (reused from propose_goal). Like
 * propose_goal, autoRunner is fire-and-forget; the tool does NOT await
 * it.
 */
export interface GoalSendMessageToolOptions {
  /** Absolute path to the mathran workspace root (where .mathran/goals lives). */
  workspace: string;
  /**
   * Optional kicker. When the goal stream is idle OR the goal was in
   * failed status (and we resurrected it), the tool calls this to start
   * a fresh `POST /api/goals/:id/run/stream` cycle. The runner picks up
   * the steer at round-top. Omit on hosts where chat must not be allowed
   * to start goal rounds; in that case idle/failed steers will sit in
   * the queue until something else kicks the goal.
   *
   * Signature matches `propose_goal`'s autoRunner so the host can reuse
   * the same closure.
   */
  autoRunner?: (goalId: string, userMessage: string) => void;
}

export interface GoalSendMessageToolResult {
  ok: boolean;
  content: string;
}

export function createGoalSendMessageTool(
  opts: GoalSendMessageToolOptions,
): ToolSpec {
  const { workspace, autoRunner } = opts;
  return {
    name: "goal_send_message",
    riskClass: "read", // queueing a steer is metadata-level; the real work is the goal's
    readOnly: false, // writes pendingSteer + appendStep + maybe goal status
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        goalId: {
          type: "string",
          description:
            "ID of the existing goal to steer. Get this from a propose_goal tool-result, " +
            "the user's goal-panel URL, or by asking the user. Must be a full UUID — partial " +
            "prefixes are not resolved here.",
        },
        message: {
          type: "string",
          description:
            "The steer text to inject. Will be wrapped as '[Steer from user: <text>]' on the " +
            "next round of the target goal's LLM loop. Keep it concrete and actionable: " +
            "what's new, what changed, what the goal should do differently. Multi-paragraph " +
            "text is fine; no length limit beyond the goal model's context.",
        },
        kickIfIdle: {
          type: "boolean",
          description:
            "When true (default), if the goal's stream is currently idle OR the goal is in " +
            "`failed` status, the tool starts a fresh run cycle automatically so the steer " +
            "is consumed without delay. When false, the steer is queued silently and only " +
            "consumed if/when something else starts a run. Default: true.",
        },
      },
      required: ["goalId", "message"],
    },
    async execute(
      args: Record<string, unknown>,
      _ctx?: ToolExecuteContext,
    ): Promise<GoalSendMessageToolResult> {
      const goalId = typeof args.goalId === "string" ? args.goalId.trim() : "";
      const message = typeof args.message === "string" ? args.message.trim() : "";
      const kickIfIdle = args.kickIfIdle === undefined ? true : Boolean(args.kickIfIdle);

      if (goalId.length === 0) {
        return {
          ok: false,
          content:
            "goal_send_message error: `goalId` is required. Look it up from a previous " +
            "propose_goal tool-result, the goal panel URL (`/goal/<id>`), or ask the user.",
        };
      }
      if (message.length === 0) {
        return {
          ok: false,
          content:
            "goal_send_message error: `message` must be a non-empty steer text describing " +
            "what the goal should do differently.",
        };
      }

      // ─── Resolve the goal ──────────────────────────────────────────
      const goal = await readGoal(workspace, goalId);
      if (!goal) {
        // Help the user — list a few recent goals so they can find the right id.
        let recentHint = "";
        try {
          const all = await listGoals(workspace);
          const recent = all
            .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
            .slice(0, 5)
            .map((g) => `  ${g.id}  ${g.status.padEnd(10)} ${g.objective.slice(0, 60)}`)
            .join("\n");
          if (recent.length > 0) {
            recentHint = `\n\nRecent goals in this workspace:\n${recent}`;
          }
        } catch {
          /* listing is best-effort; an error here shouldn't mask the real problem */
        }
        return {
          ok: false,
          content: `goal_send_message error: no goal with id \`${goalId}\` found in this workspace.${recentHint}`,
        };
      }

      // Find the goal's primary conversation. Steers are scoped per
      // conversation in the steer-registry. A goal can attach multiple
      // conversations over its lifetime (rare), but the runner always
      // uses index 0 = the primary internal conversation.
      const convId = goal.conversationIds?.[0];
      if (!convId) {
        return {
          ok: false,
          content:
            `goal_send_message error: goal \`${goalId}\` has no attached conversation yet. ` +
            "This usually means it was just created but never run — start a round first " +
            "(`POST /api/goals/:id/run/stream`) so a conversation is created, then steer.",
        };
      }

      // ─── Resurrect failed goals (defensive) ────────────────────────
      // A `failed` goal can't be resumed via the normal `/resume` endpoint
      // (mathran rejects with "not resumable"). For external causes — e.g.
      // a copilot token outage that killed the round — manual resurrect
      // is the right fix. We record the resurrect in the goal's step log
      // so the chat history + the goal log line up.
      let resurrected = false;
      if (goal.status === "failed" || goal.status === "cancelled") {
        const prevStatus = goal.status;
        const prevReason = goal.endReason ?? null;
        goal.status = "active";
        goal.endedAt = undefined;
        goal.endReason = undefined;
        try {
          await writeGoal(workspace, goal);
          await appendStep(workspace, goalId, {
            kind: "status",
            payload: {
              from: prevStatus,
              to: "active",
              reason: `Resurrected by goal_send_message (previous endReason: ${prevReason ?? "n/a"})`,
            },
          } as unknown as Parameters<typeof appendStep>[2]);
          resurrected = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            content:
              `goal_send_message error: goal was in \`${prevStatus}\` status and resurrect ` +
              `failed: ${msg}. Edit the goal file by hand or use the goal panel to reset.`,
          };
        }
      }

      // ─── Queue the steer ───────────────────────────────────────────
      // setPendingSteer is idempotent-ish: it replaces any prior unread
      // steer for this conversation. If the user wants to send multiple
      // steers, they should batch them into one message.
      setPendingSteer(convId, message);

      const streamActive = hasActiveStream(convId);

      // Record the steer in the goal's step log too so the goal-side
      // history shows where the steer came from (chat, not raw API).
      try {
        await appendStep(workspace, goalId, {
          kind: "user-message",
          payload: {
            via: "chat:goal_send_message",
            text: message,
            queuedAt: new Date().toISOString(),
            streamWasActive: streamActive,
          },
        } as unknown as Parameters<typeof appendStep>[2]);
      } catch {
        /* step-log write is best-effort; don't fail the tool because of it */
      }

      // ─── Optionally kick a run cycle ───────────────────────────────
      // If the stream is active, nothing to do — round-top probe will
      // see the steer naturally. If the stream is idle (no client
      // listening, runner is between rounds), kick it via autoRunner.
      let kicked = false;
      let kickNote = "";
      if (!streamActive && kickIfIdle && autoRunner) {
        try {
          // The kickoff "userMessage" arg is ignored by the runner when
          // it sees a pending steer — the steer wins at round-top — but
          // we pass the same text so the autoRunner call is meaningful
          // in case the runner is from an older version that doesn't
          // probe steers first.
          autoRunner(goalId, message);
          kicked = true;
        } catch (err) {
          kickNote = ` (autoRunner threw: ${err instanceof Error ? err.message : String(err)})`;
        }
      } else if (!streamActive && kickIfIdle && !autoRunner) {
        kickNote =
          " (kickIfIdle=true but host did not wire an autoRunner; steer is queued " +
          "and will be consumed on the next manual run)";
      } else if (!streamActive && !kickIfIdle) {
        kickNote = " (kickIfIdle=false; steer queued for the next manual run)";
      }

      // ─── Build the tool-result payload ─────────────────────────────
      // Keep both a structured JSON view (for the model to reason about)
      // and a one-line human summary (so when the SPA renders the
      // tool-result it's not just a wall of JSON).
      const summary = [
        `✅ Queued steer for goal \`${goalId}\`.`,
        `   Goal status: ${goal.status}${resurrected ? " (resurrected from failed)" : ""}.`,
        `   Stream was ${streamActive ? "active — steer consumed at next round" : "idle"}.`,
        kicked ? "   Kicked a fresh run cycle." : kickNote ? `   ${kickNote.trim()}` : "",
        `   Steer (${message.length} chars): ${message.slice(0, 200)}${message.length > 200 ? "…" : ""}`,
      ]
        .filter((l) => l.length > 0)
        .join("\n");

      return {
        ok: true,
        content: JSON.stringify({
          ok: true,
          summary,
          goalId,
          goalStatus: goal.status,
          resurrected,
          conversationId: convId,
          streamWasActive: streamActive,
          kicked,
          steerLength: message.length,
        }),
      };
    },
  };
}
