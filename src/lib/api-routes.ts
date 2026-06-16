export const API_ROUTES = {
  agent: {
    plan: "/api/agent/plan",
    initProject: "/api/agent/init-project",
    batchInit: "/api/agent/batch-init",
  },
  trpc: "/api/trpc",
} as const;

// ========== AI Model Definitions ==========

export type AIModelId = "gpt-55" | "gpt-54";

export interface AIModelInfo {
  id: AIModelId;
  label: string;
  description: string;
}

export const AI_MODELS: AIModelInfo[] = [
  {
    id: "gpt-55",
    label: "GPT-5.5",
    description: "Latest general-purpose model — preferred for analysis, generation, and code",
  },
  {
    id: "gpt-54",
    label: "GPT-5.4",
    description: "Previous generation — kept as fallback while GPT-5.5 stabilises",
  },
];

export const DEFAULT_AI_MODEL: AIModelId = "gpt-55";

export function normalizeModelId(
  value: unknown,
  fallback: AIModelId = DEFAULT_AI_MODEL,
): AIModelId {
  if (typeof value !== "string") return fallback;
  const ids = AI_MODELS.map((m) => m.id) as string[];
  return ids.includes(value) ? (value as AIModelId) : fallback;
}
