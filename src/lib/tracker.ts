import {
  adoptJobStatus,
  countPendingTrackerRows,
  findJobByUrl,
  getSetting,
  listJobs,
  markJobStatusSynced,
  markTrackerSynced,
  pendingTrackerRows,
  resetTrackerSync,
  saveJob,
  setSetting,
  type ContactRow,
  type JobInput,
  type JobRow,
  type TrackerEmailRow,
  type TrackerJobRow,
} from "@/lib/db";
import {
  dig,
  findActiveConnection,
  runAction,
  type ConnectionInfo,
  type JobPosting,
} from "@/lib/composio";
import type { JobResult, TrackerFields, TrackerStatus } from "@/lib/tool-outputs";
import { JOB_STATUSES } from "@/lib/types";

/**
 * The application tracker: a Google Sheet ("Outreach Tracker") in the user's
 * Drive, written through Composio's Google Sheets toolkit. Three tabs:
 *
 *   Jobs      jobs the user saved, asked to find a recruiter for, or emailed about
 *   Contacts  people whose work email was found
 *   Emails    every email sent
 *
 * The local database is the source of truth. Each row carries an ID column
 * and is upserted by it, so a retry or re-sync updates the row instead of
 * adding a duplicate, and anything recorded before Google Sheets was
 * connected is copied over on the first sync. The app owns every column
 * except Status (moved Saved → Emailed only while the user hasn't changed it
 * in the sheet) and Notes (never written).
 */

const TRACKER_TITLE = "Outreach Tracker";
const SETTINGS_KEY = "tracker";
/** How long a "the spreadsheet still exists" check is trusted. */
const VERIFY_EVERY_MS = 10 * 60 * 1000;
const CONNECTION_CACHE_MS = 30 * 1000;
/** Never replace a tracker younger than this — guards against making many sheets. */
const MIN_REPLACE_AGE_MS = 10 * 60 * 1000;
const UPSERT_CHUNK = 100;
const GRID_ROWS = 1000;
/** Upper bound on push rounds in one sync. */
const MAX_PASSES = 3;

const TABS = {
  jobs: {
    name: "Jobs",
    headers: [
      "Added",
      "Company",
      "Role",
      "Location",
      "Salary",
      "Source",
      "Link",
      "Status",
      "Contacted",
      "Last emailed",
      "Notes",
      "ID",
    ],
  },
  contacts: {
    name: "Contacts",
    headers: [
      "Added",
      "Name",
      "Title",
      "Company",
      "Email",
      "Email status",
      "LinkedIn",
      "Last emailed",
      "ID",
    ],
  },
  emails: {
    name: "Emails",
    headers: ["Sent", "To", "Name", "Company", "Role", "Subject", "Body", "From", "ID"],
  },
} as const;

type TabKey = keyof typeof TABS;
const TAB_KEYS = Object.keys(TABS) as TabKey[];

interface StoredTracker {
  spreadsheetId: string;
  url: string;
  /** Sheet id of the Jobs tab (for the Status dropdown). */
  jobsSheetId: number;
  createdAt: number;
  /** Tabs, headers and formatting are in place. */
  ready: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
}

export type SyncOutcome =
  | { status: "off" }
  | {
      status: "synced";
      url: string;
      created: boolean;
      pushed: { jobs: number; contacts: number; emails: number };
    }
  | { status: "error"; url?: string; error: string };

interface SheetsContext {
  apiKey: string;
  userId: string;
  connectionId: string;
}

// ---------- small helpers ----------

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];

function friendly(err: unknown): string {
  const message = errorText(err).replace(/\s+/g, " ").trim();
  if (/connected account.*(not|in)active|expired|revoked|invalid_grant|unauthenticated/i.test(message)) {
    return "Google Sheets needs to be reconnected (Connections → Google Sheets).";
  }
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}

function call(ctx: SheetsContext, slug: string, args: Record<string, unknown>) {
  return runAction(ctx.apiKey, slug, "googlesheets", {
    userId: ctx.userId,
    connectedAccountId: ctx.connectionId,
    args,
  });
}

