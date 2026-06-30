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
  parseOutcomesSubcommand,
  formatOutcomesList,
  formatOutcomeDetail,
} from "../core/chat/slash-builtin.js";
import { resolveCustomCommands } from "../core/chat/slash-custom.js";
import { loadLayeredCommands } from "../core/commands/loader.js";
import { loadLayeredSkills } from "../core/skills/loader.js";
import { defaultSubagentRegistry, globalBackgroundRegistry } from "../core/subagent/index.js";
import {
  readIndex as readOutcomeIndex,
  readOutcome,
  deleteOutcome,
} from "../core/outcomes/store.js";
import { runDiff } from "../core/checkpoints/diff-run.js";
import { runRewind } from "../core/checkpoints/rewind.js";
import { makeChatStoreHistoryAdapter } from "../core/checkpoints/history-adapter.js";
import type { McpRegistry } from "../core/mcp/registry.js";
import {
  parseMcpSubcommand,
  formatMcpStatusList,
  formatMcpServerDetail,
  formatMcpToolsList,
  formatMcpPromptsList,
  formatMcpResourcesList,
} from "../core/mcp/format.js";
import { formatConfigDiff } from "../core/mcp/watcher.js";

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
  /** MCP registry (#4) for the `/mcp` server-side slash command. */
  mcpRegistry?: McpRegistry;
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
  // `kinds` comes from the subagent registry. `active` lists the live (and
  // recently-finished) *background* subagents tracked process-wide by the
  // BackgroundSubagentRegistry (#3) — the SPA's BackgroundAgentsPanel polls
  // this. Records age out a few seconds after reaching a terminal state.
  app.get("/api/subagents/active", (c) => {
    const kinds = deps.subagentKinds
      ? deps.subagentKinds()
      : defaultSubagentRegistry().list();
    const active = globalBackgroundRegistry()
      .getActiveSubagents()
      .map((r) => ({
        id: r.id,
        type: r.type,
        mode: r.mode,
        status: r.status,
        startedAt: r.startedAt,
        parentConversationId: r.parentConversationId,
        taskSummary: r.taskSummary,
        ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        ...(r.errorMessage !== undefined ? { errorMessage: r.errorMessage } : {}),
      }));
    return c.json({ kinds, active });
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

      case "outcomes": {
        // outcomes 收尾 C-2 — mirror the CLI `/outcomes` REPL handler so the
        // SPA renders the identical text. Reads from the workspace outcome
        // store (host-scoped, like the CLI's memoryWorkspace path).
        const sub = parseOutcomesSubcommand(args);
        switch (sub.kind) {
          case "list": {
            const index = await readOutcomeIndex(workspace);
            return c.json({ ok: true, text: formatOutcomesList(index) });
          }
          case "show": {
            const outcome = await readOutcome(workspace, sub.goalId);
            if (!outcome) {
              return c.json({
                ok: true,
                text: `no outcome found for goal '${sub.goalId}' (try /outcomes to list)`,
              });
            }
            return c.json({ ok: true, text: formatOutcomeDetail(outcome) });
          }
          case "delete": {
            const removed = await deleteOutcome(workspace, sub.goalId);
            return c.json({
              ok: true,
              text: removed
                ? `deleted outcome for goal '${sub.goalId}'.`
                : `no outcome found for goal '${sub.goalId}'.`,
            });
          }
          case "error":
            return c.json({ ok: true, text: sub.message });
        }
        return c.json({ ok: true, text: formatOutcomesList(await readOutcomeIndex(workspace)) });
      }

      case "diff": {
        // /diff — list checkpoints or render one checkpoint's diff. Reads the
        // per-conversation checkpoint cache under the workspace.
        const text = await runDiff(workspace, id, args);
        return c.json({ ok: true, text });
      }

      case "rewind": {
        // /rewind — roll the workspace back to before a checkpoint (or the
        // newest N). 5-mode parity with Claude Code: callers can pass
        // `--mode <code-and-conversation|conversation-only|code-only|
        // summarize-from-here|summarize-up-to-here>` to control whether the
        // conversation jsonl is rewound / summarised alongside the files.
        // On success, append a `[Rewound …]` system note so the model sees
        // the workspace changed underneath it (for `code-only`; the other
        // modes already embed a marker via the history adapter).
        const adapter = makeChatStoreHistoryAdapter({
          workspace,
          scope: GLOBAL_SCOPE,
          conversationId: id,
          store,
        });
        const outcome = await runRewind(workspace, id, args, {
          historyAdapter: adapter,
        });
        if (outcome.kind === "done") {
          try {
            // The adapter's write() already replaced the live session for
            // conversation-touching modes. For `code-only` we still append
            // the marker note so the conversation reflects the rewind.
            if (outcome.result.mode === "code-only") {
              const session = await store.getOrCreate(GLOBAL_SCOPE, id, undefined);
              session.appendSystemNote(outcome.historyNote);
              await store.flush(GLOBAL_SCOPE, id);
            }
          } catch {
            // Best-effort history note — the disk rollback already happened.
          }
        }
        return c.json({ ok: true, text: outcome.text });
      }

      case "mcp": {
        const registry = deps.mcpRegistry;
        if (!registry) {
          return c.json({ ok: true, text: "MCP is not available on this server." });
        }
        const sub = parseMcpSubcommand(args);
        switch (sub.kind) {
          case "list":
            return c.json({ ok: true, text: formatMcpStatusList(registry.status()) });
          case "status":
            return c.json({
              ok: true,
              text: formatMcpServerDetail(registry.statusFor(sub.server), sub.server),
            });
          case "tools":
            return c.json({
              ok: true,
              text: formatMcpToolsList(sub.server, registry.toolsFor(sub.server)),
            });
          case "prompts":
            return c.json({
              ok: true,
              text: formatMcpPromptsList(sub.server, registry.promptsFor(sub.server)),
            });
          case "resources":
            return c.json({
              ok: true,
              text: formatMcpResourcesList(sub.server, registry.resourcesFor(sub.server)),
            });
          case "reload": {
            const info = await registry.reload(sub.server);
            return c.json({
              ok: true,
              text: info
                ? `reloaded "${sub.server}" → ${info.status} (tools: ${info.toolCount}).`
                : `no MCP server named "${sub.server}".`,
            });
          }
          case "reload-all": {
            const all = await registry.reloadAll();
            return c.json({ ok: true, text: `reloaded ${all.length} server(s).\n${formatMcpStatusList(all)}` });
          }
          case "reload-config": {
            const diff = await registry.reloadFromConfig({ workspace });
            return c.json({
              ok: true,
              text: `${formatConfigDiff(diff)}\n${formatMcpStatusList(registry.status())}`,
            });
          }
          case "watch":
            return c.json({
              ok: true,
              text: "MCP config is auto-watched by the serve host; use `/mcp reload-config` to force a reload.",
            });
          case "error":
            return c.json({ ok: true, text: sub.message });
        }
        return c.json({ ok: true, text: formatMcpStatusList(registry.status()) });
      }

      default:
        return c.json(
          { error: `command "/${command}" is not a server-side slash command` },
          400,
        );
    }
  });
}
