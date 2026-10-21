import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { NextRequest } from "next/server";
import {
  AUTO_COMPACT_TOKENS,
  compactChat,
  estimateRequestTokens,
  hasPendingApproval,
  historyForModel,
} from "@/lib/context";
import {
  clearChatSummary,
  deleteMessagesNotIn,
  getChat,
  getChatSummary,
  getMessages,
  listMemories,
  saveMessage,
  touchChat,
} from "@/lib/db";
import { resolveModel } from "@/lib/models";
import { systemPrompt } from "@/lib/prompt";
import type { ContextInfo } from "@/lib/tool-outputs";
import { APPROVAL_TOOLS, buildTools } from "@/lib/tools";
import type { UserKeys } from "@/lib/types";

export const maxDuration = 300;

interface ChatRequestBody {
  messages?: UIMessage[];
  chatId?: string | null;
  keys?: UserKeys;
  /** "regenerate-message" when the user clicked Retry. */
  trigger?: string;
  /** The user edited an earlier message: what came after it is gone. */
  rewind?: boolean;
}

function titleFrom(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text =
    first?.parts.find((p): p is { type: "text"; text: string } => p.type === "text")
      ?.text ?? "New chat";
  return text.trim().slice(0, 60) || "New chat";
}

/** Local single-user app: show the real reason (bad key, unknown model...). */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatRequestBody;
  const keys = body.keys;
  if (!keys?.llmApiKey || !keys.llmModel || !keys.llmProvider) {
    return new Response("Missing LLM API key — add it in Settings.", { status: 401 });
  }
  if (!body.chatId) {
    return Response.json(
      { error: "Missing chatId — create a chat via POST /api/chats first." },
      { status: 400 },
    );
  }
  const chatId = body.chatId;
  const chat = getChat(chatId);
  if (!chat) {
    return Response.json({ error: "Chat not found — start a new chat." }, { status: 404 });
  }

  const incoming = body.messages ?? [];
  // Retry / Edit rewound the conversation: drop what the browser dropped.
  if (body.trigger === "regenerate-message" || body.rewind) {
    deleteMessagesNotIn(
      chatId,
      incoming.map((msg) => msg.id),
    );
  }
  // The browser sends the whole thread. Upsert every message, not just new
  // ones, so edits to existing messages (an answered Send approval) are kept.
  for (const msg of incoming) {
    saveMessage(chatId, { id: msg.id, role: msg.role, data: msg });
  }
  // Auto-title only chats still using the default title — never clobber
  // titles the user renamed.
  touchChat(chatId, chat.title === "New chat" ? titleFrom(incoming) : undefined);

  const model = resolveModel(keys);
  const { tools } = buildTools(keys);
  const memories = listMemories();
  const stored = getMessages(chatId).map((m) => m.data as UIMessage);

  let summary = getChatSummary(chatId);
  // A rewind can remove the message a summary ended at; then it no longer fits.
  if (summary && !stored.some((msg) => msg.id === summary?.upto)) {
    clearChatSummary(chatId);
    summary = null;
  }

  let history = historyForModel(stored, summary);
  let system = systemPrompt({ memories, summary: history.summary });
  let tokens = estimateRequestTokens(system, history.messages);
  let compacted = false;
  // Long chat: fold older turns into the summary before answering.
  if (tokens > AUTO_COMPACT_TOKENS && !hasPendingApproval(stored)) {
    try {
      const result = await compactChat(model, chatId, { keepTurns: 2 });
      if (result) {
        summary = result;
        history = historyForModel(stored, summary);
        system = systemPrompt({ memories, summary: history.summary });
        tokens = estimateRequestTokens(system, history.messages);
        compacted = true;
      }
    } catch (err) {
      console.error("Auto-compact failed; sending the full history:", err);
    }
  }

  // Drops tool calls left unfinished by a stopped/failed turn, which would
  // otherwise make the provider reject the whole history.
  const modelMessages = await convertToModelMessages(history.messages, {
    tools,
    ignoreIncompleteToolCalls: true,
  });
  const context: ContextInfo = {
    tokens,
    limit: AUTO_COMPACT_TOKENS,
    compactedUpto: history.summary ? (summary?.upto ?? null) : null,
    compacted,
  };

  const stream = createUIMessageStream({
    // Persistence mode: the response gets a stable id, and a reply to a Send
    // approval continues the same assistant message instead of a new one.
    originalMessages: stored,
    execute: ({ writer }) => {
      // Context meter for the status line; not stored with the message.
      writer.write({ type: "data-context", data: context, transient: true });
      const result = streamText({
        model,
        instructions: system,
        messages: modelMessages,
        tools,
        // Nothing touches the user's mailbox until they click in the chat.
        toolApproval: Object.fromEntries(
          APPROVAL_TOOLS.filter((name) => tools[name]).map((name) => [name, "user-approval"]),
        ),
        stopWhen: isStepCount(12),
      });
      writer.merge(
        toUIMessageStream({ stream: result.stream, sendReasoning: true, onError: describeError }),
      );
    },
    onError: describeError,
    onEnd: ({ responseMessage }) => {
      if (responseMessage.parts.length === 0) return;
      saveMessage(chatId, {
        id: responseMessage.id,
        role: "assistant",
        data: responseMessage,
      });
      touchChat(chatId);
    },
  });

  return createUIMessageStreamResponse({ stream });
}
