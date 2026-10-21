/**
 * JSON shapes the chat tools return. Shared by the server tools (which build
 * them) and the chat UI cards (which render them), so both stay in sync.
 * Tools return these as JSON strings; parseToolOutput() reads them back.
 */

export interface PersonResult {
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  seniority?: string;
  location?: string;
  company?: string;
  domain?: string;
  linkedin_url?: string;
  /** Already in contacts — no credit needed. */
  email?: string;
  email_status?: string;
}

export interface FindPeopleOutput {
  company_domain?: string;
  total_matches?: number | null;
  people?: PersonResult[];
  note?: string;
  error?: string;
}

/**
 * Whether a tool's result reached the Google Sheet tracker. Left out when
 * Google Sheets isn't connected.
 */
export interface TrackerFields {
  /** logged: in the sheet · syncing: still being written · failed: see tracker_error */
  tracker?: "logged" | "syncing" | "failed";
  tracker_url?: string;
  tracker_error?: string;
}

export interface EnrichOutput extends TrackerFields {
  found?: boolean;
  /** Came from contacts — no credit spent. */
  cached?: boolean;
  pending?: boolean;
  workflow_id?: string;
  email?: string;
  email_status?: string;
  full_name?: string;
  title?: string;
  company?: string;
  linkedin_url?: string;
  credits_charged?: number | null;
  warning?: string;
  note?: string;
  error?: string;
}

export interface JobResult {
  title?: string;
  company?: string;
  company_domain?: string;
  location?: string;
  remote?: boolean;
  posted?: string;
  salary?: string;
  type?: string;
  posted_by?: string;
  url?: string;
  summary?: string;
}

export interface FindJobsOutput {
  source?: "google_jobs" | "dice";
  note?: string;
  jobs?: JobResult[];
  error?: string;
}

export interface ContactResult {
  name?: string;
  email?: string;
  email_status?: string;
  title?: string;
  company?: string;
  domain?: string;
  linkedin_url?: string;
  /** YYYY-MM-DD of the last email sent to them. */
  last_emailed?: string;
}

export interface ContactsLookupOutput {
  contacts?: ContactResult[];
  error?: string;
}

export interface EmailToolOutput extends TrackerFields {
  sent?: boolean;
  drafted?: boolean;
  to?: string;
  from?: string;
  mailbox?: string;
  via?: string;
  note?: string;
  error?: string;
}

export interface SaveJobOutput extends TrackerFields {
  saved?: boolean;
  title?: string;
  company?: string;
  status?: string;
  url?: string;
  error?: string;
}

/** A job the user saved (or emailed about), as the job cards need it. */
export interface SavedJob {
  url: string | null;
  title: string;
  company: string | null;
  status: string;
}

/** GET /api/tracker */
export interface TrackerStatus {
  /** An active Google Sheets connection exists. */
  connected: boolean;
  /** The tracker spreadsheet, once created. */
  url: string | null;
  /** Rows not yet copied to the sheet. */
  pending: { jobs: number; contacts: number; emails: number };
  lastSyncedAt: number | null;
  lastError: string | null;
  syncing: boolean;
  savedJobs: SavedJob[];
}

/** Keys that identify a job: its link, and its title at the company. */
export function jobKeys(job: {
  url?: string | null;
  title?: string | null;
  company?: string | null;
}): string[] {
  const keys: string[] = [];
  if (job.url?.trim()) keys.push(`url:${job.url.trim()}`);
  if (job.title?.trim() && job.company?.trim()) {
    keys.push(`job:${job.company.trim().toLowerCase()}|${job.title.trim().toLowerCase()}`);
  }
  return keys;
}

/** Tool results are JSON strings; returns null when not parseable. */
export function parseToolOutput<T>(output: unknown): T | null {
  if (output && typeof output === "object") return output as T;
  if (typeof output !== "string") return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** Stable key for matching LinkedIn profiles ("/in/<slug>", lowercased). */
export function linkedinKey(url: string | null | undefined): string | null {
  return url?.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null;
}
