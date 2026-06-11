import type { ToolDefinition } from "./types";

export const runLatexTool: ToolDefinition = {
  name: "run_latex",
  description:
    "Render a LaTeX expression to HTML using KaTeX. Returns the rendered HTML string.",
  parameters: {
    type: "object",
    properties: {
      latex: { type: "string", description: "The LaTeX expression to render" },
    },
    required: ["latex"],
  },
  async execute(args) {
    const latex = String(args.latex);

    try {
      const katex = await import("katex");
      const html = katex.default.renderToString(latex, {
        throwOnError: false,
        displayMode: latex.includes("\\begin") || latex.includes("\\frac") || latex.includes("\\sum"),
      });

      return {
        success: true,
        data: { html, latex },
        displayText: `Rendered LaTeX: ${latex.slice(0, 80)}${latex.length > 80 ? "…" : ""}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return {
        success: false,
        data: { error: msg, latex },
        displayText: `LaTeX render failed: ${msg}`,
      };
    }
  },
};
