import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { getApplicantProfile, getResumeInfo, resumePath } from "@/lib/applicant";
import { oneLine, type FillResult } from "@/lib/browser/fill";
import {
  addDropdownOptions,
  blockedSite,
  blocker,
  clickButton,
  detectAts,
  fillAnswers,
  findApplyButton,
  findNextButton,
  findSubmitButton,
  formPresent,
  missingRequired,
  openForm,
  submitForm,
  waitForChange,
} from "@/lib/browser/flow";
import { profileAnswer } from "@/lib/browser/match";
import { scanPage, settle, type Field, type PageScan } from "@/lib/browser/scan";
import { errorText, livePage, pageFor, setActivePage, withBrowser } from "@/lib/browser/session";
import {
  createApplication,
  DATA_DIR,
  findApplicationByJobUrl,
  getApplication,
  setJobStatus,
  updateApplication,
  type ApplicationRow,
  type ApplicationStatus,
} from "@/lib/db";
import type { ApplicationFieldSummary, ApplicationOutput } from "@/lib/tool-outputs";

/**
 * Job applications, step by step, for the chat tools:
 *
 *   start  -> open the posting, reach the form, fill what the profile knows
 *   answer -> fill the assistant's answers (by field id), look again
 *   next   -> multi-page forms: go to the next page and fill it
 *   check  -> after the user did something in the window (sign-in, CAPTCHA)
 *   submit -> only after the user clicked Submit in the chat
 *
 * Every step returns the same picture of the form (what's filled, what's
 * still needed, what to do next). Answers are saved, so if the window was
 * closed or crashed the next step reopens the page and fills them again.
 */

const SCREENSHOT_DIR = path.join(DATA_DIR, "applications");

const globalCache = globalThis as typeof globalThis & { __outreachOptionCache?: Map<string, Map<string, string[]>> };
// Options of custom dropdowns, per application, so they're only probed once.
const optionCache = (globalCache.__outreachOptionCache ??= new Map());

const optionsFor = (id: string) => {
  let cache = optionCache.get(id);
  if (!cache) optionCache.set(id, (cache = new Map()));
  return cache;
};

const MAX_OPTIONS = 25;
const MAX_OPTIONAL_NEEDS = 15;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function summarizeField(field: Field, error?: string): ApplicationFieldSummary {
  const options = field.options?.map((option) => option.label).filter(Boolean) ?? [];
  const hint = field.kind === "file" && !/resume|cv/i.test(field.label)
    ? "Only the resume is attached automatically — the user can attach this in the browser window."
    : field.description || field.placeholder || undefined;
  return {
    id: field.key,
    label: oneLine(field.label || "(no label)", 160),
    kind: field.kind,
    required: field.required || undefined,
    options: options.length ? options.slice(0, MAX_OPTIONS) : undefined,
    more_options: options.length > MAX_OPTIONS ? options.length - MAX_OPTIONS : undefined,
    current: field.value ? oneLine(field.value, 80) : undefined,
    hint: hint ? oneLine(hint, 160) : undefined,
    error,
  };
}

async function screenshot(app: ApplicationRow, page: Page): Promise<string | null> {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = `${app.id}.jpg`;
    const buffer = await page.screenshot({ type: "jpeg", quality: 55, fullPage: true, timeout: 15_000, animations: "disabled" });
    fs.writeFileSync(path.join(SCREENSHOT_DIR, file), buffer);
    return file;
  } catch {
    return null;
  }
}

export function screenshotPath(app: ApplicationRow): string | null {
  if (!app.screenshot) return null;
  const file = path.join(SCREENSHOT_DIR, path.basename(app.screenshot));
  return fs.existsSync(file) ? file : null;
}

interface PassResult {
  scan: PageScan;
  results: FillResult[];
  /** Answers given for fields that aren't on this page. */
  missing: string[];
}

/**
 * Fill the page: explicit answers first, then saved answers and the profile
 * for empty fields. Repeats (up to 3 rounds) for questions that appear after
 * an answer.
 */
async function fillPass(app: ApplicationRow, page: Page, explicit: Map<string, string>): Promise<PassResult> {
  const profile = getApplicantProfile();
  const context = { resumePath: resumePath() };
  const saved = new Map(Object.entries(app.answers));
  const attempted = new Set<string>();
  const used = new Map<string, string>();
  const results: FillResult[] = [];
  let scan = await scanPage(page);
  const present = new Set(scan.fields.map((field) => field.key));
  const missing = [...explicit.keys()].filter((key) => !present.has(key));

  for (let round = 0; round < 3; round += 1) {
    const todo = new Map<string, string>();
    for (const field of scan.fields) {
      if (attempted.has(field.key) || field.disabled) continue;
      const given = explicit.get(field.key);
      if (given !== undefined) {
        todo.set(field.key, given);
        continue;
      }
      if (field.filled) continue;
      const value = saved.get(field.key) ?? profileAnswer(field, profile);
      if (value) todo.set(field.key, value);
    }
    if (!todo.size) break;
    for (const [key, value] of todo) {
      attempted.add(key);
      used.set(key, value);
    }
    results.push(...(await fillAnswers(page, scan, todo, context)));
    scan = await scanPage(page);
  }

  const answers = { ...app.answers };
  for (const result of results) {
    if (result.ok) answers[result.key] = used.get(result.key) ?? "";
  }
  updateApplication(app.id, { answers });
  return { scan, results, missing };
}

