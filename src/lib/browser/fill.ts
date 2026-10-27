import type { Frame, Page } from "playwright-core";
import { DECLINE, declineOption, matchOption, normalize, parseBoolean, RESUME } from "@/lib/browser/match";
import { refLocator, runInPage, scanPage, type Field, type FieldOption } from "@/lib/browser/scan";
import { errorText } from "@/lib/browser/session";

/**
 * Filling one field, the way a person would: type into text boxes, pick the
 * option in dropdowns, tick radios and boxes, attach the resume. Every kind
 * has fallbacks (a hidden radio is clicked through its label, a custom
 * dropdown is opened and its option clicked), and every fill is checked by
 * reading the value back — a field only counts as filled if it really is.
 */

export interface FillResult {
  key: string;
  label: string;
  ok: boolean;
  /** What the field shows now. */
  value?: string;
  error?: string;
}

export interface FillContext {
  /** Absolute path of the resume file to attach, if the user uploaded one. */
  resumePath: string | null;
}

interface InPageState {
  kind: string;
  value: string;
  checked: boolean;
  expanded: boolean;
  invalid: boolean;
  text: string;
  containerText: string;
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const state = (frame: Frame, ref: string) => runInPage<InPageState | null>(frame, "state", ref);

/** Click, falling back to a forced click and then a DOM click (overlays, odd styling). */
async function robustClick(frame: Frame, ref: string): Promise<void> {
  const locator = refLocator(frame, ref);
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
    await locator.click({ timeout: 4_000 });
    return;
  } catch {
    // covered by something, or not "visible" to Playwright
  }
  try {
    await locator.click({ timeout: 2_000, force: true });
    return;
  } catch {
    // fall through
  }
  if (!(await runInPage<boolean>(frame, "click", ref))) throw new Error("the element is gone from the page");
}

const digits = (text: string) => text.replace(/\D+/g, "");

function sameText(actual: string, wanted: string, kind: string, inputType: string): boolean {
  if (normalize(actual) === normalize(wanted)) return true;
  if (inputType === "tel" || /^\+?[\d\s().-]{6,}$/.test(wanted)) {
    const a = digits(actual);
    const w = digits(wanted);
    // Masked phone inputs drop or reformat the country code.
    return a.length >= 6 && (w.endsWith(a) || a.endsWith(w));
  }
  if (kind === "date") return actual.trim() !== "";
  if (inputType === "number") return Number(actual) === Number(wanted);
  return false;
}