/** 1 -> A, 12 -> L, 27 -> AA */
function columnLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

const pad = (n: number) => String(n).padStart(2, "0");

function day(at: number | null): string {
  if (!at) return "";
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayTime(at: number): string {
  const d = new Date(at);
  return `${day(at)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MAX_CELL = 40_000;

/**
 * Cell text. Sheets treats a leading = + - @ as a formula, and job titles or
 * names come from the web — a leading apostrophe keeps them plain text.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).replace(/\r\n?/g, "\n").slice(0, MAX_CELL);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

const rowId = (prefix: string, id: string) => `${prefix}-${id.replace(/-/g, "").slice(0, 12)}`;

function hasPending(): boolean {
  const pending = countPendingTrackerRows();
  return pending.jobs + pending.contacts + pending.emails > 0;
}

// ---------- rows ----------

function jobRecord(job: TrackerJobRow): Record<string, string> {
  const location =
    job.remote && !/remote/i.test(job.location ?? "")
      ? [job.location, "Remote"].filter(Boolean).join(" · ")
      : job.location;
  return {
    Added: day(job.createdAt),
    Company: cell(job.company),
    Role: cell(job.title),
    Location: cell(location),
    Salary: cell(job.salary),
    Source: cell(job.source),
    Link: cell(job.url),
    Status: cell(job.status),
    Contacted: cell(job.contacted.join(", ")),
    "Last emailed": day(job.lastEmailedAt),
    ID: rowId("job", job.id),
  };
}

function contactRecord(contact: ContactRow): Record<string, string> {
  return {
    Added: day(contact.createdAt),
    Name: cell(contact.name),
    Title: cell(contact.title),
    Company: cell(contact.company ?? contact.domain),
    Email: cell(contact.email),
    "Email status": cell(contact.emailStatus),
    LinkedIn: cell(contact.linkedinUrl),
    "Last emailed": day(contact.lastEmailedAt),
    ID: rowId("contact", contact.id),
  };
}

function emailRecord(email: TrackerEmailRow): Record<string, string> {
  return {
    Sent: dayTime(email.sentAt),
    To: cell(email.toEmail),
    Name: cell(email.contactName),
    Company: cell(email.contactCompany ?? email.jobCompany),
    Role: cell(email.jobTitle),
    Subject: cell(email.subject),
    Body: cell(email.body),
    From: cell(email.fromAddress),
    ID: rowId("email", email.id),
  };
}

async function upsertRows(
  ctx: SheetsContext,
  tracker: StoredTracker,
  tab: TabKey,
  headers: string[],
  rows: Record<string, string>[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK) {
    await call(ctx, "GOOGLESHEETS_UPSERT_ROWS", {
      spreadsheetId: tracker.spreadsheetId,
      sheetName: TABS[tab].name,
      keyColumn: "ID",
      headers,
      rows: rows.slice(start, start + UPSERT_CHUNK).map((row) => headers.map((h) => row[h] ?? "")),
    });
  }
}

// ---------- the spreadsheet itself ----------

interface SheetTab {
  title: string;
  sheetId: number;
  index: number;
}

async function listTabs(ctx: SheetsContext, spreadsheetId: string): Promise<SheetTab[]> {
  const info = await call(ctx, "GOOGLESHEETS_GET_SPREADSHEET_INFO", {
    spreadsheet_id: spreadsheetId,
  });
  return records(dig(info, "sheets"))
    .map((sheet) => (sheet.properties ?? {}) as Record<string, unknown>)
    .map((props) => ({
      title: String(props.title ?? ""),
      sheetId: Number(props.sheetId ?? 0),
      index: Number(props.index ?? 0),
    }))
    .sort((a, b) => a.index - b.index);
}

async function writeHeaders(ctx: SheetsContext, spreadsheetId: string, tabs: TabKey[]) {
  await call(ctx, "GOOGLESHEETS_UPDATE_VALUES_BATCH", {
    spreadsheet_id: spreadsheetId,
    valueInputOption: "RAW",
    data: tabs.map((tab) => ({
      range: `${TABS[tab].name}!A1:${columnLetter(TABS[tab].headers.length)}1`,
      values: [[...TABS[tab].headers]],
      majorDimension: "ROWS",
    })),
  });
}

/** Bold header rows and the Status dropdown. Cosmetic, so failures are ignored. */
async function decorate(ctx: SheetsContext, tracker: StoredTracker, tabs: TabKey[]) {
  const tasks: Promise<unknown>[] = tabs.map((tab) =>
    call(ctx, "GOOGLESHEETS_FORMAT_CELL", {
      spreadsheet_id: tracker.spreadsheetId,
      sheet_name: TABS[tab].name,
      range: `A1:${columnLetter(TABS[tab].headers.length)}1`,
      bold: true,
      red: 0.91,
      green: 0.93,
      blue: 0.96,
    }),
  );
  if (tabs.includes("jobs")) {
    const statusColumn = TABS.jobs.headers.indexOf("Status");
    tasks.push(
      call(ctx, "GOOGLESHEETS_SET_DATA_VALIDATION_RULE", {
        spreadsheet_id: tracker.spreadsheetId,
        sheet_id: tracker.jobsSheetId,
        mode: "SET",
        validation_type: "ONE_OF_LIST",
        values: [...JOB_STATUSES],
        start_row_index: 1,
        end_row_index: GRID_ROWS,
        start_column_index: statusColumn,
        end_column_index: statusColumn + 1,
        // A status the user types themselves gets a warning, not a rejection.
        strict: false,
        show_custom_ui: true,
      }),
    );
  }
  await Promise.allSettled(tasks);
}

/**
 * Make sure the three tabs exist, with headers. A brand-new spreadsheet's
 * empty first tab becomes Jobs; a tab the user deleted is added back.
 */
async function ensureTabs(
  ctx: SheetsContext,
  tracker: StoredTracker,
): Promise<{ tracker: StoredTracker; changed: boolean }> {
  const tabs = await listTabs(ctx, tracker.spreadsheetId);
  const ours = new Set<string>(TAB_KEYS.map((key) => TABS[key].name));
  const present = new Set(tabs.map((tab) => tab.title));
  const created: TabKey[] = [];

  for (const key of TAB_KEYS) {
    if (present.has(TABS[key].name)) continue;
    const blankFirstTab = !tracker.ready && key === "jobs" ? tabs.find((t) => !ours.has(t.title)) : undefined;
    if (blankFirstTab) {
      await call(ctx, "GOOGLESHEETS_UPDATE_SHEET_PROPERTIES", {
        spreadsheetId: tracker.spreadsheetId,
        updateSheetProperties: {
          properties: {
            sheetId: blankFirstTab.sheetId,
            title: TABS.jobs.name,
            gridProperties: { frozenRowCount: 1 },
          },
          fields: "title,gridProperties.frozenRowCount",
        },
      });
    } else {
      await call(ctx, "GOOGLESHEETS_ADD_SHEET", {
        spreadsheet_id: tracker.spreadsheetId,
        title: TABS[key].name,
        properties: {
          title: TABS[key].name,
          gridProperties: {
            rowCount: GRID_ROWS,
            columnCount: TABS[key].headers.length + 4,
            frozenRowCount: 1,
          },
        },
        force_unique: false,
      });
    }
    created.push(key);
  }

  if (tracker.ready && created.length === 0) return { tracker, changed: false };
  // A tab the user deleted comes back with its full history, not just new rows.
  if (tracker.ready) resetTrackerSync(created);

  const after = created.length ? await listTabs(ctx, tracker.spreadsheetId) : tabs;
  const next: StoredTracker = {
    ...tracker,
    jobsSheetId: after.find((tab) => tab.title === TABS.jobs.name)?.sheetId ?? tracker.jobsSheetId,
    ready: true,
  };
  // First setup writes every header row; later only the restored tabs.
  const headerTabs = tracker.ready ? created : TAB_KEYS;
  await writeHeaders(ctx, tracker.spreadsheetId, headerTabs);
  await decorate(ctx, next, headerTabs);
  return { tracker: next, changed: true };
}

async function createTracker(ctx: SheetsContext): Promise<StoredTracker> {
  const created = await call(ctx, "GOOGLESHEETS_CREATE_GOOGLE_SHEET1", { title: TRACKER_TITLE });
  const spreadsheetId = str(dig(created, "spreadsheetId"));
  if (!spreadsheetId) throw new Error("Google Sheets didn't return the new spreadsheet.");
  const tracker: StoredTracker = {
    spreadsheetId,
    url:
      str(dig(created, "spreadsheetUrl")) ??
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    jobsSheetId: 0,
    createdAt: Date.now(),
    ready: false,
    lastSyncedAt: null,
    lastError: null,
  };
  // Saved before the tabs are set up, so a failed setup is finished on the
  // next sync instead of creating a second spreadsheet.
  setSetting(SETTINGS_KEY, tracker);
  resetTrackerSync();
  verifiedAt.set(spreadsheetId, Date.now());
  return tracker;
}

const verifiedAt = new Map<string, number>();

/** False when the spreadsheet was deleted or belongs to another Google account. */
async function stillThere(ctx: SheetsContext, tracker: StoredTracker): Promise<boolean> {
  const checked = verifiedAt.get(tracker.spreadsheetId);
  if (checked && Date.now() - checked < VERIFY_EVERY_MS) return true;
  let usable: boolean;
  try {
    const meta = await call(ctx, "GOOGLESHEETS_GET_DRIVE_FILE_METADATA", {
      fileId: tracker.spreadsheetId,
      fields: "id,trashed",
    });
    usable = dig(meta, "trashed") !== true;
  } catch {
    // Drive said no — ask Sheets itself before giving up on the file.
    try {
      await listTabs(ctx, tracker.spreadsheetId);
      usable = true;
    } catch (err) {
      if (!/not.?found|404|permission|403|forbidden/i.test(errorText(err))) throw err;
      usable = false;
    }
  }
  if (usable) verifiedAt.set(tracker.spreadsheetId, Date.now());
  return usable;
}

/** Status in the sheet for each job row, by ID. */
async function sheetStatuses(ctx: SheetsContext, tracker: StoredTracker): Promise<Map<string, string>> {
  const data = await call(ctx, "GOOGLESHEETS_VALUES_GET", {
    spreadsheet_id: tracker.spreadsheetId,
    range: TABS.jobs.name,
  });
  const values = dig(data, "values");
  const rows = Array.isArray(values) ? (values as unknown[][]) : [];
  const header = (rows[0] ?? []).map((value) => String(value ?? "").trim());
  const idColumn = header.indexOf("ID");
  const statusColumn = header.indexOf("Status");
  const statuses = new Map<string, string>();
  if (idColumn < 0 || statusColumn < 0) return statuses;
  for (const row of rows.slice(1)) {
    const id = String(row?.[idColumn] ?? "").trim();
    if (id) statuses.set(id, String(row?.[statusColumn] ?? "").trim());
  }
  return statuses;
}

// ---------- sync ----------

async function pushPending(
  ctx: SheetsContext,
  start: StoredTracker,
): Promise<{ tracker: StoredTracker; pushed: { jobs: number; contacts: number; emails: number }; failures: string[] }> {
  const startedAt = Date.now();
  const pending = pendingTrackerRows();
  const pushed = { jobs: 0, contacts: 0, emails: 0 };
  const failures: string[] = [];
  let tracker = start;

  const attempt = async (tab: TabKey, work: (t: StoredTracker) => Promise<void>) => {
    try {
      await work(tracker);
    } catch (err) {
      // A tab the user deleted or renamed: put it back and try once more.
      let repaired = false;
      try {
        const result = await ensureTabs(ctx, tracker);
        tracker = result.tracker;
        repaired = result.changed;
      } catch {
        // keep the original error
      }
      if (!repaired) {
        failures.push(`${TABS[tab].name}: ${friendly(err)}`);
        return;
      }
      try {
        await work(tracker);
      } catch (retryErr) {
        failures.push(`${TABS[tab].name}: ${friendly(retryErr)}`);
      }
    }
  };

  if (pending.jobs.length) {
    await attempt("jobs", async (t) => {
      const fresh = pending.jobs.filter((job) => job.syncedAt === null);
      const updates = pending.jobs.filter((job) => job.syncedAt !== null);
      const needsCheck = updates.some(
        (job) => job.status !== job.statusSynced && !job.statusExplicit,
      );
      const inSheet = needsCheck ? await sheetStatuses(ctx, t) : new Map<string, string>();

      const withStatus: TrackerJobRow[] = [...fresh];
      const keepStatus: TrackerJobRow[] = [];
      for (const job of updates) {
        if (job.status === job.statusSynced) {
          keepStatus.push(job);
          continue;
        }
        const current = inSheet.get(rowId("job", job.id));
        if (job.statusExplicit || !current || current === job.statusSynced) {
          withStatus.push(job);
        } else {
          // The user changed Status in the sheet — theirs wins.
          adoptJobStatus(job.id, current);
          keepStatus.push(job);
        }
      }
      const headers = TABS.jobs.headers.filter((h) => h !== "Notes");
      await upsertRows(ctx, t, "jobs", headers, withStatus.map(jobRecord));
      await upsertRows(
        ctx,
        t,
        "jobs",
        headers.filter((h) => h !== "Status"),
        keepStatus.map(jobRecord),
      );
      for (const job of withStatus) markJobStatusSynced(job.id, job.status);
      markTrackerSynced("jobs", pending.jobs.map((job) => job.id), startedAt);
      pushed.jobs = pending.jobs.length;
    });
  }

  if (pending.contacts.length) {
    await attempt("contacts", async (t) => {
      await upsertRows(ctx, t, "contacts", [...TABS.contacts.headers], pending.contacts.map(contactRecord));
      markTrackerSynced("contacts", pending.contacts.map((c) => c.id), startedAt);
      pushed.contacts = pending.contacts.length;
    });
  }

  if (pending.emails.length) {
    await attempt("emails", async (t) => {
      await upsertRows(ctx, t, "emails", [...TABS.emails.headers], pending.emails.map(emailRecord));
      markTrackerSynced("emails", pending.emails.map((e) => e.id), startedAt);
      pushed.emails = pending.emails.length;
    });
  }

  return { tracker, pushed, failures };
}

const connectionCache = new Map<string, { connection: ConnectionInfo | null; at: number }>();

async function sheetsConnection(
  apiKey: string,
  userId: string,
  fresh = false,
): Promise<ConnectionInfo | null> {
  const key = `${apiKey.slice(-12)}:${userId}`;
  const cached = connectionCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < CONNECTION_CACHE_MS) return cached.connection;
  const connection = await findActiveConnection(apiKey, userId, ["googlesheets"]);
  connectionCache.set(key, { connection, at: Date.now() });
  return connection;
}

async function syncOnce(apiKey: string, userId: string): Promise<SyncOutcome> {
  let tracker = getSetting<StoredTracker>(SETTINGS_KEY);
  try {
    const connection = await sheetsConnection(apiKey, userId);
    if (!connection) return { status: "off" };
    const ctx: SheetsContext = { apiKey, userId, connectionId: connection.id };

    let created = false;
    if (tracker && !(await stillThere(ctx, tracker))) {
      if (Date.now() - tracker.createdAt < MIN_REPLACE_AGE_MS) {
        throw new Error("Couldn't open the tracker sheet. Try syncing again in a minute.");
      }
      tracker = null;
    }
    if (!tracker) {
      tracker = await createTracker(ctx);
      created = true;
    }
    if (!tracker.ready) {
      tracker = (await ensureTabs(ctx, tracker)).tracker;
      setSetting(SETTINGS_KEY, tracker);
    }

    let result = await pushPending(ctx, tracker);
    // Rows recorded meanwhile, or a restored tab's history: go round again.
    for (let pass = 1; pass < MAX_PASSES && result.failures.length === 0 && hasPending(); pass += 1) {
      const next = await pushPending(ctx, result.tracker);
      result = {
        tracker: next.tracker,
        pushed: {
          jobs: result.pushed.jobs + next.pushed.jobs,
          contacts: result.pushed.contacts + next.pushed.contacts,
          emails: result.pushed.emails + next.pushed.emails,
        },
        failures: next.failures,
      };
    }
    const error = result.failures.length ? result.failures.join(" · ") : null;
    tracker = {
      ...result.tracker,
      lastSyncedAt: error ? tracker.lastSyncedAt : Date.now(),
      lastError: error,
    };
    setSetting(SETTINGS_KEY, tracker);
    return error
      ? { status: "error", url: tracker.url, error }
      : { status: "synced", url: tracker.url, created, pushed: result.pushed };
  } catch (err) {
    const error = friendly(err);
    if (tracker) setSetting(SETTINGS_KEY, { ...tracker, lastError: error });
    return { status: "error", ...(tracker ? { url: tracker.url } : {}), error };
  }
}

// One sync at a time (there is one tracker). A request that arrives while a
// sync runs makes it go round once more, so its rows are included.
let inFlight: { promise: Promise<SyncOutcome>; again: boolean } | null = null;

/** Copy everything not yet in the sheet. Never rejects. */
export function requestTrackerSync(apiKey: string, userId: string): Promise<SyncOutcome> {
  if (inFlight) {
    inFlight.again = true;
    return inFlight.promise;
  }
  const entry = { again: false, promise: Promise.resolve<SyncOutcome>({ status: "off" }) };
  entry.promise = (async () => {
    try {
      let outcome = await syncOnce(apiKey, userId);
      while (entry.again && outcome.status === "synced") {
        entry.again = false;
        const next = await syncOnce(apiKey, userId);
        outcome =
          next.status === "synced"
            ? {
                ...next,
                created: outcome.created || next.created,
                pushed: {
                  jobs: outcome.pushed.jobs + next.pushed.jobs,
                  contacts: outcome.pushed.contacts + next.pushed.contacts,
                  emails: outcome.pushed.emails + next.pushed.emails,
                },
              }
            : next;
      }
      return outcome;
    } finally {
      inFlight = null;
    }
  })();
  inFlight = entry;
  return entry.promise;
}

/**
 * Wait up to `budgetMs` for a sync and describe the result for a tool's
 * output. A slower sync keeps running in the background.
 */
export async function trackerReport(
  sync: Promise<SyncOutcome>,
  budgetMs: number,
): Promise<TrackerFields> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  const outcome = await Promise.race([sync, timeout]);
  clearTimeout(timer);
  if (!outcome) {
    const stored = getSetting<StoredTracker>(SETTINGS_KEY);
    return { tracker: "syncing", ...(stored?.url ? { tracker_url: stored.url } : {}) };
  }
  if (outcome.status === "off") return {};
  if (outcome.status === "error") {
    return {
      tracker: "failed",
      tracker_error: outcome.error,
      ...(outcome.url ? { tracker_url: outcome.url } : {}),
    };
  }
  return { tracker: "logged", tracker_url: outcome.url };
}

export async function getTrackerStatus(apiKey: string, userId: string): Promise<TrackerStatus> {
  const connection = apiKey
    ? await sheetsConnection(apiKey, userId, true).catch(() => null)
    : null;
  const stored = getSetting<StoredTracker>(SETTINGS_KEY);
  return {
    connected: Boolean(connection),
    url: stored?.url ?? null,
    pending: countPendingTrackerRows(),
    lastSyncedAt: stored?.lastSyncedAt ?? null,
    lastError: stored?.lastError ?? null,
    syncing: inFlight !== null,
    savedJobs: listJobs(500).map((job) => ({
      url: job.url,
      title: job.title,
      company: job.company,
      status: job.status,
    })),
  };
}

// ---------- jobs ----------

// Postings from recent job searches, so an email that names a job link can
// be logged with the full job.
const recentPostings = new Map<string, JobInput>();
const RECENT_POSTINGS_MAX = 500;

function sourceLabel(source: string | undefined, postedBy: string | null | undefined): string | null {
  if (source === "google_jobs") return postedBy ? `Google Jobs (${postedBy})` : "Google Jobs";
  if (source === "dice") return postedBy === "Recruiter" ? "Dice (agency)" : "Dice";
  return source ?? null;
}

export function rememberPostings(source: "google_jobs" | "dice", postings: JobPosting[]): void {
  for (const posting of postings) {
    if (!posting.url) continue;
    recentPostings.delete(posting.url);
    recentPostings.set(posting.url, {
      title: posting.title,
      url: posting.url,
      company: posting.company,
      companyDomain: posting.companyDomain,
      location: posting.location,
      salary: posting.salary,
      employmentType: posting.employmentType,
      remote: posting.remote,
      source: sourceLabel(source, posting.postedBy),
    });
  }
  while (recentPostings.size > RECENT_POSTINGS_MAX) {
    const oldest = recentPostings.keys().next().value;
    if (oldest === undefined) break;
    recentPostings.delete(oldest);
  }
}

export function recentPosting(url: string): JobInput | null {
  return recentPostings.get(url.trim()) ?? null;
}

/** A job card's data (from find_jobs), as saved in the database. */
export function jobInputFromResult(job: JobResult, source?: string): JobInput | null {
  const title = job.title?.trim();
  if (!title) return null;
  return {
    title,
    url: job.url ?? null,
    company: job.company ?? null,
    companyDomain: job.company_domain ?? null,
    location: job.location ?? null,
    salary: job.salary ?? null,
    employmentType: job.type ?? null,
    remote: job.remote ?? null,
    source: sourceLabel(source, job.posted_by),
  };
}

const FREE_MAIL =
  /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|pm|zoho|gmx|mail|yandex)\./i;

/** "Acme, Inc." -> "acme" */
function companyKey(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(
      /\b(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pvt|private|technologies|technology|labs|group|holdings)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * The job an email is about: the posting it links to, a saved job with that
 * title at the recipient's company, or (without a title) the most recent job
 * saved at that company. A role the user named but never saved is added.
 */
export function jobForEmail(input: {
  jobUrl?: string;
  jobTitle?: string;
  toEmail: string;
  contact: ContactRow | null;
}): JobRow | null {
  const url = input.jobUrl?.trim() || null;
  const title = input.jobTitle?.trim() || null;
  const domain = (input.contact?.domain ?? input.toEmail.split("@")[1] ?? "").toLowerCase() || null;
  const companyDomain = domain && !FREE_MAIL.test(domain) ? domain : null;

  if (url) {
    const saved = findJobByUrl(url);
    if (saved) return saved;
    const seen = recentPosting(url);
    if (seen) return saveJob(seen).job;
  }

  const company = companyKey(input.contact?.company);
  const domainRoot = companyDomain ? companyKey(companyDomain.split(".")[0]) : "";
  const atCompany = listJobs().filter((job) => {
    if (companyDomain && job.companyDomain?.toLowerCase() === companyDomain) return true;
    const key = companyKey(job.company);
    return Boolean(key) && (key === company || key === domainRoot);
  });

  if (title) {
    const wanted = title.toLowerCase();
    const match = atCompany.find((job) => {
      const saved = job.title.toLowerCase();
      return saved.includes(wanted) || wanted.includes(saved);
    });
    if (match) return match;
    return saveJob({
      title,
      url,
      company:
        input.contact?.company ?? (companyDomain ? capitalize(companyDomain.split(".")[0]) : null),
      companyDomain,
      source: "Manual",
    }).job;
  }
  return atCompany[0] ?? null;
}
