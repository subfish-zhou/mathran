import { createSandboxTool } from "./sandbox-common";

export const runSageTool = createSandboxTool(
  "sage",
  "Execute SageMath code in a secure Docker sandbox. SageMath provides extensive mathematical functionality: " +
    "algebra, number theory, combinatorics, geometry, calculus, and more. Returns stdout, stderr, and generated files.",
);
