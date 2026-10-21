import { NextRequest } from "next/server";
import { deleteKnowledge, knowledgeCount, listKnowledge } from "@/lib/db";
import { storeKnowledge } from "@/lib/knowledge";
import type { UserKeys } from "@/lib/types";

export const maxDuration = 120;

export async function GET() {
  return Response.json({
    count: knowledgeCount(),
    items: listKnowledge(100).map((c) => ({
      id: c.id,
      title: c.title,
      preview: c.content.slice(0, 120),
      createdAt: c.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    keys?: UserKeys;
    title?: string;
    text?: string;
  };
  const keys = body.keys;
  if (!keys) return Response.json({ error: "Missing keys" }, { status: 400 });
  if (!body.text?.trim()) {
    return Response.json({ error: "Missing text" }, { status: 400 });
  }

  const result = await storeKnowledge(keys, body.title ?? null, body.text);
  return Response.json(result);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  deleteKnowledge(id);
  return Response.json({ count: knowledgeCount() });
}