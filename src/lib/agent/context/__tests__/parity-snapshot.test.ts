/**
 * 11c parity snapshot — verify the new ContextManager pipeline produces the
 * same persistent system prompt as the legacy buildSystemPrompt(...).
 *
 * Strategy: for each of the 4 contexts (personal/project/thread/program),
 * with and without a workspace status, compute:
 *   legacy = buildSystemPrompt({...})
 *   modern = contextManager.renderPersistent({...}).text
 *
 * They must be byte-identical. If not, the persistent fragments diverged
 * from legacy and we likely broke a real conversation's prompt.
 *
 * Note: user-memory and turn-time fragments are NOT in the comparison —
 * legacy callers compose those separately (chat-handler.ts:368 does
 * `systemPrompt + userMemoryContext`).
 *
 * Ported: 2026-06-10 (commit 11b/sprint-3 of mathub-ai-codex-upgrade).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  buildSystemPrompt,
  type PromptBuilderInput,
  type WorkspaceStatusHint,
} from "../../prompt-builder";
import { contextManager } from "../manager";
import type { FragmentRenderInput } from "../fragment";

// Ensure the builtin fragments are registered. import './boot' has side
// effects on first load; calling reset+re-import would be over-engineering.
beforeAll(async () => {
  // Lazy import so the registry is populated even if some other test
  // called _resetForTest() earlier in this file.
  await import("../boot");
});

const WS_RUNNING: WorkspaceStatusHint = {
  enabled: true,
  state: "running",
};
const WS_PROVISIONING: WorkspaceStatusHint = {
  enabled: true,
  state: "provisioning",
};
const WS_DISABLED: WorkspaceStatusHint = {
  enabled: false,
  state: "not_provisioned",
};

interface ParityCase {
  name: string;
  legacy: PromptBuilderInput;
  modern: FragmentRenderInput;
}

const CASES: ParityCase[] = [
  {
    name: "personal — no workspace",
    legacy: { context: "personal", userId: "u1" },
    modern: { context: "personal", userId: "u1" },
  },
  {
    name: "personal — workspace running",
    legacy: { context: "personal", userId: "u1", workspaceStatus: WS_RUNNING },
    modern: { context: "personal", userId: "u1", workspaceStatus: WS_RUNNING },
  },
  {
    name: "personal — workspace disabled",
    legacy: { context: "personal", userId: "u1", workspaceStatus: WS_DISABLED },
    modern: { context: "personal", userId: "u1", workspaceStatus: WS_DISABLED },
  },
  {
    name: "project — with title",
    legacy: {
      context: "project",
      userId: "u1",
      projectId: "p1",
      projectTitle: "LRC Notes",
    },
    modern: {
      context: "project",
      userId: "u1",
      projectId: "p1",
      projectTitle: "LRC Notes",
    },
  },
  {
    name: "project — provisioning workspace",
    legacy: {
      context: "project",
      userId: "u1",
      projectId: "p1",
      projectTitle: "LRC",
      workspaceStatus: WS_PROVISIONING,
    },
    modern: {
      context: "project",
      userId: "u1",
      projectId: "p1",
      projectTitle: "LRC",
      workspaceStatus: WS_PROVISIONING,
    },
  },
  {
    name: "thread — with title",
    legacy: {
      context: "thread",
      userId: "u1",
      threadId: "t1",
      threadTitle: "Convergence proof discussion",
      projectId: "p1",
      projectTitle: "LRC",
    },
    modern: {
      context: "thread",
      userId: "u1",
      threadId: "t1",
      threadTitle: "Convergence proof discussion",
      projectId: "p1",
      projectTitle: "LRC",
    },
  },
  {
    name: "program — with title",
    legacy: {
      context: "program",
      userId: "u1",
      programId: "pr1",
      programTitle: "AI4Math",
    },
    modern: {
      context: "program",
      userId: "u1",
      programId: "pr1",
      programTitle: "AI4Math",
    },
  },
];

describe("11c parity snapshot — persistent fragments == legacy buildSystemPrompt", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const legacy = buildSystemPrompt(c.legacy);
      const modern = (await contextManager.renderPersistent(c.modern)).text;
      // Helpful diff when they drift:
      if (legacy !== modern) {
        console.warn("Legacy:", JSON.stringify(legacy));
        console.warn("Modern:", JSON.stringify(modern));
      }
      expect(modern).toBe(legacy);
    });
  }
});
