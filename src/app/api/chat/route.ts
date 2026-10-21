import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
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
import { getChat, getMessages, saveMessage, touchChat } from "@/lib/db";
import { OLLAMA_CLOUD_BASE_URL, type UserKeys } from "@/lib/types";
import { APPROVAL_TOOLS, buildTools } from "@/lib/tools";

export const maxDuration = 300;

interface ChatRequestBody {
  messages?: UIMessage[];
  chatId?: string | null;
  keys?: UserKeys;
}

function systemPrompt(): string {
  return `You are a job-search outreach assistant. You help the user (1) find open roles, (2) find the right person at the company — a recruiter, talent/HR person, or the hiring manager, (3) get that person's work email, and (4) send a short, personal email from the user's own Gmail.

Today is ${new Date().toDateString()}.

Tools:
- find_jobs: search open roles by keywords and location.
- contacts_lookup: check first. The person and their email may already be known, and it shows who was already emailed (don't email the same person twice without asking).
- cleanlist_find_people (free, ~60 searches/day): people at one company. Use the website domain when you know it (e.g. stripe.com), company_name only when you don't. Recruiters: departments ["People & HR"] with title_keywords ["recruit", "talent"]. Hiring managers: the team's department (e.g. "Engineering") with seniority ["Manager", "Director", "Head"].
- cleanlist_enrich_person (1 CleanList credit, only charged when an email is found): get a work email. Pass the linkedin_url from cleanlist_find_people. Unless the user already named the person, recommend one and let them pick before paying. If it returns pending, use cleanlist_check_enrichment with the workflow_id.
- knowledge_search: look up the user's resume and notes before writing, so the email is specific.
- composio_send_email: sends from the user's connected Gmail/Outlook. When asked to write or draft an outreach email, call this with the finished email — the user reviews it in the app and clicks Send or Don't send. When the email is about a specific role, also pass job_title (and job_url if you have the posting link).
- composio_create_draft: saves the email to the user's Gmail drafts instead — only when they ask for a draft.
- tracker_save_job: save a job to the user's application tracker, or change its status — when they ask to save/track a job, or tell you they applied, interviewed, got an offer or were rejected.

Application tracker: when Google Sheets is connected, the app keeps a Google Sheet ("Outreach Tracker") with tabs Jobs, Contacts and Emails. Jobs the user saves (or clicks Find recruiter on), people whose email was found, and every sent email are logged automatically — no tool call needed for those. Results show whether they were logged.

How the app shows results:
- Tool results appear as cards the user can click: people (with "Get email" buttons), jobs (with "Save" and "Find recruiter"), found emails (with "Write email"), and emails (with Send / Don't send). So don't repeat lists of people or jobs, and don't paste the email text in your reply. Add a line or two instead — e.g. who you'd pick and why.
- Messages like "Get the work email for …", "Find the recruiter or hiring manager at …" or "Write a short outreach email to …" come from those buttons: they are the user's go-ahead, so do them right away.
- If the user clicks Don't send (or Don't save), stop: don't retry and don't take any other mailbox action unless they ask. Ask what to change.

Writing the email:
- 80–150 words, plain text, a short specific subject line.
- Name the role and company, one or two concrete qualifications from the user's background, and a clear, low-pressure ask.
- No placeholders like [Your Name]. Use real details from knowledge_search, or ask the user.

Rules:
- Never invent email addresses. Use only ones from cleanlist_enrich_person or contacts_lookup.
- Don't guess company domains when unsure. Ask, or search by company_name.
- Be concise. Ask at most one clarifying question at a time.`;
}

function resolveModel(keys: UserKeys) {
  switch (keys.llmProvider) {
    case "openai":
      return createOpenAI({ apiKey: keys.llmApiKey })(keys.llmModel);
    case "google":
      return createGoogleGenerativeAI({ apiKey: keys.llmApiKey })(keys.llmModel);
    case "ollama":
      // Ollama Cloud only implements /v1/chat/completions — its OpenAI-compat
      // layer rejects the Responses API (unknown "item_reference" items).
      return createOpenAI({
        baseURL: OLLAMA_CLOUD_BASE_URL,
        apiKey: keys.llmApiKey,
      }).chat(keys.llmModel);
    default:
      return createAnthropic({ apiKey: keys.llmApiKey })(keys.llmModel);
  }
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

  // The browser sends the whole thread. Upsert every message, not just new
  // ones, so edits to existing messages (an answered Send approval) are kept.
  const incoming = body.messages ?? [];
  for (const msg of incoming) {
    saveMessage(chatId, { id: msg.id, role: msg.role, data: msg });
  }
  // Auto-title only chats still using the default title — never clobber
  // titles the user renamed.
  touchChat(chatId, chat.title === "New chat" ? titleFrom(incoming) : undefined);

  const history = getMessages(chatId).map((m) => m.data as UIMessage);
  const { tools } = buildTools(keys);
  // Drops tool calls left unfinished by a stopped/failed turn, which would
  // otherwise make the provider reject the whole history.
  const modelMessages = await convertToModelMessages(history, {
    tools,
    ignoreIncompleteToolCalls: true,
  });

  const stream = createUIMessageStream({
    // Persistence mode: the response gets a stable id, and a reply to a Send
    // approval continues the same assistant message instead of a new one.
    originalMessages: history,
    execute: ({ writer }) => {
      const result = streamText({
        model: resolveModel(keys),
        instructions: systemPrompt(),
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
