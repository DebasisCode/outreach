import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Local SQLite persistence (node:sqlite, zero native deps).
 *
 * Tables:
 *  - chats           one row per conversation
 *  - messages        full UIMessage JSON per chat
 *  - contacts        remembered people (from tools) + their emails
 *  - emails          log of sent emails (via Composio)
 *  - jobs            jobs the user saved or reached out about
 *  - settings        small key/value store (e.g. the tracker spreadsheet)
 *  - memories        short facts about the user, always in the AI's context
 *  - knowledge       RAG chunks: text + embedding (JSON) + FTS row
 *
 * contacts, emails and jobs carry `synced_at`: when the row was last copied
 * to the Google Sheet tracker (see tracker.ts).
 */

const DB_PATH =
  process.env.OUTREACH_DB_PATH ?? path.join(process.cwd(), ".data", "outreach.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    role TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, id)
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    email_status TEXT,
    title TEXT,
    company TEXT,
    domain TEXT,
    linkedin_url TEXT,
    source TEXT DEFAULT 'cleanlist',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_idx ON contacts(lower(email)) WHERE email IS NOT NULL AND email != '';
  CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    toolkit TEXT,
    contact_id TEXT,
    sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    title TEXT,
    content TEXT NOT NULL,
    embedding TEXT,
    model TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    id UNINDEXED, title, content
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT,
    title TEXT NOT NULL,
    company TEXT,
    company_domain TEXT,
    location TEXT,
    salary TEXT,
    employment_type TEXT,
    remote INTEGER,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'Saved',
    status_synced TEXT,
    status_explicit INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    synced_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_url_idx ON jobs(url) WHERE url IS NOT NULL;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

/** Add a column to a table created by an older version of the app. */
function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("contacts", "synced_at", "INTEGER");
ensureColumn("emails", "job_id", "TEXT");
ensureColumn("emails", "from_address", "TEXT");
ensureColumn("emails", "synced_at", "INTEGER");
// A compacted chat: the summary stands in for messages up to summary_upto.
ensureColumn("chats", "summary", "TEXT");
ensureColumn("chats", "summary_upto", "TEXT");
ensureColumn("chats", "summary_at", "INTEGER");

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

// ---------- settings ----------

export function getSetting<T>(key: string): T | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now());
}

// ---------- users (key persistence, keyed by username) ----------

export function getUser(username: string): { username: string; keys: string } | null {
  const row = db
    .prepare("SELECT username, keys FROM users WHERE username = ?")
    .get(username.trim().toLowerCase()) as
    | { username: string; keys: string }
    | undefined;
  return row ?? null;
}

export function upsertUser(username: string, keysJson: string): void {
  const name = username.trim().toLowerCase();
  if (!name) throw new Error("Username required");
  db.prepare(
    `INSERT INTO users (username, keys, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET keys = excluded.keys, updated_at = excluded.updated_at`,
  ).run(name, keysJson, now(), now());
}

// ---------- chats ----------

export interface ChatRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export function createChat(title = "New chat"): ChatRow {
  const id = uuid();
  const t = now();
  db.prepare(
    "INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(id, title, t, t);
  return { id, title, createdAt: t, updatedAt: t };
}

export function getChat(id: string): ChatRow | null {
  const row = db
    .prepare("SELECT id, title, created_at, updated_at FROM chats WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function listChats(limit = 100): ChatRow[] {
  const rows = db
    .prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }));
}

export function touchChat(id: string, title?: string): void {
  if (title) {
    db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(
      title,
      now(),
      id,
    );
  } else {
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now(), id);
  }
}

export function deleteChat(id: string): void {
  db.prepare("DELETE FROM messages WHERE chat_id = ?").run(id);
  db.prepare("DELETE FROM knowledge WHERE chat_id = ?").run(id);
  db.prepare("DELETE FROM chats WHERE id = ?").run(id);
}

// ---------- messages ----------

export interface StoredMessage {
  id: string;
  role: string;
  data: unknown;
}

/**
 * Insert or update a message. Updates keep the original created_at/rowid so
 * a message edited later (e.g. an approval answered) stays in its place.
 */
