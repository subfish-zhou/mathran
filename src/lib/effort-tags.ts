/**
 * AI-powered tag suggestions for workspace efforts.
 * Uses Azure OpenAI gpt-54 to suggest relevant tags.
 */

const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT ?? "";
const AZURE_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? "";
const AZURE_API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";
const DEPLOYMENT = "gpt-54";

export async function suggestTags(effort: {
  title: string;
  description: string;
  document?: string | null;
}): Promise<string[]> {
  if (!AZURE_ENDPOINT || !AZURE_API_KEY) {
    return [];
  }

  const prompt = `You are a mathematical research tag suggestion system. Given a workspace effort, suggest up to 5 concise, relevant tags (lowercase, hyphenated).

Tags should cover:
- Mathematical area (e.g., number-theory, algebraic-geometry)
- Techniques used (e.g., sieve-methods, spectral-theory)
- Key objects (e.g., prime-gaps, elliptic-curves)
- Approach type (e.g., computational, analytic, combinatorial)

Effort:
- Title: ${effort.title}
- Description: ${effort.description}
- Content preview: ${(effort.document ?? "").slice(0, 2000)}

Return JSON array of strings, max 5 tags: ["tag-1", "tag-2", ...]`;

  try {
    const url = `${AZURE_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": AZURE_API_KEY },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!resp.ok) return [];

    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const tags = JSON.parse(jsonMatch[0]) as string[];
    return tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.toLowerCase().trim().replace(/\s+/g, "-"))
      .slice(0, 5);
  } catch {
    return [];
  }
}
