import type { UIMessage } from "ai";
import { NextRequest } from "next/server";
import { chatContext, compactChat, hasPendingApproval } from "@/lib/context";
import { getChat, getMessages } from "@/lib/db";
import { resolveModel } from "@/lib/models";
import type { UserKeys } from "@/lib/types";

export const maxDuration = 120;

/**
 * POST { chatId, keys, focus? } -> /compact: summarize the whole chat so the
 * next message starts from the summary instead of the full history.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    chatId?: string;
    keys?: UserKeys;
    focus?: string;
  };
  const keys = body.keys;
  if (!keys?.llmApiKey || !keys.llmModel || !keys.llmProvider) {
    return Response.json({ error: "Add your LLM key in Settings first." }, { status: 401 });
  }
  if (!body.chatId || !getChat(body.chatId)) {
    return Response.json({ error: "Chat not found." }, { status: 404 });
  }
  const messages = getMessages(body.chatId).map((row) => row.data as UIMessage);
  if (hasPendingApproval(messages)) {
    return Response.json(
      { error: "An email is waiting for Send / Don't send — answer it first." },
      { status: 409 },
    );
  }
  try {
    const result = await compactChat(resolveModel(keys), body.chatId, {
      keepTurns: 0,
      focus: body.focus,
    });
    return Response.json({
      compacted: Boolean(result),
      summary: result?.summary ?? null,
      context: chatContext(body.chatId),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Couldn't compact: ${message.slice(0, 300)}` },
      { status: 500 },
    );
  }
}
