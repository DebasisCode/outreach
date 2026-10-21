import { generateText, getToolName, isToolUIPart, type LanguageModel, type UIMessage } from "ai";
import {
  getChatSummary,
  getMessages,
  listMemories,
  setChatSummary,
  type CompactionSummary,
} from "@/lib/db";
import { systemPrompt } from "@/lib/prompt";
import type { ContextInfo } from "@/lib/tool-outputs";

/**
 * Keeping the model's context small, the way coding agents do:
 *  - trimOldToolOutputs: tool results from earlier turns shrink to what later
 *    turns use (names, titles, LinkedIn URLs, job links).
 *  - compactChat: older messages are folded into an LLM-written summary —
 *    on /compact, or automatically once a chat passes AUTO_COMPACT_TOKENS.
 *    The chat itself stays visible; only what the model reads shrinks.
 *  - estimates: ~4 characters per token, good enough for the context meter.
 */

/** Compact automatically once the next request would pass this. */
export const AUTO_COMPACT_TOKENS = 40_000;
/** Rough size of the tool definitions sent with every request. */
const TOOL_DEFINITIONS_TOKENS = 3_000;
/** User turns kept word for word (with full tool results). */
const RECENT_TURNS = 2;
const TRIM_OVER_CHARS = 1_200;

type Part = UIMessage["parts"][number];
type Json = Record<string, unknown>;

const tokensFor = (chars: number) => Math.ceil(chars / 4);

const asText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");

/** Characters the model reads for these messages (text and tool calls). */
function messageChars(messages: UIMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") chars += part.text.length;
      else if (isToolUIPart(part)) {
        chars += asText(part.input).length;
        if (part.state === "output-available") chars += asText(part.output).length;
      }
    }
  }
  return chars;
}

/** Index where the last `turns` user turns start; turns = 0 means "nothing is recent". */
function recentStart(messages: UIMessage[], turns: number): number {
  if (turns <= 0) return messages.length;
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      seen += 1;
      if (seen === turns) return index;
    }
  }
  return 0;
}

function pickJson(text: string, pick: (data: Json) => unknown): string | null {
  try {
    return JSON.stringify(pick(JSON.parse(text) as Json));
  } catch {
    return null;
  }
}

const list = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((item): item is Json => !!item && typeof item === "object") : [];

const clip = (text: string) => `${text.slice(0, TRIM_OVER_CHARS)}… (trimmed)`;

/** A tool result reduced to what later turns rely on. */
function shrinkOutput(toolName: string, text: string): string {
  if (text.length <= TRIM_OVER_CHARS) return text;
  switch (toolName) {
    case "cleanlist_find_people":
      return (
        pickJson(text, (data) => ({
          company_domain: data.company_domain,
          total_matches: data.total_matches,
          people: list(data.people)
            .slice(0, 20)
            .map((p) => ({ name: p.name, title: p.title, linkedin_url: p.linkedin_url, email: p.email })),
        })) ?? clip(text)
      );
    case "find_jobs":
      return (
        pickJson(text, (data) => ({
          source: data.source,
          jobs: list(data.jobs).map((j) => ({
            title: j.title,
            company: j.company,
            company_domain: j.company_domain,
            url: j.url,
          })),
        })) ?? clip(text)
      );
    case "contacts_lookup":
      return (
        pickJson(text, (data) => ({
          contacts: list(data.contacts).map((c) => ({
            name: c.name,
            email: c.email,
            company: c.company,
            last_emailed: c.last_emailed,
          })),
        })) ?? clip(text)
      );
    case "knowledge_search":
      return "(Knowledge base results from an earlier turn — search again if you need them.)";
    default:
      return clip(text);
  }
}

function shrinkPart(part: Part): Part {
  if (!isToolUIPart(part) || part.state !== "output-available") return part;
  const text = asText(part.output);
  if (text.length <= TRIM_OVER_CHARS) return part;
  return { ...part, output: shrinkOutput(getToolName(part), text) } as Part;
}

/** Earlier turns keep their tool calls, with smaller results. */
export function trimOldToolOutputs(messages: UIMessage[]): UIMessage[] {
  const cutoff = recentStart(messages, RECENT_TURNS);
  return messages.map((message, index) =>
    index >= cutoff ? message : { ...message, parts: message.parts.map(shrinkPart) },
  );
}

