import { NextRequest } from "next/server";
import { chatContext } from "@/lib/context";
import {
  createChat,
  deleteChat,
  getChat,
  getMessages,
  listChats,
  touchChat,
} from "@/lib/db";

export const maxDuration = 30;

/** GET /api/chats -> { chats: [{id,title,createdAt,updatedAt}] } */
export async function GET() {
  return Response.json({ chats: listChats() });
}

/** POST -> create a chat up-front so the client owns the id from message 1. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  return Response.json({ chat: createChat(body.title ?? "New chat") });
}

/** DELETE /api/chats?id=... -> remove chat + its messages */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  deleteChat(id);
  return Response.json({ ok: true });
}

/**
 * PUT /api/chats { id } -> { messages: UIMessage[], context } — the thread for
 * useChat, plus how full the model's context is.
 */
export async function PUT(req: NextRequest) {
  const body = (await req.json()) as { id?: string };
  if (!body.id) return Response.json({ error: "Missing id" }, { status: 400 });
  const chat = getChat(body.id);
  if (!chat) return Response.json({ error: "Chat not found" }, { status: 404 });
  const rows = getMessages(body.id);
  touchChat(body.id);
  return Response.json({
    messages: rows.map((r) => r.data),
    context: chatContext(body.id),
  });
}

/** PATCH /api/chats { id, title } -> rename a chat */
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    title?: string;
  };
  const title = body.title?.trim();
  if (!body.id || !title) {
    return Response.json({ error: "Missing id or title" }, { status: 400 });
  }
  touchChat(body.id, title.slice(0, 100));
  return Response.json({ chat: getChat(body.id) });
}