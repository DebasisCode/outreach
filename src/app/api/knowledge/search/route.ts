import { NextRequest } from "next/server";
import { allKnowledge, ftsSearchKnowledge, searchContacts } from "@/lib/db";
import { getEmbedClient } from "@/lib/embeddings";
import type { UserKeys } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    keys?: UserKeys;
    query?: string;
    limit?: number;
  };
  if (!body.query?.trim()) {
    return Response.json({ results: [], contacts: [] });
  }
  const keys = body.keys ?? {
    llmApiKey: "",
    llmProvider: "anthropic" as const,
    llmModel: "",
    cleanlistApiKey: "",
    composioApiKey: "",
    composioUserId: "default",
  };

  let results: Array<{ title: string | null; content: string; score: number }> = [];
  const embed = getEmbedClient(keys);
  if (embed) {
    const [queryVec] = await embed.embed([body.query]);
    const scored = allKnowledge()
      .filter((c) => c.embedding?.length === queryVec.length)
      .map((c) => ({
        chunk: c,
        score: queryVec.reduce(
          (dot, v, i) => dot + v * (c.embedding as number[])[i],
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, body.limit ?? 8);
    results = scored.map((s) => ({
      title: s.chunk.title,
      content: s.chunk.content,
      score: Number(s.score.toFixed(4)),
    }));
  } else {
    results = ftsSearchKnowledge(body.query, body.limit ?? 8).map((c) => ({
      title: c.title,
      content: c.content,
      score: 0,
    }));
  }

  return Response.json({ results, contacts: searchContacts(body.query, 8) });
}