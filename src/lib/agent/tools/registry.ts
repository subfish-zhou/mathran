import type { ToolDefinition } from "./types";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Convert to OpenAI function calling format */
  getOpenAITools(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    return this.getAll().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /** Filter tools based on context (some are project-only) */
  getToolsForContext(opts: {
    hasProject: boolean;
    allowedTools?: string[];
  }): ToolRegistry {
    const filtered = new ToolRegistry();
    for (const tool of this.tools.values()) {
      if (tool.projectOnly && !opts.hasProject) continue;
      if (opts.allowedTools && !opts.allowedTools.includes(tool.name)) continue;
      filtered.register(tool);
    }
    return filtered;
  }
}
