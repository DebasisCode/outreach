/**
 * Slash commands for the chat box, Claude Code style: type "/" to see them.
 * Commands with `prompt` become a message to the assistant; the rest are run
 * by the app (see runCommand in page.tsx).
 */
export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  /** Argument hint: "<…>" is required, "[…]" optional. */
  args?: string;
  /** Turns the command into a message to the assistant. */
  prompt?: (args: string) => string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "new", aliases: ["clear"], description: "Start a new chat" },
  {
    name: "jobs",
    args: "<role, location>",
    description: "Search open roles",
    prompt: (args) => `Find jobs: ${args}`,
  },
  {
    name: "recruiter",
    args: "<company or domain>",
    description: "Find the recruiter or hiring manager",
    prompt: (args) => `Find the recruiter or hiring manager at ${args}.`,
  },
  {
    name: "email",
    args: "<person or address>",
    description: "Write an outreach email",
    prompt: (args) => `Write a short outreach email to ${args}.`,
  },
  {
    name: "apply",
    args: "<job link>",
    description: "Fill in a job application in the browser (you approve before it's submitted)",
    prompt: (args) => `Apply to this job: ${args}`,
  },
  { name: "profile", description: "Applicant profile & resume used for applications" },
  { name: "compact", args: "[focus]", description: "Summarize this chat to free up context" },
  { name: "memory", description: "See and edit what the assistant remembers about you" },
  { name: "remember", args: "<fact>", description: "Save a fact to memory (same as # fact)" },
  { name: "tracker", description: "Open your Google Sheet tracker" },
  { name: "contacts", description: "Saved contacts" },
  { name: "knowledge", description: "Knowledge base: resume, notes" },
  { name: "connections", description: "Connected accounts: Gmail, Google Sheets…" },
  { name: "model", description: "Switch the AI model" },
  { name: "keys", aliases: ["settings"], description: "API keys" },
  { name: "theme", description: "Switch between light and dark" },
  { name: "rename", args: "<title>", description: "Rename this chat" },
  { name: "export", description: "Download this chat as Markdown" },
  { name: "shortcuts", description: "Keyboard shortcuts" },
  { name: "help", description: "Commands and shortcuts" },
];

export const requiresArgs = (command: SlashCommand) => command.args?.startsWith("<") ?? false;

export function findCommand(name: string): SlashCommand | undefined {
  const key = name.toLowerCase();
  return SLASH_COMMANDS.find((command) => command.name === key || command.aliases?.includes(key));
}

/** "/rename Stripe follow-up" -> { name: "rename", args: "Stripe follow-up" } */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() } : null;
}

/** Commands whose name starts with the query first, then ones that mention it. */
export function matchCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return SLASH_COMMANDS;
  const names = (command: SlashCommand) => [command.name, ...(command.aliases ?? [])];
  const starts = SLASH_COMMANDS.filter((command) => names(command).some((n) => n.startsWith(q)));
  const mentions = SLASH_COMMANDS.filter(
    (command) =>
      !starts.includes(command) &&
      (names(command).some((n) => n.includes(q)) || command.description.toLowerCase().includes(q)),
  );
  return [...starts, ...mentions];
}
