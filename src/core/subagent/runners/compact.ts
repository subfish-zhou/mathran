/**
 * Compact subagent runner (v0.2 §5).
 *
 * Strategy (Claude Code "safeguard" style):
 *   1. Keep the system message (index 0) verbatim.
 *   2. Walk backwards from the end of history to find the last K *complete*
 *      user/assistant rounds. A round boundary is a clean `role === "user"`
 *      message; any `tool`/`assistant`-with-toolCalls in between belong to the
 *      surrounding round (we never cut a `tool_use` from its `tool_result`).
 *   3. Everything between the system message and those K rounds is the
 *      "middle chunk". If empty → no-op.
 *   4. Ask the LLM to summarize the middle chunk; replace it with one
 *      `role:"system"` message of the form `"<Previous conversation
 *      summary>\n\n" + summary`.
 *   5. Persist the new message array to an artifact JSON; ChatSession.compact()
 *      swaps it into the live `messages` field.
 *
 * The runner itself NEVER mutates the parent session. It only returns the new
 * message array via the artifact.
 */

import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMStreamChunk,
} from "../../providers/llm.js";
import {
  createOpenAITokenCounter,
  createFallbackTokenCounter,
  type TokenCounter,
} from "../../chat/token-counter.js";
import type {
  SubagentContext,
  SubagentResult,
  SubagentRunner,
  SubagentTask,
} from "../types.js";

/** Default count of recent rounds to preserve verbatim. */
export const DEFAULT_KEEP_RECENT_ROUNDS = 5;
/** Default LLM context window (used by autoCompact threshold math). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Soft cap on the produced summary (in tokens, advisory only). */
export const DEFAULT_SUMMARY_TARGET_TOKENS = 1500;

export const COMPACT_PROMPT_HEADER =
  "Summarize the following conversation history into a compact paragraph " +
  "capturing:\n" +
  "- Key facts established\n" +
  "- Decisions made\n" +
  "- Current state / open threads\n" +
  "- Anything the assistant has committed to\n" +
  "Keep under 1500 tokens. Use third-person past tense.";

export const COMPACT_SUMMARY_PREFIX = "<Previous conversation summary>\n\n";

export interface CompactRunnerInput {
  /** Full message history (including system). */
  messages: LLMMessage[];
  /** Provider context window (for the caller's threshold math; the runner
   *  itself just records it for downstream stats). */
  contextWindow?: number;
  /** Number of recent rounds to keep verbatim (default 5). */
  keepRecentRounds?: number;
  /** Optional model hint for the summary call (passed straight to LLMRequest). */
  modelHint?: string;
  /** Provider used to run the summary call. Injected by ChatSession.compact(). */
  llm?: LLMProvider;
}

export interface CompactedArtifact {
  /** Full replacement history. */
  newMessages: LLMMessage[];
  /** Token count of the original history (best-effort). */
  originalTokenCount: number;
  /** Token count of the new history (best-effort). */
  newTokenCount: number;
  /** Number of complete rounds dropped from the middle of history. */
  droppedRoundCount: number;
  /** The summary text the LLM produced (without the prefix). */
  summaryText: string;
  /** True when no-op (middle chunk was empty). */
  noop: boolean;
}

/**
 * Find the index where the last K *complete* user-rooted rounds start.
 *
 * A "round start" is a `role === "user"` message. We walk backwards through
 * `messages` (starting *after* any leading system message), counting user
 * messages; the K-th hit from the end is the start of the kept tail.
 *
 * Returns the *absolute* index into `messages`. If there are fewer than K
 * user messages, returns the index right after the system block (i.e. the
 * whole non-system history is kept).
 */
export function findKeepStartIndex(messages: LLMMessage[], keepRounds: number): number {
  if (keepRounds <= 0) return messages.length;
  // Skip leading system messages so we don't accidentally drop them.
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === "system") {
    firstNonSystem++;
  }
  let userSeen = 0;
  for (let i = messages.length - 1; i >= firstNonSystem; i--) {
    if (messages[i].role === "user") {
      userSeen++;
      if (userSeen === keepRounds) return i;
    }
  }
  // Fewer user messages than we want to keep → keep the entire non-system tail.
  return firstNonSystem;
}

/** Pick a TokenCounter for ad-hoc message accounting. The runner does NOT have
 *  provider context here, so we fall back to gpt-tokenizer/o200k_base. */
function makeCounter(modelHint?: string): TokenCounter {
  try {
    return createOpenAITokenCounter(modelHint);
  } catch {
    return createFallbackTokenCounter();
  }
}