function statusOf(scan: PageScan): { status: ApplicationStatus; userAction?: string; nextStep: string } {
  const block = blocker(scan);
  if (block) {
    return {
      status: "needs_user",
      userAction: block,
      nextStep: "Tell the user exactly what to do in the browser window. When they say it's done, call browser_apply_check.",
    };
  }
  if (scan.confirmation && !formPresent(scan)) {
    return { status: "submitted", nextStep: "The page says the application went through." };
  }
  if (!scan.fields.length) {
    // A review page: nothing to fill, only Submit. (A posting's "Apply" button doesn't count.)
    const submit = findSubmitButton(scan);
    if (submit && /submit|send|finish|complete/i.test(submit.text)) {
      return {
        status: "ready_to_submit",
        nextStep: "This is the review page: call browser_apply_submit — the user reviews the form and clicks Submit in the chat.",
      };
    }
    return {
      status: "needs_user",
      userAction: "I couldn't find the application form on this page. Open it in the browser window (click Apply or sign in), then tell me.",
      nextStep: "Ask the user to open the form in the browser window, then call browser_apply_check.",
    };
  }
  if (missingRequired(scan).length) {
    return {
      status: "needs_answers",
      nextStep:
        "Answer the required fields in `needs` with browser_apply_fill, from the Applicant profile, Memory and knowledge_search. Ask the user (one short list) for anything you don't know. Optional fields: fill the useful ones (cover letter, how you heard), skip the rest.",
    };
  }
  const submit = findSubmitButton(scan);
  const next = findNextButton(scan);
  if (next && !submit) {
    return { status: "next_page", nextStep: "This page is complete: call browser_apply_next for the next page." };
  }
  if (submit) {
    return {
      status: "ready_to_submit",
      nextStep:
        "All required fields are filled. Optionally fill useful optional fields, then call browser_apply_submit — the user reviews the form and clicks Submit in the chat.",
    };
  }
  return {
    status: "needs_user",
    userAction: "I couldn't find a Next or Submit button. Please continue in the browser window, then tell me.",
    nextStep: "Ask the user to continue in the browser window, then call browser_apply_check.",
  };
}

async function report(
  app: ApplicationRow,
  page: Page,
  pass: PassResult,
  extra: { note?: string; status?: ApplicationStatus; userAction?: string; nextStep?: string; confirmation?: string | null } = {},
): Promise<ApplicationOutput> {
  let { scan } = pass;
  await addDropdownOptions(page, scan, optionsFor(app.id));
  // Probing dropdowns can shift focus; read the page once more for accurate values.
  if (scan.fields.some((field) => field.kind === "combobox")) {
    const fresh = await scanPage(page);
    const options = new Map(scan.fields.map((field) => [field.key, field.options]));
    for (const field of fresh.fields) if (!field.options?.length) field.options = options.get(field.key);
    scan = fresh;
  }
  const computed = statusOf(scan);
  const status = extra.status ?? computed.status;
  const failures = new Map(pass.results.filter((result) => !result.ok).map((result) => [result.key, result.error ?? "failed"]));

  const unfilled = scan.fields.filter((field) => !field.filled && !field.disabled);
  const required = unfilled.filter((field) => field.required);
  const optional = unfilled.filter((field) => !field.required).slice(0, MAX_OPTIONAL_NEEDS);
  const filled = scan.fields.filter((field) => field.filled);
  const problems: ApplicationFieldSummary[] = [
    ...pass.missing.map((id) => ({ id, label: "(not on this page)", error: "No field with this id here — the page may have changed. Use the ids from the latest result." })),
    ...pass.results
      .filter((result) => !result.ok && !unfilled.some((field) => field.key === result.key))
      .map((result) => ({ id: result.key, label: oneLine(result.label, 120), error: result.error })),
  ];

  const shot = await screenshot(app, page);
  const ats = detectAts(page) ?? app.ats;
  const output: ApplicationOutput = {
    application_id: app.id,
    status,
    title: app.title ?? undefined,
    company: app.company ?? undefined,
    ats: ats ?? undefined,
    url: page.url(),
    page_title: oneLine(scan.title, 120) || undefined,
    filled_count: filled.length,
    filled: filled.slice(0, 40).map((field) => ({
      id: field.key,
      label: oneLine(field.label || "(no label)", 100),
      value: oneLine(field.value, 80),
    })),
    needs: [...required, ...optional].map((field) => summarizeField(field, failures.get(field.key))),
    more_optional: unfilled.length - required.length > MAX_OPTIONAL_NEEDS ? unfilled.length - required.length - MAX_OPTIONAL_NEEDS : undefined,
    problems: problems.length ? problems : undefined,
    page_errors: scan.errors.length ? scan.errors : undefined,
    user_action: extra.userAction ?? computed.userAction,
    next_step: extra.nextStep ?? computed.nextStep,
    confirmation: extra.confirmation ?? (status === "submitted" ? scan.confirmation ?? undefined : undefined),
    resume: getResumeInfo() ? undefined : "No resume file uploaded — ask the user to add it in Applicant profile (/profile).",
    note: extra.note,
    screenshot_at: shot ? Date.now() : undefined,
  };
  if (!output.needs?.length) delete output.needs;
  updateApplication(app.id, {
    status,
    url: page.url(),
    ats: ats ?? null,
    summary: output,
    screenshot: shot ?? app.screenshot,
    ...(status === "submitted" && !app.submittedAt ? { submittedAt: Date.now() } : {}),
  });
  if (status === "submitted" && app.jobId) setJobStatus(app.jobId, "Applied");
  return output;
}

