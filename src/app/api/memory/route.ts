import { NextRequest } from "next/server";
import { addMemory, deleteMemory, listMemories, updateMemory } from "@/lib/db";

const failure = (err: unknown, status = 400) =>
  Response.json({ error: err instanceof Error ? err.message : "Failed" }, { status });

/** GET -> { memories } (what the assistant always knows about the user) */
export async function GET() {
  return Response.json({ memories: listMemories() });
}

/** POST { content } -> add a fact (typed with # or in the Memory panel) */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { content?: string };
  try {
    return Response.json({ memory: addMemory(body.content ?? "", "user") });
  } catch (err) {
    return failure(err);
  }
}

/** PATCH { id, content } -> edit a fact */
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { id?: string; content?: string };
  if (!body.id) return failure(new Error("Missing id"));
  try {
    const memory = updateMemory(body.id, body.content ?? "");
    return memory ? Response.json({ memory }) : failure(new Error("Not found"), 404);
  } catch (err) {
    return failure(err);
  }
}

/** DELETE ?id= -> forget a fact */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return failure(new Error("Missing id"));
  return deleteMemory(id) ? Response.json({ ok: true }) : failure(new Error("Not found"), 404);
}