export function saveMessage(chatId: string, msg: StoredMessage): void {
  db.prepare(
    `INSERT INTO messages (chat_id, id, role, data, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, id) DO UPDATE SET role = excluded.role, data = excluded.data`,
  ).run(chatId, msg.id, msg.role, JSON.stringify(msg.data), now());
}

/**
 * Drop stored messages the browser no longer has — after Retry or Edit
 * rewound the conversation. Returns how many were removed.
 */
export function deleteMessagesNotIn(chatId: string, keepIds: string[]): number {
  const keep = new Set(keepIds);
  const stored = db.prepare("SELECT id FROM messages WHERE chat_id = ?").all(chatId) as Array<{
    id: string;
  }>;
  const remove = db.prepare("DELETE FROM messages WHERE chat_id = ? AND id = ?");
  let removed = 0;
  for (const row of stored) {
    if (!keep.has(row.id)) {
      remove.run(chatId, row.id);
      removed += 1;
    }
  }
  return removed;
}

// ---------- chat compaction ----------

export interface CompactionSummary {
  summary: string;
  /** Id of the last message the summary covers. */
  upto: string;
  at: number;
}

export function getChatSummary(chatId: string): CompactionSummary | null {
  const row = db
    .prepare("SELECT summary, summary_upto, summary_at FROM chats WHERE id = ?")
    .get(chatId) as Record<string, unknown> | undefined;
  if (!row?.summary || !row.summary_upto) return null;
  return {
    summary: String(row.summary),
    upto: String(row.summary_upto),
    at: Number(row.summary_at ?? 0),
  };
}

export function setChatSummary(chatId: string, summary: string, upto: string): void {
  db.prepare("UPDATE chats SET summary = ?, summary_upto = ?, summary_at = ? WHERE id = ?").run(
    summary,
    upto,
    now(),
    chatId,
  );
}

export function clearChatSummary(chatId: string): void {
  db.prepare(
    "UPDATE chats SET summary = NULL, summary_upto = NULL, summary_at = NULL WHERE id = ?",
  ).run(chatId);
}

export function getMessages(chatId: string): StoredMessage[] {
  const rows = db
    .prepare(
      "SELECT id, role, data FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(chatId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    role: String(r.role),
    data: JSON.parse(String(r.data)),
  }));
}

// ---------- contacts ----------

export interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  emailStatus: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  source: string;
  /** Last time an email was sent to this contact (ms), if ever. */
  lastEmailedAt: number | null;
  createdAt: number;
}

const text = (value: unknown): string | null =>
  value == null || value === "" ? null : String(value);

const rowToContact = (r: Record<string, unknown>): ContactRow => ({
  id: String(r.id),
  name: text(r.name),
  email: text(r.email),
  emailStatus: text(r.email_status),
  title: text(r.title),
  company: text(r.company),
  domain: text(r.domain),
  linkedinUrl: text(r.linkedin_url),
  source: String(r.source ?? "cleanlist"),
  lastEmailedAt: r.last_emailed_at == null ? null : Number(r.last_emailed_at),
  createdAt: Number(r.created_at),
});

// Contacts plus the last time each one was emailed.
const CONTACT_SELECT = `SELECT c.*, (
    SELECT MAX(e.sent_at) FROM emails e
    WHERE c.email IS NOT NULL AND lower(e.to_email) = lower(c.email)
  ) AS last_emailed_at
  FROM contacts c`;

