import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/**
 * The browser the assistant drives: a real, visible Chrome window on the
 * user's computer, in its own profile (.data/browser-profile) so sign-ins
 * made there (Workday accounts, Google sign-in…) are kept between runs.
 *
 * Settings (environment variables, all optional):
 *  - OUTREACH_BROWSER_CDP_URL   attach to a Chrome the user started with
 *                               --remote-debugging-port (their own profile)
 *  - OUTREACH_BROWSER_CHANNEL   "chrome" | "msedge" | "chromium"
 *  - OUTREACH_BROWSER_PATH      path to a Chrome/Chromium executable
 *  - OUTREACH_BROWSER_PROFILE   profile folder (default .data/browser-profile)
 *  - OUTREACH_BROWSER_HEADLESS  "1" to hide the window (tests, servers)
 *
 * Everything that touches the browser runs one at a time (withBrowser), so
 * two tool calls can never type into the same page at once. If the window is
 * closed or crashes, the next call starts a new one.
 */

interface Session {
  context: BrowserContext;
  browser: Browser | null;
  mode: "launched" | "attached";
  channel: string;
}

interface State {
  session: Session | null;
  starting: Promise<Session> | null;
  pages: Map<string, Page>;
  /** The tab browser_open / browser_act work on. */
  activeKey: string | null;
  queue: Promise<unknown>;
}

const globalState = globalThis as typeof globalThis & { __outreachBrowser?: State };
// Kept on globalThis so dev-server hot reloads don't orphan the window.
const state: State = (globalState.__outreachBrowser ??= {
  session: null,
  starting: null,
  pages: new Map(),
  activeKey: null,
  queue: Promise.resolve(),
});

export class BrowserError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "profile_in_use" | "timeout" | "closed" = "unavailable",
  ) {
    super(message);
  }
}

/** Browser tools are on unless OUTREACH_BROWSER=off (e.g. a server without a screen). */
export const browserEnabled = () => !/^(off|0|false|no)$/i.test(process.env.OUTREACH_BROWSER?.trim() ?? "");

const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 45_000;

const env = (name: string) => process.env[name]?.trim() || "";

export function profileDir(): string {
  return env("OUTREACH_BROWSER_PROFILE") || path.join(process.cwd(), ".data", "browser-profile");
}

function forget(context: BrowserContext) {
  if (state.session?.context !== context) return;
  state.session = null;
  state.pages.clear();
  state.activeKey = null;
}

async function attach(cdpUrl: string): Promise<Session> {
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
  } catch (err) {
    throw new BrowserError(
      `Couldn't attach to Chrome at ${cdpUrl}. Start Chrome with --remote-debugging-port and a --user-data-dir, or unset OUTREACH_BROWSER_CDP_URL to let the app open its own window. (${errorText(err)})`,
    );
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  browser.on("disconnected", () => forget(context));
  return { context, browser, mode: "attached", channel: "cdp" };
}

async function launch(): Promise<Session> {
  const executablePath = env("OUTREACH_BROWSER_PATH") || undefined;
  const headless = /^(1|true|yes)$/i.test(env("OUTREACH_BROWSER_HEADLESS"));
  const wanted = env("OUTREACH_BROWSER_CHANNEL");
  // The user's own Chrome first (no download needed), then Edge, then
  // Playwright's Chromium if `npx playwright install chromium` was run.
  const channels: Array<string | undefined> = executablePath
    ? [undefined]
    : wanted
      ? [wanted === "chromium" ? undefined : wanted]
      : ["chrome", "msedge", undefined];
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });

  const failures: string[] = [];
  for (const channel of channels) {
    try {
      const context = await chromium.launchPersistentContext(dir, {
        channel,
        executablePath,
        headless,
        viewport: null,
        acceptDownloads: false,
        timeout: 30_000,
        args: ["--no-first-run", "--no-default-browser-check"],
      });
      context.on("close", () => forget(context));
      return { context, browser: null, mode: "launched", channel: channel ?? "chromium" };
    } catch (err) {
      const text = errorText(err);
      if (/ProcessSingleton|SingletonLock|profile.*(in use|locked)|user data directory is already in use/i.test(text)) {
        throw new BrowserError(
          `The browser profile at ${dir} is already open in another window. Close that Chrome window (or the other Outreach server) and try again.`,
          "profile_in_use",
        );
      }
      failures.push(`${channel ?? executablePath ?? "chromium"}: ${text.split("\n")[0]}`);
    }
  }
  throw new BrowserError(
    `Couldn't open a browser. Install Google Chrome, or run "npx playwright install chromium", or set OUTREACH_BROWSER_PATH. Tried — ${failures.join(" | ")}`,
  );
}

