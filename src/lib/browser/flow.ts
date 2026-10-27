import type { Page } from "playwright-core";
import { fillField, probeOptions, type FillContext, type FillResult } from "@/lib/browser/fill";
import { normalize } from "@/lib/browser/match";
import { refLocator, runInPage, scanPage, settle, type Button, type Field, type PageScan } from "@/lib/browser/scan";
import { registerPage } from "@/lib/browser/session";

/**
 * Getting through an application, independent of the ATS:
 *  - openForm: go to the posting, follow its "Apply" button (also when it
 *    opens a new tab), stop at the form, a sign-in page or a CAPTCHA.
 *  - fillAnswers: fill fields by id, then look again for questions that
 *    appeared because of an answer ("If yes, which visa?").
 *  - goNext / submitForm: click Next or Submit and read what happened.
 *
 * The only site-specific knowledge is URL shapes (Lever's /apply, Ashby's
 * /application), which change far less often than page markup.
 */

const BLOCKED: Array<{ host: RegExp; name: string }> = [
  { host: /(^|\.)linkedin\.com$/i, name: "LinkedIn" },
  { host: /(^|\.)indeed\.[a-z.]+$/i, name: "Indeed" },
  { host: /(^|\.)glassdoor\.[a-z.]+$/i, name: "Glassdoor" },
  { host: /(^|\.)ziprecruiter\.[a-z.]+$/i, name: "ZipRecruiter" },
];

/** Sites whose terms ban automated applying (and restrict accounts that do it). */
export function blockedSite(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return BLOCKED.find((site) => site.host.test(host))?.name ?? null;
  } catch {
    return null;
  }
}

const ATS: Array<{ name: string; test: RegExp }> = [
  { name: "Greenhouse", test: /greenhouse\.io|[?&]gh_jid=/i },
  { name: "Lever", test: /lever\.co/i },
  { name: "Ashby", test: /ashbyhq\.com/i },
  { name: "Workday", test: /myworkdayjobs\.com|myworkdaysite\.com|workday\.com/i },
  { name: "Workable", test: /workable\.com/i },
  { name: "SmartRecruiters", test: /smartrecruiters\.com/i },
  { name: "iCIMS", test: /icims\.com/i },
  { name: "Jobvite", test: /jobvite\.com/i },
  { name: "BambooHR", test: /bamboohr\.com/i },
  { name: "Recruitee", test: /recruitee\.com/i },
  { name: "Teamtailor", test: /teamtailor\.com/i },
  { name: "Personio", test: /personio\.(de|com)/i },
  { name: "Breezy", test: /breezy\.hr/i },
  { name: "JazzHR", test: /applytojob\.com/i },
  { name: "Rippling", test: /rippling\.com|rippling-ats/i },
];

/** Which applicant tracking system serves this page (also via its iframes). */
export function detectAts(page: Page): string | null {
  const urls = [page.url(), ...page.frames().map((frame) => frame.url())];
  return ATS.find((ats) => urls.some((url) => ats.test.test(url)))?.name ?? null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The page with the form, when the URL shape says where it is. */
export function applicationUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (/(^|\.)lever\.co$/i.test(url.hostname) && new RegExp(`^/[^/]+/${UUID}$`, "i").test(path)) {
      url.pathname = `${path}/apply`;
    } else if (/(^|\.)ashbyhq\.com$/i.test(url.hostname) && new RegExp(`^/[^/]+/${UUID}$`, "i").test(path)) {
      url.pathname = `${path}/application`;
    } else if (url.hostname === "apply.workable.com" && /\/j\/[A-Z0-9]+$/i.test(path)) {
      url.pathname = `${path}/apply/`;
    }
    return url.toString();
  } catch {
    return raw;
  }
}

const words = (text: string) => normalize(text.replace(/[→›»>←‹«<]+/g, " "));

const APPLY =
  /^(apply|apply now|apply here|apply online|apply for (this )?(job|position|role|opportunity)|apply to (this )?(job|position|role)|start (your |my )?application|begin application|i m interested|im interested|apply manually|continue to (the )?application|submit (an |your )?application|easy apply)$/;
