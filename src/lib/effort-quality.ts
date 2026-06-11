/**
 * AI-powered effort quality scoring.
 * Uses Azure OpenAI gpt-54 to evaluate mathematical substance, originality,
 * completeness, and relevance.
 */

const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT ?? "";
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? "";
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";
const DEPLOYMENT = "gpt-54";

export interface QualityScore {
  total: number; // 0-100
  dimensions: {
    mathematicalSubstance: number; // 0-25
    originality: number; // 0-25
    completeness: number; // 0-25
    relevance: number; // 0-25
  };
  suggestions: string[];
  flags: string[]; // e.g. ["needs_review"]
}

export async function scoreEffortQuality(effort: {
  title: string;
  description: string;
  document?: string | null;
  type: string;
  status: string;
}): Promise<QualityScore> {
  const prompt = `You are a mathematical research quality evaluator. Score this workspace effort on 4 dimensions (each 0-25, total 0-100):

1. **Mathematical Substance** (0-25): Does it contain actual mathematical content, definitions, theorems, proofs, or computations?
2. **Originality** (0-25): Does it present novel ideas, approaches, or insights? Or is it just restating known results?
3. **Completeness** (0-25): Is the content thorough? Are proofs complete? Are edge cases addressed?
4. **Relevance** (0-25): Is it relevant to its stated topic? Is it well-focused?

Effort:
- Title: ${effort.title}
- Type: ${effort.type}
- Status: ${effort.status}
- Description: ${effort.description}
- Content: ${(effort.document ?? "").slice(0, 4000)}

Return JSON:
{
  "mathematicalSubstance": <0-25>,
  "originality": <0-25>,
  "completeness": <0-25>,
  "relevance": <0-25>,
  "suggestions": ["improvement suggestion 1", "suggestion 2"]
}`;

  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    return {
      total: 50,
      dimensions: { mathematicalSubstance: 12, originality: 12, completeness: 13, relevance: 13 },
      suggestions: ["Quality scoring unavailable — Azure OpenAI not configured"],
      flags: [],
    };
  }

  try {
    const url = `${AZURE_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": AZURE_API_KEY },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!resp.ok) {
      console.error("[quality-score] Azure API error:", resp.status);
      return fallbackScore();
    }

    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackScore();

    const parsed = JSON.parse(jsonMatch[0]) as {
      mathematicalSubstance: number;
      originality: number;
      completeness: number;
      relevance: number;
      suggestions?: string[];
    };

    const total = (parsed.mathematicalSubstance ?? 0) + (parsed.originality ?? 0) +
      (parsed.completeness ?? 0) + (parsed.relevance ?? 0);

    const flags: string[] = [];
    if (total < 30) flags.push("needs_review");

    return {
      total,
      dimensions: {
        mathematicalSubstance: parsed.mathematicalSubstance ?? 0,
        originality: parsed.originality ?? 0,
        completeness: parsed.completeness ?? 0,
        relevance: parsed.relevance ?? 0,
      },
      suggestions: parsed.suggestions ?? [],
      flags,
    };
  } catch (e) {
    console.error("[quality-score] Error:", e);
    return fallbackScore();
  }
}

function fallbackScore(): QualityScore {
  return {
    total: 50,
    dimensions: { mathematicalSubstance: 12, originality: 12, completeness: 13, relevance: 13 },
    suggestions: ["Quality scoring failed — using default score"],
    flags: [],
  };
}