async function session(): Promise<Session> {
  if (state.session) return state.session;
  if (!state.starting) {
    const cdpUrl = env("OUTREACH_BROWSER_CDP_URL");
    state.starting = (cdpUrl ? attach(cdpUrl) : launch())
      .then((started) => {
        started.context.setDefaultTimeout(ACTION_TIMEOUT_MS);
        started.context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        state.session = started;
        return started;
      })
      .finally(() => {
        state.starting = null;
      });
  }
  return state.starting;
}

export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  // Playwright appends long call logs; the first lines say what happened.
  return text.split("\nCall log:")[0].trim().slice(0, 600);
}

/**
 * Run browser work one call at a time, with an overall time limit. Every
 * Playwright step has its own shorter timeout, so the queue always moves on.
 */
export function withBrowser<T>(work: () => Promise<T>, timeoutMs = 150_000): Promise<T> {
  const task = state.queue.then(work);
  state.queue = task.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BrowserError("The browser took too long. The page may still be loading — try again.", "timeout")),
      timeoutMs,
    );
  });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

/** The tab for `key` (an application id, or "browse"), opened if needed. */
export async function pageFor(key: string, options: { create?: boolean } = {}): Promise<{ page: Page; fresh: boolean } | null> {
  const existing = state.pages.get(key);
  if (existing && !existing.isClosed()) return { page: existing, fresh: false };
  if (options.create === false) return null;
  const { context } = await session();
  const used = new Set(state.pages.values());
  // Reuse the empty tab a new window opens with, instead of leaving it around.
  const blank = context.pages().find((page) => !used.has(page) && page.url() === "about:blank");
  const page = blank ?? (await context.newPage());
  registerPage(key, page);
  return { page, fresh: true };
}

/** Track `page` as the tab for `key` (e.g. when an Apply button opened a new tab). */
export function registerPage(key: string, page: Page): void {
  state.pages.set(key, page);
  page.once("close", () => {
    if (state.pages.get(key) === page) state.pages.delete(key);
  });
}

export function livePage(key: string): Page | null {
  const page = state.pages.get(key);
  return page && !page.isClosed() ? page : null;
}

export function setActivePage(key: string): void {
  state.activeKey = key;
}

export function activePage(): { key: string; page: Page } | null {
  const key = state.activeKey;
  const page = key ? livePage(key) : null;
  return key && page ? { key, page } : null;
}

export function browserStatus(): { running: boolean; mode: string | null; tabs: number } {
  return {
    running: Boolean(state.session),
    mode: state.session ? `${state.session.mode}:${state.session.channel}` : null,
    tabs: [...state.pages.values()].filter((page) => !page.isClosed()).length,
  };
}

/** Bring a tab to the front so the user can see it (or take over). */
export async function showPage(key?: string | null): Promise<boolean> {
  const page = (key ? livePage(key) : null) ?? activePage()?.page ?? null;
  if (!page) return false;
  await page.bringToFront();
  return true;
}

export async function closeBrowser(): Promise<void> {
  const current = state.session;
  state.session = null;
  state.pages.clear();
  state.activeKey = null;
  if (!current) return;
  // An attached Chrome is the user's own: just let go of it.
  if (current.mode === "attached") return;
  await current.context.close().catch(() => undefined);
}