const APPLY_AVOID = /linkedin|indeed|seek|glassdoor|google|facebook|with (your )?(resume|cv|profile)|autofill|last application|dropbox|drive|refer|share|save|alert/;
const NEXT = /^(next|next step|next page|continue|save and continue|save continue|save and next|proceed|review|review application|continue to review|go to review)$/;
const SUBMIT =
  /^(submit|submit application|submit my application|submit your application|send application|send my application|apply|apply now|finish|finish application|complete|complete application|send)$/;

function pick(scan: PageScan, pattern: RegExp, avoid?: RegExp): Button | null {
  const matches = scan.buttons.filter((button) => {
    const text = words(button.text);
    return pattern.test(text) && !(avoid && avoid.test(text));
  });
  if (!matches.length) return null;
  // Prefer the frame that holds the form, real buttons over links, type=submit, and the last one on the page.
  const formFrame = mainFormFrame(scan);
  const score = (button: Button) =>
    (button.frame === formFrame ? 4 : 0) + (button.disabled ? -8 : 0) + (button.type === "submit" ? 2 : 0) + (button.inForm ? 1 : 0) + (button.link ? -1 : 0);
  return matches.reduce((best, button) => (score(button) >= score(best) ? button : best));
}

function mainFormFrame(scan: PageScan) {
  const counts = new Map<unknown, number>();
  for (const field of scan.fields) counts.set(field.frame, (counts.get(field.frame) ?? 0) + 1);
  let best: unknown = null;
  let most = 0;
  for (const [frame, count] of counts) if (count > most) [best, most] = [frame, count];
  return best;
}

export const findApplyButton = (scan: PageScan) => {
  const manual = scan.buttons.find((button) => words(button.text) === "apply manually");
  return manual ?? pick(scan, APPLY, APPLY_AVOID);
};
export const findNextButton = (scan: PageScan) => pick(scan, NEXT);
export const findSubmitButton = (scan: PageScan) => pick(scan, SUBMIT, /linkedin|indeed|later|draft/);

/** An application form is on screen (not just a search box or a newsletter sign-up). */
export function formPresent(scan: PageScan): boolean {
  const answerable = scan.fields.filter((field) => field.kind !== "checkbox");
  return answerable.length >= 3 || scan.fields.some((field) => field.kind === "file");
}

/** Something only the user can do: sign in, or solve a CAPTCHA. */
export function blocker(scan: PageScan): string | null {
  if (scan.captcha) {
    return "Solve the CAPTCHA (\"I'm not a robot\" check) in the browser window.";
  }
  if (scan.loginForm && !formPresent(scan)) {
    return "Sign in (or create an account) on this job site in the browser window. The app never types passwords; the sign-in is kept for next time.";
  }
  return null;
}

/** Click a button; returns the page that now shows the result (a new tab if one opened). */
export async function clickButton(page: Page, button: Button, key: string): Promise<Page> {
  const popup = page.context().waitForEvent("page", { timeout: 4_000 }).catch(() => null);
  const locator = refLocator(button.frame, button.ref);
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await locator.click({ timeout: 6_000 });
  } catch {
    await runInPage<boolean>(button.frame, "click", button.ref);
  }
  const opened = await popup;
  if (opened) {
    registerPage(key, opened);
    await settle(opened);
    return opened;
  }
  await settle(page);
  return page;
}

/** Wait until the page shows something new (another step, an error, a thank-you). */
export async function waitForChange(page: Page, before: PageScan, ms = 15_000): Promise<PageScan> {
  const deadline = Date.now() + ms;
  let scan = await scanPage(page);
  while (Date.now() < deadline) {
    const changed =
      scan.signature !== before.signature ||
      scan.errors.join("|") !== before.errors.join("|") ||
      (scan.confirmation && !before.confirmation) ||
      scan.captcha;
    if (changed) {
      await settle(page, 2_000);
      return scanPage(page);
    }
    await page.waitForTimeout(600);
    scan = await scanPage(page);
  }
  return scan;
}