/** What the model gets: messages after the compaction point, trimmed. */
export function historyForModel(
  messages: UIMessage[],
  summary: CompactionSummary | null,
): { messages: UIMessage[]; summary: string | null } {
  if (summary) {
    const index = messages.findIndex((message) => message.id === summary.upto);
    if (index >= 0) {
      return { messages: trimOldToolOutputs(messages.slice(index + 1)), summary: summary.summary };
    }
  }
  return { messages: trimOldToolOutputs(messages), summary: null };
}

export function estimateRequestTokens(system: string, messages: UIMessage[]): number {
  return tokensFor(system.length + messageChars(messages)) + TOOL_DEFINITIONS_TOKENS;
}

/** The context meter for a stored chat (shown when it is opened). */
export function chatContext(chatId: string): ContextInfo {
  const messages = getMessages(chatId).map((row) => row.data as UIMessage);
  const summary = getChatSummary(chatId);
  const history = historyForModel(messages, summary);
  const system = systemPrompt({ memories: listMemories(), summary: history.summary });
  return {
    tokens: estimateRequestTokens(system, history.messages),
    limit: AUTO_COMPACT_TOKENS,
    compactedUpto: history.summary ? (summary?.upto ?? null) : null,
  };
}

/** True while an email is waiting for (or just got) the user's Send click. */
export function hasPendingApproval(messages: UIMessage[]): boolean {
  return Boolean(
    messages
      .at(-1)
      ?.parts.some(
        (part) =>
          isToolUIPart(part) &&
          (part.state === "approval-requested" || part.state === "approval-responded"),
      ),
  );
}

function transcript(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${part.text.trim()}`);
      } else if (isToolUIPart(part)) {
        const name = getToolName(part);
        const input = asText(part.input);
        const result =
          part.state === "output-available"
            ? shrinkOutput(name, asText(part.output))
            : part.state === "output-error"
              ? `error: ${part.errorText}`
              : part.state === "output-denied"
                ? "declined by the user"
                : part.state;
        lines.push(`[${name} ${input.slice(0, 2_000)} → ${result}]`);
      }
    }
  }
  return lines.join("\n");
}

const SUMMARY_INSTRUCTIONS = `You compress a job-search outreach conversation so it can continue without the full history.
Write a concise summary (at most about 350 words) under these headings, skipping empty ones:
- Goal & preferences: what the user is looking for and how they want things done.
- Jobs: roles considered (title, company, link) and where each stands.
- People: name, title, company, LinkedIn URL, and work email with its status when found.
- Emails: who was emailed (address, subject) or drafted, and anything the user declined.
- Open threads: what was about to happen next, or questions left unanswered.
Keep exact email addresses, URLs, names and numbers. Plain text, no commentary.`;

export async function summarizeConversation(
  model: LanguageModel,
  messages: UIMessage[],
  previous: string | null,
  focus?: string,
): Promise<string> {
  const { text } = await generateText({
    model,
    instructions: SUMMARY_INSTRUCTIONS,
    prompt: `${previous ? `Summary of the conversation before this part:\n${previous}\n\n` : ""}Conversation to fold into the summary:\n${transcript(messages)}${
      focus?.trim() ? `\n\nThe user asked the summary to focus on: ${focus.trim()}` : ""
    }`,
  });
  const summary = text.trim();
  if (!summary) throw new Error("The model returned an empty summary.");
  return summary;
}

/**
 * Fold everything except the last `keepTurns` user turns into the chat's
 * summary. Returns null when there was nothing to compact.
 */
export async function compactChat(
  model: LanguageModel,
  chatId: string,
  options: { keepTurns: number; focus?: string },
): Promise<CompactionSummary | null> {
  const messages = getMessages(chatId).map((row) => row.data as UIMessage);
  const existing = getChatSummary(chatId);
  const covered = existing ? messages.findIndex((message) => message.id === existing.upto) : -1;
  const start = covered + 1;
  const end = Math.max(start, recentStart(messages, options.keepTurns));
  const fold = messages.slice(start, end);
  if (fold.length === 0) return null;

  const summary = await summarizeConversation(
    model,
    fold,
    covered >= 0 && existing ? existing.summary : null,
    options.focus,
  );
  const upto = fold[fold.length - 1].id;
  setChatSummary(chatId, summary, upto);
  return { summary, upto, at: Date.now() };
}
