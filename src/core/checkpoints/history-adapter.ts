/**
 * Conversation history adapter for /rewind (5-mode restore).
 *
 * The {@link ConversationHistoryAdapter} contract in `rewind.ts` is
 * deliberately decoupled from the chat-store internals — tests stub it with
 * an in-memory list. This module supplies the **production** wiring used by
 * the CLI's `/rewind` handler and the SPA's POST /api/chat/:cid/slash route.
 *
 * Behaviour:
 *   - `read()`  re-uses the chat store's `loadHistory` semantics so we see
 *     exactly what's on disk (newest message last).
 *   - `write()` rewrites the .jsonl atomically via the same flushSession
 *     plumbing the chat store uses, then — when a live in-memory session is
 *     cached — calls `session.replaceHistory(...)` so the next turn sees the
 *     rewound list instead of the stale one.
 *
 * We deliberately import from the public `core/chat/store.ts` surface only
 * (`conversationFilePath`, `peekLiveHistory`, `readHistory`) so this glue
 * stays a thin host adapter and isn't coupled to internal flush helpers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicWriteFile } from "../chat/atomic-write.js";
import {
  conversationFilePath,
  type ChatScope,
  type ScopedChatSessionStore,
} from "../chat/store.js";
import type { LLMMessage } from "../providers/llm.js";
import type {
  ConversationHistoryAdapter,
  MinimalMessage,
} from "./rewind.js";

export interface MakeChatStoreAdapterOpts {
  workspace: string;
  scope: ChatScope;
  conversationId: string;
  store?: ScopedChatSessionStore;
}

/**
 * Build a {@link ConversationHistoryAdapter} backed by the on-disk jsonl
 * (and, when present, the live ChatSession cached in {@link
 * ScopedChatSessionStore}).
 *
 * Why both? `/rewind` may run while a ChatSession is still cached (the user
 * has been chatting in-process). If we only rewrote the jsonl, the live
 * session's `messages[]` would still hold the post-checkpoint tail and the
 * next `send()` would silently re-write it back at flush time. Replacing
 * the live history *and* the disk file keeps both views consistent.
 */
export function makeChatStoreHistoryAdapter(
  opts: MakeChatStoreAdapterOpts,
): ConversationHistoryAdapter {
  const jsonlPath = conversationFilePath(opts.workspace, opts.scope, opts.conversationId);

  return {
    async read(): Promise<MinimalMessage[] | null> {
      // Prefer the in-memory copy when a live session is cached — it's the
      // authoritative view (it may hold turns that haven't been flushed yet).
      const live = opts.store?.peekLiveHistory(opts.scope, opts.conversationId);
      if (live) return live as MinimalMessage[];
      const fromDisk = await opts.store?.readHistory(opts.scope, opts.conversationId);
      if (fromDisk) return fromDisk as MinimalMessage[];
      // Last-chance fallback: read the file directly (some hosts don't pass a
      // store — e.g. early CLI bootstrap, narrow unit tests).
      return readJsonlDirect(jsonlPath);
    },
    async write(messages: MinimalMessage[]): Promise<void> {
      // Update the in-memory session first, so a concurrent /send doesn't
      // re-flush the stale history over what we're about to write.
      try {
        // `peekLiveHistory` is the only public hook that returns the entry
        // without bumping LRU; to *mutate* the cached session we have to go
        // through `getOrCreate`. Wrap in try so a store-less caller (or one
        // whose factory throws) still gets the disk write.
        if (opts.store) {
          const session = await opts.store.getOrCreate(opts.scope, opts.conversationId, undefined);
          session.replaceHistory(messages as LLMMessage[]);
          // Flush so the on-disk jsonl matches the live state. This also
          // serialises with any other writer through the store's per-conv
          // flush lock (see chat/store.ts withFileLock plumbing).
          await opts.store.flush(opts.scope, opts.conversationId);
          return;
        }
      } catch {
        // Fall through to a direct disk write below.
      }
      await writeJsonlDirect(jsonlPath, messages);
    },
  };
}

async function readJsonlDirect(jsonlPath: string): Promise<MinimalMessage[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(jsonlPath, "utf-8");
  } catch {
    return null;
  }
  const out: MinimalMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as MinimalMessage);
    } catch {
      continue;
    }
  }
  return out;
}

async function writeJsonlDirect(
  jsonlPath: string,
  messages: readonly MinimalMessage[],
): Promise<void> {
  await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  await atomicWriteFile(jsonlPath, lines + (lines.length > 0 ? "\n" : ""));
}
