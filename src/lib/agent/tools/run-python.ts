import { createSandboxTool } from "./sandbox-common";

export const runPythonTool = createSandboxTool(
  "python",
  "Execute Python code in a secure Docker sandbox. Pre-installed packages: sympy, numpy, scipy, matplotlib, plotly, sage. " +
    "Returns stdout, stderr, and any generated image files. Use for computation, symbolic math, plotting, and data analysis.",
);