/** "linkedin.com/in/Jane-Doe/?x=1" -> "https://www.linkedin.com/in/jane-doe" */
export function canonicalLinkedinUrl(url: string | null | undefined): string {
  const trimmed = url?.trim() ?? "";
  const match = trimmed.match(/linkedin\.com\/(in|pub)\/([^/?#]+)/i);
  if (!match) return trimmed;
  let slug = match[2];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw slug
  }
  return `https://www.linkedin.com/${match[1].toLowerCase()}/${slug.toLowerCase()}`;
}

function findContactRow(email: string, linkedinUrl: string): Record<string, unknown> | undefined {
  if (email) {
    const byEmail = db
      .prepare("SELECT * FROM contacts WHERE lower(email) = ?")
      .get(email.toLowerCase()) as Record<string, unknown> | undefined;
    if (byEmail) return byEmail;
  }
  if (linkedinUrl) {
    return db
      .prepare("SELECT * FROM contacts WHERE lower(linkedin_url) = ?")
      .get(linkedinUrl.toLowerCase()) as Record<string, unknown> | undefined;
  }
  return undefined;
}

export function upsertContact(input: {
  name?: string;
  email?: string | null;
  emailStatus?: string | null;
  title?: string | null;
  company?: string | null;
  domain?: string | null;
  linkedinUrl?: string | null;
  source?: string;
}): ContactRow | null {
  const email = input.email?.trim() ?? "";
  const linkedinUrl = canonicalLinkedinUrl(input.linkedinUrl);
  if (!email && !linkedinUrl) return null;

  // Match on email first, then LinkedIn — so a person saved before enrichment
  // gets their email added instead of becoming a duplicate row.
  const existing = findContactRow(email, linkedinUrl);

  if (existing) {
    db.prepare(
      `UPDATE contacts SET
        name = COALESCE(?, name),
        email = COALESCE(NULLIF(?, ''), email),
        email_status = COALESCE(?, email_status),
        title = COALESCE(?, title),
        company = COALESCE(?, company),
        domain = COALESCE(?, domain),
        linkedin_url = COALESCE(NULLIF(?, ''), linkedin_url),
        updated_at = ?
       WHERE id = ?`,
    ).run(
      input.name ?? null,
      email,
      input.emailStatus ?? null,
      input.title ?? null,
      input.company ?? null,
      input.domain ?? null,
      linkedinUrl,
      now(),
      String(existing.id),
    );
    return getContact(String(existing.id));
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO contacts (id, name, email, email_status, title, company, domain, linkedin_url, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name ?? null,
    email || null,
    input.emailStatus ?? null,
    input.title ?? null,
    input.company ?? null,
    input.domain ?? null,
    linkedinUrl || null,
    input.source ?? "cleanlist",
    now(),
    now(),
  );
  return getContact(id);
}

export function getContact(id: string): ContactRow | null {
  const row = db.prepare(`${CONTACT_SELECT} WHERE c.id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToContact(row) : null;
}

export function getContactByEmail(email: string): ContactRow | null {
  const row = db.prepare(`${CONTACT_SELECT} WHERE lower(c.email) = ?`).get(
    email.trim().toLowerCase(),
  ) as Record<string, unknown> | undefined;
  return row ? rowToContact(row) : null;
}

/**
 * A contact we already have an email for — by LinkedIn URL, or by full name
 * at the same company domain. Used to avoid paying twice for the same email.
 */
export function findKnownEmail(input: {
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  domain?: string | null;
}): ContactRow | null {
  const linkedinUrl = canonicalLinkedinUrl(input.linkedinUrl);
  if (linkedinUrl) {
    const row = db
      .prepare(`${CONTACT_SELECT} WHERE lower(c.linkedin_url) = ? AND c.email IS NOT NULL AND c.email != ''`)
      .get(linkedinUrl.toLowerCase()) as Record<string, unknown> | undefined;
    if (row) return rowToContact(row);
  }
  const name = [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
  if (name && input.domain) {
    const row = db
      .prepare(
        `${CONTACT_SELECT} WHERE lower(c.name) = ? AND lower(c.domain) = ? AND c.email IS NOT NULL AND c.email != ''`,
      )
      .get(name.toLowerCase(), input.domain.trim().toLowerCase()) as
      | Record<string, unknown>
      | undefined;
    if (row) return rowToContact(row);
  }
  return null;
}

export function searchContacts(query: string, limit = 20): ContactRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const conditions = terms.map(() =>
    "(COALESCE(c.name,'') || ' ' || COALESCE(c.email,'') || ' ' || COALESCE(c.title,'') || ' ' || COALESCE(c.company,'') || ' ' || COALESCE(c.domain,'') || ' ' || COALESCE(c.linkedin_url,'')) LIKE ?",
  );
  const params = terms.map((t) => `%${t}%`);
  const rows = db
    .prepare(
      `${CONTACT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY c.updated_at DESC LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToContact);
}

export function listRecentContacts(limit = 50): ContactRow[] {
  const rows = db
    .prepare(`${CONTACT_SELECT} ORDER BY c.updated_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToContact);
}

// ---------- emails log ----------

export function recordEmail(input: {
  toEmail: string;
  subject: string;
  body: string;
  toolkit?: string;
  /** Mailbox it was sent from. */
  fromAddress?: string | null;
  /** The job this email is about, if known. */
  jobId?: string | null;
}): string {
  const contact = db
    .prepare("SELECT id FROM contacts WHERE lower(email) = ?")
    .get(input.toEmail.trim().toLowerCase()) as { id: string } | undefined;
  const id = uuid();
  db.prepare(
    `INSERT INTO emails (id, to_email, subject, body, toolkit, contact_id, sent_at, from_address, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.toEmail.trim(),
    input.subject,
    input.body,
    input.toolkit ?? null,
    contact?.id ?? null,
    now(),
    input.fromAddress ?? null,
    input.jobId ?? null,
  );
  return id;
}

/** Most recent send to this address, if any. */
export function lastEmailTo(toEmail: string): { subject: string; sentAt: number } | null {
  const row = db
    .prepare(
      "SELECT subject, sent_at FROM emails WHERE lower(to_email) = ? ORDER BY sent_at DESC LIMIT 1",
    )
    .get(toEmail.trim().toLowerCase()) as { subject: string; sent_at: number } | undefined;
  return row ? { subject: row.subject, sentAt: Number(row.sent_at) } : null;
}

// ---------- jobs ----------

export interface JobRow {
  id: string;
  url: string | null;
  title: string;
  company: string | null;
  companyDomain: string | null;
  location: string | null;
  salary: string | null;
  employmentType: string | null;
  remote: boolean | null;
  /** "Dice", "Google Jobs", "Manual", ... */
  source: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

const rowToJob = (r: Record<string, unknown>): JobRow => ({
  id: String(r.id),
  url: text(r.url),
  title: String(r.title),
  company: text(r.company),
  companyDomain: text(r.company_domain),
  location: text(r.location),
  salary: text(r.salary),
  employmentType: text(r.employment_type),
  remote: r.remote == null ? null : Number(r.remote) === 1,
  source: text(r.source),
  status: String(r.status ?? "Saved"),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

export interface JobInput {
  title: string;
  url?: string | null;
  company?: string | null;
  companyDomain?: string | null;
  location?: string | null;
  salary?: string | null;
  employmentType?: string | null;
  remote?: boolean | null;
  source?: string | null;
  /** Set by the user ("I applied"), so it is written to the sheet as-is. */
  status?: string | null;
}

export function getJob(id: string): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToJob(row) : null;
}

export function findJobByUrl(url: string): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE url = ?").get(url.trim()) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToJob(row) : null;
}

/** Most recently touched jobs first. */
export function listJobs(limit = 300): JobRow[] {
  const rows = db
    .prepare("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToJob);
}

/** Save a job, or update the one already saved (same link, or same title at the same company). */
export function saveJob(input: JobInput): { job: JobRow; created: boolean } {
  const title = input.title.trim();
  const url = input.url?.trim() || null;
  const company = input.company?.trim() || null;
  const remote = input.remote == null ? null : input.remote ? 1 : 0;
  const t = now();

  let existing = url
    ? (db.prepare("SELECT * FROM jobs WHERE url = ?").get(url) as Record<string, unknown> | undefined)
    : undefined;
  if (!existing && company) {
    existing = db
      .prepare(
        "SELECT * FROM jobs WHERE lower(title) = ? AND lower(COALESCE(company, '')) = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(title.toLowerCase(), company.toLowerCase()) as Record<string, unknown> | undefined;
  }

  if (existing) {
    const id = String(existing.id);
    const status = input.status && input.status !== existing.status ? input.status : null;
    db.prepare(
      `UPDATE jobs SET
        url = COALESCE(url, ?),
        company = COALESCE(company, ?),
        company_domain = COALESCE(company_domain, ?),
        location = COALESCE(location, ?),
        salary = COALESCE(salary, ?),
        employment_type = COALESCE(employment_type, ?),
        remote = COALESCE(remote, ?),
        source = COALESCE(source, ?),
        status = COALESCE(?, status),
        status_explicit = CASE WHEN ? IS NULL THEN status_explicit ELSE 1 END,
        updated_at = ?
       WHERE id = ?`,
    ).run(
      url,
      company,
      input.companyDomain ?? null,
      input.location ?? null,
      input.salary ?? null,
      input.employmentType ?? null,
      remote,
      input.source ?? null,
      status,
      status,
      t,
      id,
    );
    return { job: getJob(id) as JobRow, created: false };
  }

  const id = uuid();
  db.prepare(
    `INSERT INTO jobs (id, url, title, company, company_domain, location, salary, employment_type, remote, source, status, status_explicit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    url,
    title,
    company,
    input.companyDomain ?? null,
    input.location ?? null,
    input.salary ?? null,
    input.employmentType ?? null,
    remote,
    input.source ?? null,
    input.status || "Saved",
    input.status ? 1 : 0,
    t,
    t,
  );
  return { job: getJob(id) as JobRow, created: true };
}

/** An email went out about this job: "Saved" becomes "Emailed". */
export function markJobEmailed(jobId: string): void {
  db.prepare(
    "UPDATE jobs SET status = CASE WHEN status = 'Saved' THEN 'Emailed' ELSE status END, updated_at = ? WHERE id = ?",
  ).run(now(), jobId);
}

// ---------- tracker sync: rows the Google Sheet doesn't have yet ----------

export interface TrackerJobRow extends JobRow {
  /** Status last written to the sheet. */
  statusSynced: string | null;
  /** The user set the status in chat, so it overrides the sheet. */
  statusExplicit: boolean;
  syncedAt: number | null;
  lastEmailedAt: number | null;
  /** "Name <email>" for everyone emailed about this job. */
  contacted: string[];
}

export interface TrackerEmailRow {
  id: string;
  toEmail: string;
  subject: string;
  body: string;
  fromAddress: string | null;
  sentAt: number;
  contactName: string | null;
  contactCompany: string | null;
  jobTitle: string | null;
  jobCompany: string | null;
}

// `>=` so a change made in the same millisecond a sync started is sent again.
const PENDING_JOBS = `SELECT * FROM (
    SELECT j.*, (SELECT MAX(e.sent_at) FROM emails e WHERE e.job_id = j.id) AS last_emailed_at
    FROM jobs j
  ) WHERE synced_at IS NULL OR updated_at >= synced_at OR last_emailed_at >= synced_at`;

// Only people with an email address belong in the tracker.
const PENDING_CONTACTS = `SELECT * FROM (${CONTACT_SELECT})
  WHERE email IS NOT NULL AND email != ''
    AND (synced_at IS NULL OR updated_at >= synced_at OR last_emailed_at >= synced_at)`;

const PENDING_EMAILS = `SELECT e.*, c.name AS contact_name, c.company AS contact_company,
    j.title AS job_title, j.company AS job_company
  FROM emails e
  LEFT JOIN contacts c ON c.id = e.contact_id
  LEFT JOIN jobs j ON j.id = e.job_id
  WHERE e.synced_at IS NULL`;

function contactedAbout(jobId: string): string[] {
  const rows = db
    .prepare(
      `SELECT e.to_email AS email, MAX(c.name) AS name FROM emails e
       LEFT JOIN contacts c ON c.id = e.contact_id
       WHERE e.job_id = ? GROUP BY lower(e.to_email) ORDER BY MIN(e.sent_at)`,
    )
    .all(jobId) as Array<{ email: string; name: string | null }>;
  return rows.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email));
}

const ms = (value: unknown) => (value == null ? null : Number(value));

export function pendingTrackerRows(): {
  jobs: TrackerJobRow[];
  contacts: ContactRow[];
  emails: TrackerEmailRow[];
} {
  const jobs = (
    db.prepare(`${PENDING_JOBS} ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>
  ).map((r) => ({
    ...rowToJob(r),
    statusSynced: text(r.status_synced),
    statusExplicit: Number(r.status_explicit) === 1,
    syncedAt: ms(r.synced_at),
    lastEmailedAt: ms(r.last_emailed_at),
    contacted: contactedAbout(String(r.id)),
  }));
  const contacts = (
    db.prepare(`${PENDING_CONTACTS} ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>
  ).map(rowToContact);
  const emails = (
    db.prepare(`${PENDING_EMAILS} ORDER BY e.sent_at ASC`).all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    toEmail: String(r.to_email),
    subject: String(r.subject),
    body: String(r.body),
    fromAddress: text(r.from_address),
    sentAt: Number(r.sent_at),
    contactName: text(r.contact_name),
    contactCompany: text(r.contact_company),
    jobTitle: text(r.job_title),
    jobCompany: text(r.job_company),
  }));
  return { jobs, contacts, emails };
}

export function countPendingTrackerRows(): { jobs: number; contacts: number; emails: number } {
  const count = (sql: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get() as { n: number }).n);
  return {
    jobs: count(PENDING_JOBS),
    contacts: count(PENDING_CONTACTS),
    emails: count(PENDING_EMAILS),
  };
}

const SYNCED_TABLES = { jobs: "jobs", contacts: "contacts", emails: "emails" } as const;

export function markTrackerSynced(
  kind: keyof typeof SYNCED_TABLES,
  ids: string[],
  at: number,
): void {
  const update = db.prepare(`UPDATE ${SYNCED_TABLES[kind]} SET synced_at = ? WHERE id = ?`);
  for (const id of ids) update.run(at, id);
}

/** The sheet now shows `status` for this job. */
export function markJobStatusSynced(jobId: string, status: string): void {
  db.prepare("UPDATE jobs SET status_synced = ?, status_explicit = 0 WHERE id = ?").run(
    status,
    jobId,
  );
}

/** The user changed the status in the sheet — keep theirs. */
export function adoptJobStatus(jobId: string, status: string): void {
  db.prepare(
    "UPDATE jobs SET status = ?, status_synced = ?, status_explicit = 0 WHERE id = ?",
  ).run(status, status, jobId);
}

/**
 * A new tracker sheet (or a re-created tab): those rows get copied again.
 * Without arguments, everything.
 */
export function resetTrackerSync(kinds: Array<keyof typeof SYNCED_TABLES> = ["jobs", "contacts", "emails"]): void {
  for (const kind of kinds) {
    db.exec(
      kind === "jobs"
        ? "UPDATE jobs SET synced_at = NULL, status_synced = NULL"
        : `UPDATE ${SYNCED_TABLES[kind]} SET synced_at = NULL`,
    );
  }
}

// ---------- memory (facts about the user, always in context) ----------

export interface MemoryRow {
  id: string;
  content: string;
  /** "user": typed with # or in the Memory panel · "assistant": saved by the AI */
  source: "user" | "assistant";
  createdAt: number;
  updatedAt: number;
}

export const MEMORY_MAX_ITEMS = 60;
export const MEMORY_MAX_CHARS = 400;

const rowToMemory = (r: Record<string, unknown>): MemoryRow => ({
  id: String(r.id),
  content: String(r.content),
  source: r.source === "assistant" ? "assistant" : "user",
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** Oldest first, so the list reads the same in every prompt. */
export function listMemories(): MemoryRow[] {
  const rows = db
    .prepare("SELECT * FROM memories ORDER BY created_at ASC")
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/** By full id, or by the short id shown to the model (its first characters). */
export function findMemory(idOrPrefix: string): MemoryRow | null {
  const key = idOrPrefix.trim().replace(/^\[|\]$/g, "");
  if (!key) return null;
  const rows = db
    .prepare("SELECT * FROM memories WHERE id = ? OR id LIKE ? LIMIT 2")
    .all(key, `${key}%`) as Array<Record<string, unknown>>;
  const exact = rows.find((r) => r.id === key);
  if (exact) return rowToMemory(exact);
  return rows.length === 1 ? rowToMemory(rows[0]) : null;
}

function cleanMemory(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, MEMORY_MAX_CHARS);
}

/** Add a fact; the same fact again just refreshes it. */
export function addMemory(content: string, source: MemoryRow["source"]): MemoryRow {
  const text = cleanMemory(content);
  if (!text) throw new Error("Memory can't be empty.");
  const existing = db
    .prepare("SELECT * FROM memories WHERE lower(content) = ?")
    .get(text.toLowerCase()) as Record<string, unknown> | undefined;
  if (existing) {
    db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(now(), String(existing.id));
    return rowToMemory({ ...existing, updated_at: now() });
  }
  const count = Number((db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n);
  if (count >= MEMORY_MAX_ITEMS) {
    throw new Error(
      `Memory is full (${MEMORY_MAX_ITEMS} items). Replace or remove an outdated item first.`,
    );
  }
  const id = uuid();
  const t = now();
  db.prepare(
    "INSERT INTO memories (id, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, text, source, t, t);
  return { id, content: text, source, createdAt: t, updatedAt: t };
}

export function updateMemory(id: string, content: string): MemoryRow | null {
  const text = cleanMemory(content);
  if (!text) throw new Error("Memory can't be empty.");
  db.prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?").run(text, now(), id);
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMemory(row) : null;
}

export function deleteMemory(id: string): boolean {
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

// ---------- knowledge (RAG) ----------

export interface KnowledgeChunk {
  id: string;
  title: string | null;
  content: string;
  embedding: number[] | null;
  model: string | null;
  createdAt: number;
}

export function insertKnowledge(input: {
  chatId?: string | null;
  title?: string | null;
  content: string;
  embedding?: number[] | null;
  model?: string | null;
}): string {
  const id = uuid();
  db.prepare(
    "INSERT INTO knowledge (id, chat_id, title, content, embedding, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.chatId ?? null,
    input.title ?? null,
    input.content,
    input.embedding ? JSON.stringify(input.embedding) : null,
    input.model ?? null,
    now(),
  );
  db.prepare("INSERT INTO knowledge_fts (id, title, content) VALUES (?, ?, ?)").run(
    id,
    input.title ?? "",
    input.content,
  );
  return id;
}

export function ftsSearchKnowledge(query: string, limit = 8): KnowledgeChunk[] {
  const safe = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");
  if (!safe) return [];
  const rows = db
    .prepare(
      `SELECT k.id, k.title, k.content, k.embedding, k.model, k.created_at
       FROM knowledge_fts f JOIN knowledge k ON k.id = f.id
       WHERE knowledge_fts MATCH ?
       ORDER BY rank LIMIT ?`,
    )
    .all(safe, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToChunk);
}

export function allKnowledge(): KnowledgeChunk[] {
  const rows = db
    .prepare(
      "SELECT id, title, content, embedding, model, created_at FROM knowledge WHERE embedding IS NOT NULL",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToChunk);
}

export function listKnowledge(limit = 100): KnowledgeChunk[] {
  const rows = db
    .prepare(
      "SELECT id, title, content, embedding, model, created_at FROM knowledge ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToChunk);
}

const rowToChunk = (r: Record<string, unknown>): KnowledgeChunk => ({
  id: String(r.id),
  title: r.title == null ? null : String(r.title),
  content: String(r.content),
  embedding: r.embedding ? (JSON.parse(String(r.embedding)) as number[]) : null,
  model: r.model == null ? null : String(r.model),
  createdAt: Number(r.created_at),
});

export function deleteKnowledge(id: string): void {
  db.prepare("DELETE FROM knowledge WHERE id = ?").run(id);
  db.prepare("DELETE FROM knowledge_fts WHERE id = ?").run(id);
}

export function knowledgeCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM knowledge").get() as {
    c: number;
  };
  return Number(row.c);
}