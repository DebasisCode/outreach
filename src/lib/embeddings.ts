import type { UserKeys } from "@/lib/types";

/**
 * Embeddings via the user's own key. Supports Google (gemini embedding) and
 * OpenAI; anything else falls back to keyword search server-side.
 */

const EMBED_DIMS = {
  google: 768,
  openai: 1536,
} as const;

export interface EmbedClient {
  model: string;
  dims: number;
  embed: (texts: string[]) => Promise<number[][]>;
}

let cached: { sig: string; client: EmbedClient } | null = null;

export function getEmbedClient(keys: UserKeys): EmbedClient | null {
  const sig = `${keys.llmProvider}:${keys.llmApiKey}`;
  if (cached && cached.sig === sig) return cached.client;

  let client: EmbedClient | null = null;
  if (keys.llmProvider === "google" && keys.llmApiKey) {
    client = {
      model: "text-embedding-004",
      dims: EMBED_DIMS.google,
      embed: async (texts) => {
        const out: number[][] = [];
        for (const text of texts) {
          const res = (await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${keys.llmApiKey}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: "models/text-embedding-004",
                content: { parts: [{ text }] },
                outputDimensionality: EMBED_DIMS.google,
              }),
            },
          ).then((r) => r.json())) as {
            embedding?: { values?: number[] };
            error?: { message?: string };
          };
          if (!res.embedding?.values) {
            throw new Error(
              `Google embedding failed: ${res.error?.message ?? "no embedding"}`,
            );
          }
          out.push(res.embedding.values);
        }
        return out;
      },
    };
  } else if (keys.llmProvider === "openai" && keys.llmApiKey) {
    client = {
      model: "text-embedding-3-small",
      dims: EMBED_DIMS.openai,
      embed: async (texts) => {
        const res = (await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            authorization: `Bearer ${keys.llmApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: texts,
            dimensions: EMBED_DIMS.openai,
          }),
        }).then((r) => r.json())) as {
          data?: Array<{ embedding: number[] }>;
          error?: { message?: string };
        };
        if (!res.data) {
          throw new Error(`OpenAI embedding failed: ${res.error?.message ?? "none"}`);
        }
        return res.data.map((d) => d.embedding);
      },
    };
  }
  if (client) cached = { sig, client };
  // Never fall back to a client cached for a different provider/key.
  return client;
}