/**
 * Go to `url` and get to the application form: follow up to three "Apply"
 * steps. Stops early at a sign-in page or a CAPTCHA.
 */
export async function openForm(page: Page, url: string, key: string): Promise<{ page: Page; scan: PageScan }> {
  await page.goto(applicationUrl(url), { waitUntil: "domcontentloaded" });
  await settle(page);
  let scan = await scanPage(page);
  for (let hop = 0; hop < 3; hop += 1) {
    if (formPresent(scan) || blocker(scan)) break;
    const apply = findApplyButton(scan);
    if (!apply) break;
    page = await clickButton(page, apply, key);
    scan = await waitForChange(page, scan, 10_000);
  }
  return { page, scan };
}

/**
 * Options for custom dropdowns that only render them when opened, so the
 * assistant can see the choices. Cached per field id.
 */
export async function addDropdownOptions(page: Page, scan: PageScan, cache: Map<string, string[]>): Promise<void> {
  let probes = 0;
  for (const field of scan.fields) {
    if (field.kind !== "combobox" || field.filled || field.options?.length) continue;
    let options = cache.get(field.key);
    if (!options && probes < 12) {
      probes += 1;
      options = await probeOptions(page, field);
      cache.set(field.key, options);
    }
    if (options?.length) field.options = options.map((label) => ({ label }));
  }
}

/** Fill `answers` (field id -> value) on the current page. */
export async function fillAnswers(
  page: Page,
  scan: PageScan,
  answers: Map<string, string>,
  context: FillContext,
): Promise<FillResult[]> {
  const results: FillResult[] = [];
  for (const [key, value] of answers) {
    const field = scan.fields.find((candidate) => candidate.key === key);
    if (!field) continue;
    results.push(await fillField(page, field, value, context));
  }
  return results;
}

export type SubmitOutcome =
  | { kind: "submitted"; confirmation: string | null; scan: PageScan; page: Page }
  | { kind: "needs_user"; reason: string; scan: PageScan; page: Page }
  | { kind: "errors"; errors: string[]; scan: PageScan; page: Page }
  | { kind: "unclear"; scan: PageScan; page: Page };

/** Click Submit and work out what happened. */
export async function submitForm(page: Page, scan: PageScan, button: Button, key: string): Promise<SubmitOutcome> {
  const before = scan;
  page = await clickButton(page, button, key);
  const deadline = Date.now() + 25_000;
  let after = await scanPage(page);
  let goneTwice = 0;
  while (Date.now() < deadline) {
    if (after.confirmation && (!before.confirmation || !formPresent(after))) {
      return { kind: "submitted", confirmation: after.confirmation, scan: after, page };
    }
    if (/thank|confirm|success|submitted|complete/i.test(new URL(after.url).pathname) && after.url !== before.url) {
      return { kind: "submitted", confirmation: after.confirmation, scan: after, page };
    }
    if (after.captcha) return { kind: "needs_user", reason: blocker(after) ?? "", scan: after, page };
    const newErrors = after.errors.filter((error) => !before.errors.includes(error));
    if (newErrors.length && formPresent(after)) return { kind: "errors", errors: after.errors, scan: after, page };
    // The form went away (seen twice, so a loading spinner doesn't count).
    if (formPresent(before) && !formPresent(after) && after.fields.length < 2 && !after.loginForm) {
      goneTwice += 1;
      if (goneTwice >= 2) return { kind: "submitted", confirmation: after.confirmation, scan: after, page };
    } else {
      goneTwice = 0;
    }
    await page.waitForTimeout(800);
    after = await scanPage(page);
  }
  return { kind: "unclear", scan: after, page };
}

/** Required fields still empty. */
export const missingRequired = (scan: PageScan): Field[] =>
  scan.fields.filter((field) => field.required && !field.filled && !field.disabled);
