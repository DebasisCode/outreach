import crypto from "node:crypto";
import type { Frame, Locator, Page } from "playwright-core";
import { INPAGE_SOURCE } from "@/lib/browser/inpage";
import { normalize } from "@/lib/browser/match";

/**
 * Reads a page's form fields and buttons from every frame (application forms
 * are often an iframe from the ATS inside the company's careers page).
 *
 * Each field gets a stable id ("f3a9c1e") from its frame, kind, label and
 * name. Ids don't depend on the DOM, so they still point at the same question
 * after the page re-renders, after a reload, or in a fresh browser window.
 */

export type FieldKind =
  | "text"
  | "textarea"
  | "richtext"
  | "date"
  | "select"
  | "multiselect"
  | "radio"
  | "checkbox"
  | "checkboxes"
  | "file"
  | "combobox";

export interface FieldOption {
  label: string;
  /** <option> value / index, for native selects. */
  value?: string;
  index?: number;
  /** Element to click, for radios, checkbox groups and yes/no buttons. */
  ref?: string;
}

export interface RawField {
  ref: string;
  kind: FieldKind;
  tag: string;
  label: string;
  name: string;
  id: string;
  autocomplete: string;
  inputType: string;
  placeholder: string;
  description: string;
  required: boolean;
  optional: boolean;
  disabled: boolean;
  readOnly: boolean;
  inForm: boolean;
  value: string;
  options?: FieldOption[];
  multiple?: boolean;
  accept?: string;
  maxLength?: number;
  expanded?: boolean;
}

export interface RawButton {
  ref: string;
  text: string;
  tag: string;
  type: string;
  link: boolean;
  href: string;
  target: string;
  inForm: boolean;
  disabled: boolean;
}

interface RawScan {
  url: string;
  title: string;
  fields: RawField[];
  buttons: RawButton[];
  errors: string[];
  loginForm: boolean;
  confirmation: string;
  text: string;
}

export interface Field extends RawField {
  /** Stable id the assistant uses. */
  key: string;
  frame: Frame;
  /** Filled (value, checked box, chosen option or attached file). */
  filled: boolean;
}

export interface Button extends RawButton {
  frame: Frame;
}

export interface PageScan {
  url: string;
  title: string;
  fields: Field[];
  buttons: Button[];
  errors: string[];
  loginForm: boolean;
  confirmation: string | null;
  /** A visible CAPTCHA challenge the user has to solve. */
  captcha: boolean;
  text: string;
  /** Changes when the page moves to another step. */
  signature: string;
}

// Frames that never hold the application form.
const SKIP_FRAME =
  /recaptcha|hcaptcha|challenges\.cloudflare|googletagmanager|google-analytics|doubleclick|facebook\.com\/tr|youtube\.com|vimeo|player\.|stripe\.com|intercom|hotjar|zendesk|drift|livechat/i;
const CHALLENGE_FRAME =
  /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com\/.*(challenge|hcaptcha\.html#frame=challenge)|challenges\.cloudflare\.com/i;

/** Run one INPAGE api function in a frame. */
export async function runInPage<T>(frame: Frame, fn: string, ...args: unknown[]): Promise<T> {
  const call = `(function(){${INPAGE_SOURCE}\nreturn api.${fn}.apply(null, ${JSON.stringify(args)});})()`;
  return (await frame.evaluate(call)) as T;
}

export function refLocator(frame: Frame, ref: string): Locator {
  return frame.locator(`[data-outreach-ref="${ref}"]`).first();
}

function frameScope(frame: Frame): string {
  try {
    const url = new URL(frame.url());
    return `${url.host}${url.pathname}`;
  } catch {
    return "";
  }
}

const shortHash = (text: string) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 6);

export function isFilled(field: Pick<RawField, "kind" | "value">): boolean {
  return field.value.trim() !== "";
}

async function challengeVisible(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (!CHALLENGE_FRAME.test(frame.url())) continue;
    try {
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      if (box && box.width > 80 && box.height > 80 && (await element.isVisible())) return true;
    } catch {
      // frame went away
    }
  }
  return false;
}

/** Fields and buttons of the whole page (all frames). */
export async function scanPage(page: Page, options: { links?: boolean; text?: number } = {}): Promise<PageScan> {
  const frames = page.frames().filter((frame) => frame === page.mainFrame() || !SKIP_FRAME.test(frame.url()));
  const results = await Promise.all(
    frames.map(async (frame) => {
      try {
        const raw = await Promise.race([
          runInPage<RawScan>(frame, "scan", { links: options.links, text: frame === page.mainFrame() ? options.text : 0 }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
        ]);
        return raw ? { frame, raw } : null;
      } catch {
        return null; // detached or navigating frame
      }
    }),
  );

  const fields: Field[] = [];
  const buttons: Button[] = [];
  const errors: string[] = [];
  const seenKeys = new Map<string, number>();
  let loginForm = false;
  let confirmation: string | null = null;
  let main: RawScan | null = null;

  for (const result of results) {
    if (!result) continue;
    const { frame, raw } = result;
    if (frame === page.mainFrame()) main = raw;
    const scope = frameScope(frame);
    for (const field of raw.fields) {
      // The label's first words: text a site appends later (a hint, a counter) can't change the id.
      const question = normalize(field.label).split(" ").slice(0, 12).join(" ");
      const base = `f${shortHash(`${scope}|${field.kind}|${question}|${field.name}`)}`;
      const seen = seenKeys.get(base) ?? 0;
      seenKeys.set(base, seen + 1);
      fields.push({ ...field, key: seen ? `${base}_${seen + 1}` : base, frame, filled: isFilled(field) });
    }
    for (const button of raw.buttons) buttons.push({ ...button, frame });
    errors.push(...raw.errors);
    loginForm ||= raw.loginForm;
    confirmation ??= raw.confirmation || null;
  }

  const url = page.url();
  return {
    url,
    title: main?.title ?? (await page.title().catch(() => "")),
    fields,
    buttons,
    errors: [...new Set(errors)].slice(0, 10),
    loginForm,
    confirmation,
    captcha: await challengeVisible(page),
    text: main?.text ?? "",
    signature: `${url.split("#")[0]}|${fields.map((field) => field.key).join(",")}`,
  };
}

/** Wait for the page to finish loading and settle (best effort). */
export async function settle(page: Page, ms = 6_000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: ms }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => undefined);
  await page.waitForTimeout(300);
}
