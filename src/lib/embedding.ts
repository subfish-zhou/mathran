/**
 * Embedding generation module.
 * Tries Azure OpenAI text-embedding-3-small, falls back to keyword-based pseudo-embeddings.
 */

const EMBEDDING_DEPLOYMENT = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Get the Azure embedding endpoint and API key from centralized config.
 */
function getAzureEmbeddingConfig() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT ?? "";
  const apiKey = process.env.AZURE_OPENAI_API_KEY ?? "";
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";
  return { endpoint, apiKey, apiVersion };
}

/**
 * Generate an embedding vector for text.
 * Falls back to keyword-based vector if Azure embedding deployment is unavailable.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const truncated = text.slice(0, 8000);

  // Try Azure OpenAI embedding
  const { endpoint: AZURE_ENDPOINT, apiKey: AZURE_API_KEY, apiVersion: AZURE_API_VERSION } = getAzureEmbeddingConfig();
  if (AZURE_ENDPOINT && AZURE_API_KEY) {
    try {
      const url = `${AZURE_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${EMBEDDING_DEPLOYMENT}/embeddings?api-version=${AZURE_API_VERSION}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": AZURE_API_KEY,
        },
        body: JSON.stringify({ input: truncated, dimensions: EMBEDDING_DIMENSIONS }),
      });

      if (resp.ok) {
        const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
        if (data.data?.[0]?.embedding) {
          return data.data[0].embedding;
        }
      }
      // If deployment not found (404) or other error, fall through to keyword fallback
      console.warn(`[embedding] Azure API returned ${resp.status}, falling back to keyword search`);
    } catch (err) {
      console.warn("[embedding] Azure API error, falling back to keyword search:", err);
    }
  }

  // Fallback: simple hash-based pseudo-embedding for keyword matching
  return keywordEmbedding(truncated);
}

/**
 * Build effort text for embedding from title + description + document.
 */
export function buildEffortText(effort: {
  title: string;
  description?: string | null;
  document?: string | null;
}): string {
  const parts = [effort.title];
  if (effort.description) parts.push(effort.description);
  if (effort.document) parts.push(effort.document.slice(0, 8000));
  return parts.join("\n\n");
}

/**
 * Cosine similarity between two vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

/**
 * Keyword-based pseudo-embedding fallback.
 * Uses a deterministic hash to map words into fixed vector positions.
 */
function keywordEmbedding(text: string): number[] {
  const vec = new Float64Array(EMBEDDING_DIMENSIONS);
  const words = text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
  for (const word of words) {
    const h = hashString(word);
    const idx = Math.abs(h) % EMBEDDING_DIMENSIONS;
    vec[idx] += 1;
  }
  // Normalize
  let mag = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) mag += vec[i]! * vec[i]!;
  mag = Math.sqrt(mag);
  if (mag > 0) {
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) vec[i] = vec[i]! / mag;
  }
  return Array.from(vec);
}

// DJB2 hash — simple and fast but has known collision properties.
// For keyword-based pseudo-embeddings this is acceptable since collisions
// only slightly reduce discriminative power in the fallback vector.
function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash;
}