/** The application's tab; reopened (and refilled) if the window was closed. */
async function ensurePage(app: ApplicationRow): Promise<{ page: Page; reopened: boolean }> {
  const live = livePage(app.id);
  if (live) {
    setActivePage(app.id);
    return { page: live, reopened: false };
  }
  const opened = await pageFor(app.id);
  if (!opened) throw new Error("Couldn't open a browser tab.");
  setActivePage(app.id);
  if (app.url) {
    await opened.page.goto(app.url, { waitUntil: "domcontentloaded" });
    await settle(opened.page);
    if (formPresent(await scanPage(opened.page))) return { page: opened.page, reopened: true };
  }
  const { page } = await openForm(opened.page, app.jobUrl, app.id);
  return { page, reopened: true };
}

const failed = (app: ApplicationRow | null, err: unknown): ApplicationOutput => ({
  application_id: app?.id,
  status: app?.status,
  error: errorText(err),
  next_step: "Tell the user what went wrong. They can retry, or finish in the browser window and say when it's done.",
});

function load(id: string): ApplicationRow {
  const app = getApplication(id.trim());
  if (!app) throw new Error(`No application "${id}". Start one with browser_apply_start.`);
  return app;
}

export async function startApplication(input: {
  url: string;
  title?: string | null;
  company?: string | null;
  jobId?: string | null;
  restart?: boolean;
}): Promise<ApplicationOutput> {
  let url: URL;
  try {
    url = new URL(input.url.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    return { error: `"${input.url}" isn't a web link.` };
  }
  const blocked = blockedSite(url.toString());
  if (blocked) {
    return {
      status: "failed",
      error: `${blocked} isn't automated: its terms ban bots and accounts that use them get restricted. Ask the user for the company's own application link (their careers page, Greenhouse, Lever, Workday…).`,
    };
  }
  const existing = findApplicationByJobUrl(url.toString());
  if (existing?.status === "submitted" && !input.restart) {
    return {
      application_id: existing.id,
      status: "submitted",
      title: existing.title ?? undefined,
      company: existing.company ?? undefined,
      note: `Already applied on ${day(existing.submittedAt ?? existing.updatedAt)}. Pass restart=true only if the user wants to apply again.`,
    };
  }
  let app =
    existing && !input.restart
      ? existing
      : createApplication({ jobUrl: url.toString(), jobId: input.jobId, title: input.title, company: input.company });
  app = updateApplication(app.id, {
    title: input.title?.trim() || app.title,
    company: input.company?.trim() || app.company,
    jobId: input.jobId ?? app.jobId,
  }) ?? app;

  try {
    return await withBrowser(async () => {
      const current = load(app.id);
      let page = livePage(current.id);
      if (!page) {
        const opened = await pageFor(current.id);
        if (!opened) throw new Error("Couldn't open a browser tab.");
        page = (await openForm(opened.page, current.jobUrl, current.id)).page;
      }
      setActivePage(current.id);
      const pass = await fillPass(current, page, new Map());
      return report(load(current.id), page, pass, {
        note: existing && !input.restart ? "Continuing the application started earlier." : undefined,
      });
    });
  } catch (err) {
    return failed(getApplication(app.id), err);
  }
}

export async function answerApplication(id: string, answers: Array<{ field_id: string; value: string }>): Promise<ApplicationOutput> {
  let app: ApplicationRow | null = null;
  try {
    app = load(id);
    if (app.status === "submitted") return { application_id: app.id, status: "submitted", note: "Already submitted." };
    const explicit = new Map(answers.map((answer) => [answer.field_id.trim(), String(answer.value ?? "")]));
    return await withBrowser(async () => {
      const current = load(id);
      const { page, reopened } = await ensurePage(current);
      const pass = await fillPass(current, page, explicit);
      return report(load(id), page, pass, {
        note: reopened ? "The browser tab had been closed — reopened the form and filled the saved answers again." : undefined,
      });
    });
  } catch (err) {
    return failed(app, err);
  }
}

export async function nextApplicationPage(id: string): Promise<ApplicationOutput> {
  let app: ApplicationRow | null = null;
  try {
    app = load(id);
    return await withBrowser(async () => {
      const current = load(id);
      let { page } = await ensurePage(current);
      const scan = await scanPage(page);
      const empty: PassResult = { scan, results: [], missing: [] };
      if (blocker(scan)) return report(current, page, empty);
      const required = missingRequired(scan);
      if (required.length) {
        return report(current, page, empty, { note: "Required fields on this page are still empty — answer them first." });
      }
      const next = findNextButton(scan);
      if (!next) {
        return report(current, page, empty, {
          note: findSubmitButton(scan) ? "This is the last page — submit it with browser_apply_submit." : "No Next button on this page.",
        });
      }
      page = await clickButton(page, next, current.id);
      const after = await waitForChange(page, scan);
      if (after.signature === scan.signature) {
        return report(load(id), page, { scan: after, results: [], missing: [] }, {
          note: after.errors.length ? "The site didn't move on — see page_errors." : "The page didn't change after clicking Next.",
        });
      }
      const pass = await fillPass(load(id), page, new Map());
      return report(load(id), page, pass);
    });
  } catch (err) {
    return failed(app, err);
  }
}

export async function checkApplication(id: string): Promise<ApplicationOutput> {
  let app: ApplicationRow | null = null;
  try {
    app = load(id);
    return await withBrowser(async () => {
      const current = load(id);
      let { page } = await ensurePage(current);
      let scan = await scanPage(page);
      // Back on the posting after signing in: follow Apply again.
      for (let hop = 0; hop < 2 && !formPresent(scan) && !blocker(scan) && !scan.confirmation; hop += 1) {
        const apply = findApplyButton(scan);
        if (!apply) break;
        page = await clickButton(page, apply, current.id);
        scan = await waitForChange(page, scan, 10_000);
      }
      const pass = await fillPass(current, page, new Map());
      return report(load(id), page, pass);
    });
  } catch (err) {
    return failed(app, err);
  }
}

/** Click the form's Submit button. Only called after the user approved it in the chat. */
export async function submitApplication(id: string): Promise<ApplicationOutput> {
  let app: ApplicationRow | null = null;
  try {
    app = load(id);
    if (app.status === "submitted") return { application_id: app.id, status: "submitted", note: "Already submitted." };
    return await withBrowser(async () => {
      const current = load(id);
      const { page } = await ensurePage(current);
      const scan = await scanPage(page);
      const empty: PassResult = { scan, results: [], missing: [] };
      if (blocker(scan)) return report(current, page, empty);
      if (missingRequired(scan).length) {
        return report(current, page, empty, { note: "Not submitted: required fields are still empty." });
      }
      const submit = findSubmitButton(scan);
      if (!submit) {
        return report(current, page, empty, {
          note: findNextButton(scan) ? "Not submitted: this isn't the last page yet (use browser_apply_next)." : "Not submitted: I couldn't find the Submit button.",
          status: findNextButton(scan) ? "next_page" : "needs_user",
          userAction: findNextButton(scan) ? undefined : "Click the form's Submit button in the browser window, then tell me.",
        });
      }
      const outcome = await submitForm(page, scan, submit, current.id);
      const after: PassResult = { scan: outcome.scan, results: [], missing: [] };
      switch (outcome.kind) {
        case "submitted":
          return report(load(id), outcome.page, after, {
            status: "submitted",
            confirmation: outcome.confirmation,
            nextStep: "Tell the user it was submitted (the job is marked Applied in the tracker).",
          });
        case "needs_user":
          return report(load(id), outcome.page, after, {
            status: "needs_user",
            userAction: `${outcome.reason} Then submit the form there if it's still showing.`,
            nextStep: "When the user says it's done, call browser_apply_check to confirm it went through.",
          });
        case "errors":
          return report(load(id), outcome.page, after, { note: "Not submitted: the site reported problems (page_errors)." });
        default:
          return report(load(id), outcome.page, after, {
            status: "needs_user",
            userAction: "I clicked Submit but couldn't confirm it went through. Please check the browser window.",
            nextStep: "Ask the user what the window shows; call browser_apply_check to look again.",
          });
      }
    }, 180_000);
  } catch (err) {
    return failed(app, err);
  }
}

