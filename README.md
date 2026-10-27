# Outreach — a job-search agent

Chat with an AI agent that finds open roles, finds the recruiter or hiring
manager, gets their work email, and sends a short personal email from your own
Gmail — only after you click **Send**. It also fills in job applications in a
real browser window and submits them only after you click **Submit**. It's
keyboard-first, in the spirit of Claude Code and Codex.

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

For applying, fill in **Applicant profile** (ID-card icon, or `/profile`) and
upload your resume. Applications open in Google Chrome (or Edge) — install one
of them, or run `npx playwright install chromium`.

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
- **Applying in the browser.** Click **Apply** on a job (or `/apply <link>`).
  The app opens the application in a Chrome window on your computer, follows
  the posting's Apply button, fills everything your Applicant profile covers
  (name, contact, links, location, resume, voluntary self-ID → "decline"), and
  the assistant answers the rest from your profile, memory and resume — asking
  you for anything it doesn't know. Multi-page forms (Workday) are handled page
  by page. Before anything is sent you see the filled form and a screenshot,
  with **Submit / Don't submit**. Then the job is marked *Applied*. See
  [How applying works](#how-applying-works).
- **Browsing.** Ask it to do something on a website: it opens the page in the
  same window, reads it and clicks or types. Clicks that would submit, send,
  buy or delete something wait for your OK in the chat.
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
| Esc | Stop the assistant · decline a waiting email, application or browser action |
| Ctrl/⌘ + Enter | Approve it (send the email, submit the application…) |
| ↑ / ↓ in the chat box | Earlier prompts |
| `/` | Commands: `/jobs`, `/recruiter`, `/email`, `/apply`, `/profile`, `/compact`, `/memory`, `/remember`, `/tracker`, `/model`, `/export`, `/help`… |
| `#` | Remember a fact |

Messages typed while the assistant is working are queued and sent when it's
done. Hover a message to copy it, retry the last answer, or edit your last
message.

## How applying works

Built to keep working when job sites change, and to never do something you
didn't approve:

- **A real browser, yours to watch.** The app drives your installed Chrome
  through [Playwright](https://playwright.dev), in its own profile
  (`.data/browser-profile`), so sign-ins you make there (a Workday account,
  Google sign-in) are kept. You can watch, scroll and take over at any time.
- **Forms are read like a screen reader reads them** — by labels and ARIA
  roles, not CSS classes — across iframes (Greenhouse embeds) and shadow DOM.
  The only site-specific knowledge is URL shapes (Lever's `/apply`, Ashby's
  `/application`). Each question gets an id from its label, so ids survive
  re-renders, reloads and a crashed window; answers are saved and refilled.
- **Rules where the answer is certain, the AI where it takes judgment.** Name,
  email, phone, links, location and resume come from your profile; voluntary
  self-identification is answered "decline" unless your profile says
  otherwise. Sponsorship, salary, "why us?" and the like go to the assistant,
  which must use your profile, memory or resume — or ask you.
- **Every fill is checked** by reading the value back (masked phone inputs,
  custom dropdowns, hidden radio buttons each have fallbacks). Dropdown choices
  are matched sensibly: "No" → "No, I will not require sponsorship", "6" →
  "5-10 years", "USA" → "United States of America".
- **You stay in charge.** Submitting always waits for your click. The app never
  types passwords and never solves CAPTCHAs — it asks you to, then carries on.
  Only your resume file can be uploaded. Already-applied jobs aren't applied to
  twice.
- **Not automated:** LinkedIn, Indeed, Glassdoor and ZipRecruiter — their terms
  ban bots and accounts that use them get restricted. Use the company's own
  application link (job cards show it when Google Jobs has one).

Browser settings (environment variables, all optional):

| Variable | Effect |
| --- | --- |
| `OUTREACH_BROWSER_CDP_URL` | Attach to a Chrome you started with `--remote-debugging-port=9222 --user-data-dir=…` instead of opening a window |
| `OUTREACH_BROWSER_CHANNEL` | `chrome`, `msedge` or `chromium` (default: try Chrome, then Edge, then Playwright's Chromium) |
| `OUTREACH_BROWSER_PATH` | Path to a Chrome/Chromium executable |
| `OUTREACH_BROWSER_PROFILE` | Profile folder (default `.data/browser-profile`) |
| `OUTREACH_BROWSER_HEADLESS` | `1` to hide the window |
| `OUTREACH_BROWSER` | `off` to turn the browser tools off |

## Tests

```bash
npm test
```

Runs the form engine and the application flow against local pages built like
Greenhouse, Lever, Ashby and Workday forms (custom dropdowns, async location
search, cross-origin iframes, multi-page flows, sign-in walls, CAPTCHAs), in a
headless browser. Set `OUTREACH_BROWSER_PATH` if Chrome isn't installed.

## Code map

- `src/app/page.tsx` — the chat UI; `src/components/` — cards, composer, palette, dialogs
- `src/app/api/chat/route.ts` — the agent loop (AI SDK), memory and compaction
- `src/lib/tools.ts` — the tools the model can call
- `src/lib/composio.ts`, `src/lib/cleanlist.ts`, `src/lib/tracker.ts` — integrations
- `src/lib/context.ts` — trimming, compaction and token estimates
- `src/lib/browser/` — the browser engine: `session.ts` (the window), `inpage.ts` + `scan.ts` (reading forms), `fill.ts` (filling and checking), `match.ts` (answers and option matching), `flow.ts` (Apply / Next / Submit), `browse.ts` (general browsing)
- `src/lib/applications.ts` — applications step by step for the chat tools; `src/lib/applicant.ts` — the Applicant profile and resume file
- `src/lib/db.ts` — SQLite storage
