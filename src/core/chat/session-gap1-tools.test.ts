/**
 * Smoke test for gap #1: the 25 wiki/effort/project chat tools should
 * register on a ChatSession when `builtinTools.gap1_project_tools = true`.
 *
 * We don't run any LLM here — we just construct the session and inspect
 * the (private) `tools` array via `as any`. This catches typo/duplicate
 * registration mistakes without dragging in vitest fakes for the LLM.
 */
import { describe, it, expect } from "vitest";
import { ChatSession } from "./session.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/llm.js";

class StubLLM implements LLMProvider {
  async describe() {
    return { name: "stub" };
  }
  async chat(_req: LLMRequest): Promise<LLMResponse> {
    return {
      async *stream() {
        yield { type: "done", finishReason: "stop" } as any;
      },
    } as LLMResponse;
  }
}

const GAP1_TOOL_NAMES = [
  // Wiki (6)
  "read_wiki_page",
  "list_wiki_pages",
  "create_wiki_page",
  "update_wiki_page",
  "delete_wiki_page",
  "search_wiki",
  // Effort (12)
  "list_efforts",
  "read_effort",
  "create_effort",
  "update_effort_document",
  "append_effort_document",
  "update_effort_metadata",
  "transition_effort_status",
  "snapshot_effort",
  "list_effort_versions",
  "read_effort_version",
  "add_effort_relation",
  "list_effort_relations",
  // Project / doc (7)
  "list_projects",
  "read_project_metadata",
  "update_project_metadata",
  "list_doc_pages",
  "read_doc_page",
  "create_doc_page",
  "update_doc_page",
];

describe("gap #1 chat-tool registration", () => {
  it("registers all 25 tools when gap1_project_tools=true", () => {
    const session = new ChatSession({
      llm: new StubLLM(),
      builtinTools: { gap1_project_tools: true },
      workspace: "/tmp/mathran-test",
    });
    const tools = (session as any).tools as { name: string }[];
    const names = new Set(tools.map((t) => t.name));
    for (const expected of GAP1_TOOL_NAMES) {
      expect(names.has(expected), `missing tool: ${expected}`).toBe(true);
    }
  });

  it("does NOT register any gap #1 tool when flag is off", () => {
    const session = new ChatSession({
      llm: new StubLLM(),
      builtinTools: {},
      workspace: "/tmp/mathran-test",
    });
    const tools = (session as any).tools as { name: string }[];
    const names = new Set(tools.map((t) => t.name));
    for (const tool of GAP1_TOOL_NAMES) {
      expect(names.has(tool), `unexpected tool: ${tool}`).toBe(false);
    }
  });

  it("registers exactly 25 gap #1 tools", () => {
    const session = new ChatSession({
      llm: new StubLLM(),
      builtinTools: { gap1_project_tools: true },
      workspace: "/tmp/mathran-test",
    });
    const tools = (session as any).tools as { name: string }[];
    const gap1Count = tools.filter((t) => GAP1_TOOL_NAMES.includes(t.name)).length;
    expect(gap1Count).toBe(25);
  });
});