/** Render the middle chunk as a single prompt the summarizer LLM can read. */
function renderMiddleAsPrompt(middle: LLMMessage[]): string {
  const lines: string[] = [];
  for (const m of middle) {
    const tag = m.role.toUpperCase();
    let body = m.content ?? "";
    if (m.toolCalls && m.toolCalls.length > 0) {
      const calls = m.toolCalls
        .map((c) => `→ ${c.name}(${c.arguments})`)
        .join("\n");
      body = body ? `${body}\n${calls}` : calls;
    }
    if (m.role === "tool" && m.name) {
      lines.push(`[${tag} ${m.name}]\n${body}`);
    } else {
      lines.push(`[${tag}]\n${body}`);
    }
  }
  return lines.join("\n\n");
}

/** Consume an LLMResponse stream and return the concatenated text. */
async function collectText(
  stream: AsyncIterable<LLMStreamChunk>,
): Promise<string> {
  let out = "";
  for await (const ch of stream) {
    if (ch.type === "text") out += ch.delta;
  }
  return out;
}

/**
 * Compute everything the artifact needs given a `messages` array + a
 * (possibly injected) summarizer LLM. Exported so unit tests can drive the
 * logic without touching the scheduler / artifact IO.
 */
export async function computeCompacted(
  input: CompactRunnerInput,
): Promise<CompactedArtifact> {
  const keepRounds = input.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS;
  const messages = input.messages;
  const counter = makeCounter(input.modelHint);
  const originalTokenCount = counter.countMessages(messages);

  // Split: leading system block + middle + tail.
  let firstNonSystem = 0;
  while (firstNonSystem < messages.length && messages[firstNonSystem].role === "system") {
    firstNonSystem++;
  }
  const systemBlock = messages.slice(0, firstNonSystem);
  const keepStart = findKeepStartIndex(messages, keepRounds);
  const middle = messages.slice(firstNonSystem, keepStart);
  const tail = messages.slice(keepStart);

  if (middle.length === 0) {
    return {
      newMessages: messages.map((m) => ({ ...m })),
      originalTokenCount,
      newTokenCount: originalTokenCount,
      droppedRoundCount: 0,
      summaryText: "",
      noop: true,
    };
  }

  // Count complete user-rooted rounds inside the middle chunk.
  const droppedRoundCount = middle.reduce(
    (n, m) => n + (m.role === "user" ? 1 : 0),
    0,
  );

  // Ask the LLM to summarize.
  let summaryText = "";
  if (input.llm) {
    const prompt = `${COMPACT_PROMPT_HEADER}\n\n--- BEGIN HISTORY ---\n${renderMiddleAsPrompt(
      middle,
    )}\n--- END HISTORY ---`;
    const req: LLMRequest = {
      messages: [
        {
          role: "system",
          content:
            "You are a conversation summarizer. Output only the summary paragraph; no preamble, no headers.",
        },
        { role: "user", content: prompt },
      ],
      model: input.modelHint ?? "",
      maxTokens: DEFAULT_SUMMARY_TARGET_TOKENS,
    };
    const response = await input.llm.chat(req);
    summaryText = (await collectText(response.stream())).trim();
  }
  if (!summaryText) {
    // Fallback: best-effort deterministic skeleton if no LLM is wired.
    summaryText = `Earlier dialog covered ${droppedRoundCount} user turn(s); details elided.`;
  }

  const summaryMessage: LLMMessage = {
    role: "system",
    content: COMPACT_SUMMARY_PREFIX + summaryText,
  };

  const newMessages: LLMMessage[] = [
    ...systemBlock.map((m) => ({ ...m })),
    summaryMessage,
    ...tail.map((m) => ({ ...m })),
  ];
  const newTokenCount = counter.countMessages(newMessages);

  return {
    newMessages,
    originalTokenCount,
    newTokenCount,
    droppedRoundCount,
    summaryText,
    noop: false,
  };
}

export const compactRunner: SubagentRunner = {
  type: "compact",
  async run(
    task: SubagentTask,
    ctx: SubagentContext,
  ): Promise<Omit<SubagentResult, "runId" | "type" | "stats">> {
    const input = task.input as unknown as CompactRunnerInput;
    if (!input || !Array.isArray(input.messages)) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "compact: task.input.messages must be an LLMMessage[]",
      };
    }
    if (ctx.signal.aborted) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage: "compact: aborted before start",
      };
    }

    let artifact: CompactedArtifact;
    try {
      artifact = await computeCompacted(input);
    } catch (err) {
      return {
        status: "error",
        summary: "",
        artifactPath: null,
        errorMessage:
          err instanceof Error ? err.message : `compact: ${String(err)}`,
      };
    }

    const artifactPath = await ctx.writeArtifact(
      "compacted.json",
      JSON.stringify(artifact, null, 2),
    );

    const summary = JSON.stringify({
      noop: artifact.noop,
      originalTokenCount: artifact.originalTokenCount,
      newTokenCount: artifact.newTokenCount,
      droppedRoundCount: artifact.droppedRoundCount,
      contextWindow: input.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    });

    return {
      status: "ok",
      summary,
      artifactPath,
    };
  },
};
