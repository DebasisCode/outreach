import type { Page } from "playwright-core";
import { fillField, oneLine } from "@/lib/browser/fill";
import { blockedSite, blocker } from "@/lib/browser/flow";
import { refLocator, runInPage, scanPage, settle, type Button, type Field } from "@/lib/browser/scan";
import { activePage, pageFor, registerPage, setActivePage } from "@/lib/browser/session";

/**
 * General browsing for the assistant: open a page, read it, click or fill an
 * element by the id the last snapshot gave it ("e12"). Clicks that would
 * submit, send, buy or delete something wait for the user's approval in the
 * chat (see actNeedsApproval).
 */

export const BROWSE_KEY = "browse";

interface ElementRef {
  page: Page;
  button?: Button;
  field?: Field;
  label: string;
  risky: boolean;
}

export interface SnapshotElement {
  id: string;
  kind: string;
  label: string;
  value?: string;
  href?: string;
  options?: string[];
  required?: boolean;
}

export interface BrowseSnapshot {
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
  more_elements?: number;
  blocker?: string;
}

const RISKY =
  /\b(submit|apply|send|pay|purchase|buy|order|checkout|check out|delete|remove|confirm|sign up|register|post|publish|book|subscribe|unsubscribe|transfer|donate|accept|withdraw|place)\b/i;

const globalRefs = globalThis as typeof globalThis & { __outreachBrowseRefs?: Map<string, ElementRef> };
// The ids from the latest snapshot; a new snapshot replaces them.
let refs: Map<string, ElementRef> = (globalRefs.__outreachBrowseRefs ??= new Map());

const MAX_ELEMENTS = 120;

async function snapshot(page: Page): Promise<BrowseSnapshot> {
  const scan = await scanPage(page, { links: true, text: 5_000 });
  const next = new Map<string, ElementRef>();
  const elements: SnapshotElement[] = [];
  let counter = 0;
  const add = (ref: ElementRef, element: Omit<SnapshotElement, "id">) => {
    counter += 1;
    const id = `e${counter}`;
    next.set(id, ref);
    if (elements.length < MAX_ELEMENTS) elements.push({ id, ...element });
  };
  for (const field of scan.fields) {
    add(
      { page, field, label: field.label, risky: false },
      {
        kind: field.kind,
        label: oneLine(field.label, 100),
        value: field.value ? oneLine(field.value, 80) : undefined,
        options: field.options?.slice(0, 15).map((option) => option.label),
        required: field.required || undefined,
      },
    );
  }
  for (const button of scan.buttons) {
    add(
      { page, button, label: button.text, risky: !button.link && (button.type === "submit" || RISKY.test(button.text)) },
      { kind: button.link ? "link" : "button", label: oneLine(button.text, 80), href: button.link ? button.href.slice(0, 200) : undefined },
    );
  }
  refs = globalRefs.__outreachBrowseRefs = next;
  return {
    url: scan.url,
    title: scan.title,
    text: scan.text,
    elements,
    more_elements: counter > MAX_ELEMENTS ? counter - MAX_ELEMENTS : undefined,
    blocker: blocker(scan) ?? undefined,
  };
}

/** Open `url` in the browsing tab (or read the current tab when no url). */
export async function browseOpen(url?: string): Promise<BrowseSnapshot> {
  if (url) {
    const blocked = blockedSite(url);
    if (blocked) throw new Error(`${blocked} isn't automated: its terms ban bots and accounts that use them get restricted.`);
    const opened = await pageFor(BROWSE_KEY);
    if (!opened) throw new Error("Couldn't open a tab.");
    setActivePage(BROWSE_KEY);
    await opened.page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(opened.page);
    return snapshot(opened.page);
  }
  const active = activePage();
  if (!active) throw new Error("No page is open yet — pass a url.");
  return snapshot(active.page);
}

export type BrowseAction = "click" | "fill" | "press";

/** True when this action would submit/send/buy/delete something: the user approves it first. */
export function actNeedsApproval(input: { id?: string; action?: string; value?: string }): boolean {
  const ref = input.id ? refs.get(input.id) : undefined;
  if (!ref) return false;
  if (input.action === "click") return ref.risky;
  if (input.action === "press") return /enter/i.test(input.value ?? "") && Boolean(ref.field?.inForm);
  return false;
}

/** What an approval card says about the action. */
export function describeAction(input: { id?: string; action?: string; value?: string }): string | null {
  const ref = input.id ? refs.get(input.id) : undefined;
  if (!ref) return null;
  let host = "";
  try {
    host = new URL(ref.page.url()).host;
  } catch {
    // keep empty
  }
  const verb = input.action === "press" ? `Press ${input.value ?? "a key"} in` : "Click";
  return `${verb} “${oneLine(ref.label, 80)}”${host ? ` on ${host}` : ""}`;
}

export async function browseAct(input: { id: string; action: BrowseAction; value?: string }): Promise<BrowseSnapshot & { did: string }> {
  const ref = refs.get(input.id);
  if (!ref || ref.page.isClosed()) throw new Error(`No element "${input.id}" on the page — call browser_open (no url) for fresh ids.`);
  let page = ref.page;
  let did: string;
  if (input.action === "click") {
    const target = ref.button ?? ref.field;
    if (!target) throw new Error("Nothing to click.");
    const popup = page.context().waitForEvent("page", { timeout: 3_000 }).catch(() => null);
    try {
      await refLocator(target.frame, target.ref).click({ timeout: 6_000 });
    } catch {
      await runInPage<boolean>(target.frame, "click", target.ref);
    }
    const opened = await popup;
    if (opened) {
      registerPage(BROWSE_KEY, opened);
      setActivePage(BROWSE_KEY);
      page = opened;
    }
    did = `Clicked “${oneLine(ref.label, 60)}”.`;
  } else if (input.action === "fill") {
    if (!ref.field) throw new Error(`"${input.id}" isn't a field — use click.`);
    const result = await fillField(page, ref.field, input.value ?? "", { resumePath: null });
    if (!result.ok) throw new Error(`Couldn't fill “${oneLine(ref.label, 60)}”: ${result.error}`);
    did = `Filled “${oneLine(ref.label, 60)}” with “${oneLine(result.value ?? "", 60)}”.`;
  } else {
    const target = ref.field ?? ref.button;
    if (target) await refLocator(target.frame, target.ref).focus().catch(() => undefined);
    await page.keyboard.press(input.value || "Enter");
    did = `Pressed ${input.value || "Enter"}.`;
  }
  await settle(page, 4_000);
  return { did, ...(await snapshot(page)) };
}
