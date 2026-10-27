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
  /** The employer's own application link (ATS or careers page), when known. */
  apply_url?: string;
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

/** One form field in an application result. */
export interface ApplicationFieldSummary {
  /** Field id to pass back to browser_apply_fill. */
  id: string;
  label: string;
  kind?: string;
  required?: boolean;
  value?: string;
  options?: string[];
  more_options?: number;
  /** What the field shows now (partly filled, or a wrong value). */
  current?: string;
  hint?: string;
  /** Why the last attempt to fill it failed. */
  error?: string;
}

/** browser_apply_* tools (and GET /api/applications/[id]). */
export interface ApplicationOutput extends TrackerFields {
  application_id?: string;
  /**
   * needs_answers: required questions left · needs_user: the user must act in
   * the browser window · next_page · ready_to_submit · submitted · failed
   */
  status?: string;
  title?: string;
  company?: string;
  ats?: string;
  url?: string;
  page_title?: string;
  filled_count?: number;
  filled?: ApplicationFieldSummary[];
  /** Empty fields: required ones first, then a few optional ones. */
  needs?: ApplicationFieldSummary[];
  more_optional?: number;
  problems?: ApplicationFieldSummary[];
  /** Validation messages the site shows. */
  page_errors?: string[];
  /** What the user has to do in the browser window. */
  user_action?: string;
  /** What the assistant should do next. */
  next_step?: string;
  confirmation?: string;
  resume?: string;
  note?: string;
  error?: string;
  /** When the screenshot was taken (for the review card). */
  screenshot_at?: number;
}

/** browser_open / browser_act */
export interface BrowseOutput {
  did?: string;
  url?: string;
  title?: string;
  text?: string;
  elements?: Array<{ id: string; kind: string; label: string; value?: string; href?: string; options?: string[]; required?: boolean }>;
  more_elements?: number;
  blocker?: string;
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

/** memory_save / memory_forget */
export interface MemoryToolOutput {
  saved?: boolean;
  forgotten?: boolean;
  /** The memory item's id (for Undo). */
  id?: string;
  fact?: string;
  /** The text it replaced, when an item was updated. */
  replaced?: string;
  error?: string;
}

/** One remembered fact, as the Memory panel shows it. */
export interface MemoryItem {
  id: string;
  content: string;
  source: "user" | "assistant";
  createdAt: number;
  updatedAt: number;
}

/** How full the model's context is (sent with each reply as a data part). */
export interface ContextInfo {
  /** Estimated tokens the next request sends. */
  tokens: number;
  /** Auto-compact threshold. */
  limit: number;
  /** Messages up to this id are summarized for the model. */
  compactedUpto: string | null;
  /** This request compacted the chat first. */
  compacted?: boolean;
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
