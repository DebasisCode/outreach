import { getEmbedClient } from "@/lib/embeddings";
import { insertKnowledge, knowledgeCount } from "@/lib/db";
import type { UserKeys } from "@/lib/types";

export const CHUNK_SIZE = 1200;
export const CHUNK_OVERLAP = 150;

export function chunkKnowledgeText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= CHUNK_SIZE) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      const breakAt = clean.lastIndexOf("\n", end);
      if (breakAt > start + CHUNK_SIZE / 2) end = breakAt + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter(Boolean);
}

/** Chunk + (best-effort) embed + persist a text blob into the knowledge base. */
export async function storeKnowledge(
  keys: UserKeys,
  title: string | null,
  text: string,
): Promise<{ stored: number; embedded: boolean; total: number }> {
  const chunks = chunkKnowledgeText(text);
  if (chunks.length === 0) {
    throw new Error("Nothing to store");
  }
  const embed = getEmbedClient(keys);
  if (embed) {
    const vectors = await embed.embed(chunks);
    vectors.forEach((embedding, i) =>
      insertKnowledge({
        title,
        content: chunks[i],
        embedding,
        model: embed.model,
      }),
    );
  } else {
    chunks.forEach((content) =>
      insertKnowledge({ title, content, model: "keyword" }),
    );
  }
  return { stored: chunks.length, embedded: Boolean(embed), total: knowledgeCount() };
}