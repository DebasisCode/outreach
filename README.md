# Outreach — a job-search agent

Chat with an AI agent that finds open roles, finds the recruiter or hiring
manager, gets their work email, and sends a short personal email from your own
Gmail — only after you click **Send**. It's keyboard-first, in the spirit of
Claude Code and Codex.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000, then add your keys under **API keys** (Ctrl+,):

| Key | Used for |
| --- | --- |
| LLM (Anthropic, OpenAI, Gemini or Ollama Cloud) | the assistant |
| CleanList | people search (free) and work emails (1 credit per email found) |
| Composio | job search, sending email, the Google Sheets tracker |

Then connect accounts under **Connections** (plug icon): Gmail or Outlook to
send, Google Sheets for the tracker, SerpAPI (optional) for Google Jobs.

Everything is stored locally in `.data/outreach.db` (SQLite), keys included.

## What it does

- **Jobs → people → email → send.** Results show as cards with buttons: *Find
  recruiter* on a job, *Get email* on a person, *Write email* on a found email,
  *Send / Don't send* on the email itself.
- **Application tracker.** With Google Sheets connected, an "Outreach Tracker"
  sheet keeps Jobs (with a Status column you can edit), Contacts and Emails up
  to date automatically.
- **Memory.** Facts about you that the assistant knows in every chat (like a
  `CLAUDE.md`). Start a message with `#` to add one, open `/memory` to edit, or
  just tell the assistant — it saves them itself.
- **Knowledge base.** Upload your resume and notes; the assistant searches them
  when writing.
- **Context that stays small.** Older tool results are trimmed for the model,
  `/compact` summarizes a long chat, and it auto-compacts near the limit. The
  status line shows how full the context is.

## Keyboard

| Keys | Action |
| --- | --- |
| Ctrl/⌘ + 0 | New chat |
| Ctrl/⌘ + K | Command palette (actions, chats, model switcher) |
| Ctrl/⌘ + B | Show or hide the sidebar |
| Ctrl/⌘ + / | All shortcuts and commands |
| Ctrl/⌘ + , | API keys |
| Alt + ↑ / ↓ | Previous / next chat |
| Esc | Stop the assistant · decline a waiting email |
| Ctrl/⌘ + Enter | Send the waiting email |
| ↑ / ↓ in the chat box | Earlier prompts |
| `/` | Commands: `/jobs`, `/recruiter`, `/email`, `/compact`, `/memory`, `/remember`, `/tracker`, `/model`, `/export`, `/help`… |
| `#` | Remember a fact |

Messages typed while the assistant is working are queued and sent when it's
done. Hover a message to copy it, retry the last answer, or edit your last
message.

## Code map

- `src/app/page.tsx` — the chat UI; `src/components/` — cards, composer, palette, dialogs
- `src/app/api/chat/route.ts` — the agent loop (AI SDK), memory and compaction
- `src/lib/tools.ts` — the tools the model can call
- `src/lib/composio.ts`, `src/lib/cleanlist.ts`, `src/lib/tracker.ts` — integrations
- `src/lib/context.ts` — trimming, compaction and token estimates
- `src/lib/db.ts` — SQLite storage
