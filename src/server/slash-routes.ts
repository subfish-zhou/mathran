/**
 * SPA Slash Commands — HTTP surface (`src/server/slash-routes.ts`).
 *
 * Registers the new endpoints that back the SPA slash UI. Dependencies
 * (`store`, `computeUsageStats`, subagent kinds) are injected from
 * `serve.ts` to avoid a circular import between the two modules.
 *
 * Endpoints:
 *   GET  /api/slash/commands        → { builtin, custom, warnings }
 *   GET  /api/skills                → { skills }   (three-layer)
 *   GET  /api/subagents/active      → { kinds, active }
 *   POST /api/chat/:cid/slash       → execute a session/backend builtin
 *   GET  /api/chat/:cid/context     → { tokens, maxTokens, percentage }
 *
 * `POST /api/chat/:cid/compact` is intentionally NOT defined here — the legacy
 * `/api/chat` chat scope already registers it (registerChatScope), and this
 * route layer reuses it.
 */

import type { Hono } from "hono";

import type { ChatSession } from "../core/chat/index.js";
import type { ChatScope, ScopedChatSessionStore } from "../core/chat/store.js";
import type { LLMMessage } from "../core/providers/llm.js";
import {
  BUILTIN_SLASH_COMMANDS,
  BUILTIN_SLASH_COMMAND_NAMES,
  parseReasoningEffort,
  setSessionReasoningEffort,
  skillsToSummaries,
  REVIEW_STUB_PROMPT,
} from "../core/chat/slash-builtin.js";
import { resolveCustomCommands } from "../core/chat/slash-custom.js";
import { loadLayeredCommands } from "../core/commands/loader.js";
import { loadLayeredSkills } from "../core/skills/loader.js";
import { defaultSubagentRegistry } from "../core/subagent/index.js";

/** Shape of `computeUsageStats` (defined in serve.ts), injected to avoid cycles. */
export interface UsageStatsLike {
  tokens: number;
  messages: number;
  contextWindow: number;
  percentage: number;
  warning: string | null;
}

export interface SlashRoutesDeps {
  workspace: string;
  store: ScopedChatSessionStore;
  computeUsageStats: (history: LLMMessage[], fallbackModel?: string) => UsageStatsLike;
  /** Returns the registered subagent kinds; defaults to the builtin registry. */
  subagentKinds?: () => string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

const GLOBAL_SCOPE: ChatScope = { kind: "global" };

/** Register the slash-command HTTP surface on `app`. */
export function registerSlashRoutes(app: Hono, deps: SlashRoutesDeps): void {
  const { workspace, store, computeUsageStats } = deps;

  // ── GET /api/slash/commands ───────────────────────────────────────────
  app.get("/api/slash/commands", (c) => {
    const builtin = BUILTIN_SLASH_COMMANDS.map((b) => ({
      name: b.name,
      description: b.description,
    }));
    let custom: Array<{ name: string; description?: string; body: string; layer: string }> = [];
    let warnings: string[] = [];
    try {
      const loaded = loadLayeredCommands({ workspace });
      const resolved = resolveCustomCommands(loaded.commands, BUILTIN_SLASH_COMMAND_NAMES);
      warnings = [...loaded.warnings, ...resolved.warnings];
      custom = resolved.commands.map((cmd) => ({
        name: cmd.name,
        ...(cmd.description ? { description: cmd.description } : {}),
        body: cmd.body,
        layer: cmd.layer,
      }));
    } catch {
      // Best-effort: a broken commands dir degrades to "builtin only".
    }
    return c.json({ builtin, custom, warnings });
  });

  // ── GET /api/skills ───────────────────────────────────────────────────
  app.get("/api/skills", (c) => {
    try {
      const { skills } = loadLayeredSkills({ workspace });
      return c.json({ skills: skillsToSummaries(skills) });
    } catch {
      return c.json({ skills: [] });
    }
  });

  // ── GET /api/subagents/active ─────────────────────────────────────────
  //
  // MVP: `kinds` comes from the subagent registry; `active` is best-effort
  // empty — there's no global cross-conversation scheduler tracker yet
  // (full live-tree wiring is a follow-up; the SubagentTreePanel uses the
  // goal-tree surface instead). Documented in PLAN "部分已存在".
  app.get("/api/subagents/active", (c) => {
    const kinds = deps.subagentKinds
      ? deps.subagentKinds()
      : defaultSubagentRegistry().list();
    return c.json({ kinds, active: [] as Array<{ id: string; type: string; status?: string }> });
  });

  // ── GET /api/chat/:cid/context ────────────────────────────────────────
  app.get("/api/chat/:conversationId/context", async (c) => {
    const id = c.req.param("conversationId");
    if (!isSafeId(id)) return c.json({ error: "invalid conversation id" }, 400);
    const fallbackModel = c.req.query("model") ?? undefined;
    const live = store.peekLiveHistory(GLOBAL_SCOPE, id);
    const history = live ?? (await store.readHistory(GLOBAL_SCOPE, id)) ?? [];
    const stats = computeUsageStats(history, fallbackModel);
    return c.json({
      tokens: stats.tokens,
      maxTokens: stats.contextWindow,
      percentage: stats.percentage,
      warning: stats.warning,
    });
  });

  // ── POST /api/chat/:cid/slash ─────────────────────────────────────────
  app.post("/api/chat/:conversationId/slash", async (c) => {
    const id = c.req.param("conversationId");
    if (!isSafeId(id)) return c.json({ error: "invalid conversation id" }, 400);

    let body: { command?: unknown; args?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const command = typeof body.command === "string" ? body.command.replace(/^\//, "") : "";
    const args = typeof body.args === "string" ? body.args : "";
    if (!command) return c.json({ error: "command is required" }, 400);

    switch (command) {
      case "effort": {
        const level = parseReasoningEffort(args);
        if (!level) {
          return c.json({ error: "usage: /effort <low|medium|high|max>" }, 400);
        }
        let session: ChatSession;
        try {
          session = await store.getOrCreate(GLOBAL_SCOPE, id, undefined);
        } catch (err) {
          return c.json({ error: (err as Error)?.message ?? String(err) }, 500);
        }
        setSessionReasoningEffort(session, level);
        return c.json({
          ok: true,
          effort: level,
          message: `reasoning effort set to "${level}" (applies to the next message)`,
        });
      }

      case "compact": {
        const history = await store.readHistory(GLOBAL_SCOPE, id);
        if (history === null) return c.json({ error: "conversation not found" }, 404);
        const k = Number.parseInt(args, 10);
        let session: ChatSession;
        try {
          session = await store.getOrCreate(GLOBAL_SCOPE, id, undefined);
          const stats = await session.compact(
            Number.isFinite(k) && k > 0 ? { keepRecentRounds: k } : undefined,
          );
          await store.flush(GLOBAL_SCOPE, id);
          return c.json({ ok: true, stats });
        } catch (err) {
          return c.json({ error: (err as Error)?.message ?? String(err) }, 500);
        }
      }

      case "review": {
        // MVP stub (PLAN decision #2): no reviewer agent yet. Hand the SPA a
        // preset prompt to send through the normal chat stream.
        return c.json({ ok: true, action: "send", prompt: REVIEW_STUB_PROMPT });
      }

      default:
        return c.json(
          { error: `command "/${command}" is not a server-side slash command` },
          400,
        );
    }
  });
}
