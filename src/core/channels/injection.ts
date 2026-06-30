/**
 * Channels v1 — pure helper that turns a {@link ChannelMessage} into the
 * {@link LLMMessage} the kernel actually appends to history.
 *
 * Kept separate from ChatSession so the projection is independently
 * testable AND so tests can build the exact message shape without
 * spinning up a session.
 *
 * Wire layout
 * ───────────
 *
 *   role:    "user"
 *   content: msg.content                        (verbatim, NOT prefixed —
 *                                                we used to prefix
 *                                                `[Steer from user: …]`
 *                                                style brackets but
 *                                                channel pushes are
 *                                                already a distinct UI
 *                                                bubble via `meta.fromChannel`,
 *                                                so extra prefixing
 *                                                just confuses the model
 *                                                and the SPA both.)
 *   meta:    { fromChannel, channelTs }
 *
 * `meta.fromChannel` is consumed by the SPA to colour the bubble; the
 * provider adapters MUST ignore the `meta` field entirely. See
 * `LLMMessage.meta` in src/core/providers/llm.ts for the field contract.
 */

import type { LLMMessage } from "../providers/llm.js";
import type { ChannelMessage } from "./types.js";

/**
 * Build the kernel-side message for an inbound channel push.
 *
 * Pure: no side effects, no time dependency on the clock unless a
 * `nowMs` is passed (tests pin it for determinism).
 */
export function buildInjectedMessage(
  msg: ChannelMessage,
  nowMs: number = Date.now(),
): LLMMessage {
  return {
    role: "user",
    content: msg.content,
    meta: {
      fromChannel: msg.source,
      channelTs: nowMs,
    },
  };
}