/** "Jan 5, 2026" -> "2026-01-05" for <input type=date>. */
function isoDate(value: string, inputType: string): string {
  if (inputType === "month" && /^\d{4}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return inputType === "month" ? value.slice(0, 7) : value.slice(0, 10);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const iso = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString();
  return inputType === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

async function fillText(page: Page, field: Field, value: string): Promise<string> {
  const locator = refLocator(field.frame, field.ref);
  const wanted = field.kind === "date" ? isoDate(value, field.inputType) : value;
  if (field.maxLength && wanted.length > field.maxLength) {
    throw new Error(`too long: this field takes at most ${field.maxLength} characters (got ${wanted.length})`);
  }
  await locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
  try {
    await locator.fill(wanted, { timeout: 6_000 });
  } catch {
    await robustClick(field.frame, field.ref);
    await locator.press("ControlOrMeta+a").catch(() => undefined);
    await page.keyboard.insertText(wanted);
  }
  let actual = (await state(field.frame, field.ref))?.value ?? "";
  if (!sameText(actual, wanted, field.kind, field.inputType)) {
    // Masked or script-controlled inputs: type it key by key instead.
    await locator.click({ timeout: 4_000 }).catch(() => undefined);
    await locator.press("ControlOrMeta+a").catch(() => undefined);
    await locator.press("Backspace").catch(() => undefined);
    await locator.pressSequentially(wanted, { delay: 15, timeout: 20_000 });
    actual = (await state(field.frame, field.ref))?.value ?? "";
  }
  await locator.blur().catch(() => undefined);
  if (!sameText(actual, wanted, field.kind, field.inputType)) {
    throw new Error(`the field shows "${actual.slice(0, 60)}" instead`);
  }
  return actual;
}

async function fillRichText(page: Page, field: Field, value: string): Promise<string> {
  await robustClick(field.frame, field.ref);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(value);
  const actual = (await state(field.frame, field.ref))?.value ?? "";
  if (!normalize(actual).includes(normalize(value).slice(0, 30))) throw new Error("the text didn't stick");
  return actual;
}

/** The option `value` means. DECLINE picks "decline to self-identify". */
function chooseOption(options: FieldOption[], value: string): FieldOption {
  const labels = options.map((option) => option.label);
  if (value === DECLINE) {
    const index = declineOption(labels);
    if (index < 0) throw new Error("there's no \"decline to answer\" option");
    return options[index];
  }
  const match = matchOption(labels, value);
  if (!match) {
    const shown = labels.slice(0, 12).join(" | ");
    throw new Error(`"${value}" isn't one of the options: ${shown}${labels.length > 12 ? " | …" : ""}`);
  }
  return options[match.index];
}

async function fillSelect(field: Field, value: string): Promise<string> {
  const locator = refLocator(field.frame, field.ref);
  const options = field.options ?? [];
  if (field.kind === "multiselect") {
    const picked = splitValues(value).map((item) => chooseOption(options, item));
    await locator.selectOption(picked.map((option) => ({ index: option.index ?? 0 })), { timeout: 6_000 });
  } else {
    const option = chooseOption(options, value);
    await locator.selectOption({ index: option.index ?? 0 }, { timeout: 6_000 });
  }
  await locator.blur().catch(() => undefined);
  const actual = (await state(field.frame, field.ref))?.value ?? "";
  if (!actual) throw new Error("no option is selected after choosing");
  return actual;
}

/** The field as the page shows it now, found again by id (after a re-render replaced its elements). */
async function refind(field: Field): Promise<Field | null> {
  const scan = await scanPage(field.frame.page());
  return scan.fields.find((candidate) => candidate.key === field.key) ?? null;
}

async function setChecked(field: Field, ref: string, wanted: boolean, optionLabel?: string): Promise<void> {
  const read = async () => {
    const now = await state(field.frame, ref);
    if (now) return now.checked;
    // Clicking re-rendered the field (React-style): judge by what it shows now.
    const fresh = await refind(field);
    if (!fresh || !optionLabel) return !wanted;
    const chosen = fresh.value.split(/;\s*/).map(normalize);
    return chosen.includes(normalize(optionLabel));
  };
  if ((await read()) === wanted) return;
  await robustClick(field.frame, ref);
  if ((await read()) === wanted) return;
  // A hidden native input: its label is what the user clicks.
  await runInPage<boolean>(field.frame, "labelClick", ref);
  if ((await read()) === wanted) return;
  await refLocator(field.frame, ref).setChecked(wanted, { force: true, timeout: 3_000 }).catch(() => undefined);
  if ((await read()) !== wanted) throw new Error(`couldn't ${wanted ? "tick" : "untick"} it`);
}

async function fillChoice(field: Field, value: string): Promise<string> {
  const options = field.options ?? [];
  if (field.kind === "radio") {
    const option = chooseOption(options, value);
    if (!option.ref) throw new Error("option can't be clicked");
    await setChecked(field, option.ref, true, option.label);
    return option.label;
  }
  // checkboxes: tick exactly the chosen ones
  const chosen = new Set(splitValues(value).map((item) => chooseOption(options, item)));
  for (const option of options) {
    const want = chosen.has(option);
    let ref = option.ref;
    let current = ref ? await state(field.frame, ref) : null;
    if (!current) {
      // An earlier tick re-rendered the group: find this option again.
      ref = (await refind(field))?.options?.find((candidate) => candidate.label === option.label)?.ref;
      current = ref ? await state(field.frame, ref) : null;
    }
    if (!ref || !current) throw new Error(`option "${option.label}" disappeared`);
    if (current.checked !== want) await setChecked(field, ref, want, option.label);
  }
  return [...chosen].map((option) => option.label).join("; ");
}

async function fillCheckbox(field: Field, value: string): Promise<string> {
  const wanted = parseBoolean(value);
  if (wanted === null) throw new Error(`say "yes" or "no" for a checkbox (got "${value}")`);
  await setChecked(field, field.ref, wanted);
  return wanted ? "checked" : "unchecked";
}

async function fillFile(field: Field, value: string, context: FillContext): Promise<string> {
  // Only the resume from the Applicant profile can be attached — never an
  // arbitrary path from the model.
  if (value !== RESUME && normalize(value) !== "resume" && normalize(value) !== "cv") {
    throw new Error('only the resume can be attached here (pass "resume")');
  }
  if (!context.resumePath) throw new Error("no resume file yet — add one in Applicant profile");
  const locator = refLocator(field.frame, field.ref);
  await locator.setInputFiles(context.resumePath, { timeout: 10_000 });
  const page = field.frame.page();
  await pause(page, 600);
  const actual = (await state(field.frame, field.ref))?.value ?? "";
  if (!actual) throw new Error("the upload didn't register");
  return actual;
}

/** Options that are on screen now, scoped to this dropdown's list when it has one. */
async function visibleOptions(frame: Frame, ref: string): Promise<Array<{ ref: string; label: string }>> {
  return runInPage<Array<{ ref: string; label: string }>>(frame, "options", ref);
}

async function waitForNewOptions(
  page: Page,
  frame: Frame,
  ref: string,
  before: Set<string>,
  ms: number,
): Promise<Array<{ ref: string; label: string }>> {
  const deadline = Date.now() + ms;
  let last: Array<{ ref: string; label: string }> = [];
  while (Date.now() < deadline) {
    const now = await visibleOptions(frame, ref);
    // Options that appeared after opening are this dropdown's; fall back to
    // all of them when the list was already open.
    last = now.filter((option) => !before.has(option.label));
    if (!last.length && now.length && before.size) last = now;
    if (last.length) {
      // Async lists (location search) keep updating: wait a beat for the rest.
      await pause(page, 250);
      const settled = await visibleOptions(frame, ref);
      const fresh = settled.filter((option) => !before.has(option.label));
      return fresh.length ? fresh : settled;
    }
    await pause(page, 200);
  }
  return last;
}

/** Open a custom dropdown and read its options (then close it). */
export async function probeOptions(page: Page, field: Field): Promise<string[]> {
  const before = new Set((await visibleOptions(field.frame, field.ref)).map((option) => option.label));
  try {
    await robustClick(field.frame, field.ref);
    const options = await waitForNewOptions(page, field.frame, field.ref, before, 1_500);
    return options.map((option) => option.label);
  } catch {
    return [];
  } finally {
    await page.keyboard.press("Escape").catch(() => undefined);
    await refLocator(field.frame, field.ref).blur().catch(() => undefined);
    await pause(page, 150);
  }
}

async function fillCombobox(page: Page, field: Field, value: string): Promise<string> {
  const { frame, ref } = field;
  const locator = refLocator(frame, ref);
  const typable = field.tag === "input" || field.tag === "textarea";
  const before = new Set((await visibleOptions(frame, ref)).map((option) => option.label));
  await robustClick(frame, ref);

  // Type to filter when we can. Long values ("Bengaluru, Karnataka, India")
  // often only match on their first part in search-as-you-type lists.
  const attempts = typable ? [...new Set([value, value.split(",")[0].trim()])].filter(Boolean) : [value];
  let options: Array<{ ref: string; label: string }> = [];
  let picked: { ref: string; label: string } | null = null;
  for (const typed of attempts) {
    if (typable && value !== DECLINE) {
      await locator.fill("", { timeout: 4_000 }).catch(() => undefined);
      await locator.pressSequentially(typed, { delay: 25, timeout: 15_000 });
    }
    options = await waitForNewOptions(page, frame, ref, before, typable ? 4_000 : 2_500);
    if (!options.length) continue;
    try {
      const choice = chooseOption(options.map((option) => ({ label: option.label, ref: option.ref })), value);
      picked = options.find((option) => option.ref === choice.ref) ?? null;
    } catch {
      picked = null;
    }
    if (picked) break;
  }
  if (!picked) {
    await page.keyboard.press("Escape").catch(() => undefined);
    if (typable) await locator.fill("", { timeout: 3_000 }).catch(() => undefined);
    const seen = options.slice(0, 10).map((option) => option.label).join(" | ");
    throw new Error(
      options.length ? `no option matched "${value}" (saw: ${seen})` : `no options appeared for "${value}"`,
    );
  }
  await robustClick(frame, picked.ref);
  await pause(page, 250);
  await locator.blur().catch(() => undefined);
  const after = await state(frame, ref);
  const shown = after ? `${after.value} ${after.text} ${after.containerText}` : "";
  if (!normalize(shown).includes(normalize(picked.label).slice(0, 40))) {
    throw new Error(`picked "${picked.label}" but the field doesn't show it`);
  }
  return picked.label;
}

function splitValues(value: string): string[] {
  return value
    .split(/\s*(?:;|\n|\|)\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Fill one field and check it took. Never throws. */
export async function fillField(page: Page, field: Field, value: string, context: FillContext): Promise<FillResult> {
  const result: FillResult = { key: field.key, label: field.label, ok: false };
  if (field.disabled || field.readOnly) return { ...result, error: "the field is read-only" };
  try {
    let shown: string;
    switch (field.kind) {
      case "text":
      case "textarea":
      case "date":
        shown = await fillText(page, field, value);
        break;
      case "richtext":
        shown = await fillRichText(page, field, value);
        break;
      case "select":
      case "multiselect":
        shown = await fillSelect(field, value);
        break;
      case "radio":
      case "checkboxes":
        shown = await fillChoice(field, value);
        break;
      case "checkbox":
        shown = await fillCheckbox(field, value);
        break;
      case "file":
        shown = await fillFile(field, value, context);
        break;
      case "combobox":
        shown = await fillCombobox(page, field, value);
        break;
      default:
        throw new Error(`can't fill a ${field.kind as string} field`);
    }
    return { ...result, ok: true, value: shown };
  } catch (err) {
    return { ...result, error: errorText(err) };
  }
}

/** A short, single-line version of a value, for results and the review card. */
export function oneLine(value: string, max = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
