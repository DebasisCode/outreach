/**
 * CleanList API v2 client (https://docs.cleanlist.ai/api-reference-v2).
 *
 *  - searchPeople: free. POST /people/find with the flat `filters` form. The
 *    richer `criteria` form (substring title matching) is not available on
 *    AppSumo plans, so title keywords are matched locally instead.
 *  - enrichPerson: 1 credit, charged only when an email is found. Async:
 *    POST /enrichment/person, then poll GET /enrichment/status/{workflow_id}.
 *
 * Limits: 60 people searches per UTC day per organization, 30 requests per
 * minute per key. The key is the user's own (sent from the UI per request).
 */

const CLEANLIST_BASE_URL = "https://api.cleanlist.ai/api/v2";
const REQUEST_TIMEOUT_MS = 20_000;
const POLL_BACKOFF_MS = [2000, 3000, 4000, 5000, 8000];
// Stay well inside the chat route's 300s budget. Slower runs are reported as
// pending and can be checked later with checkEnrichment().
const POLL_MAX_WAIT_MS = 120_000;
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** Values the flat `filters` form accepts — anything else is a 400. */
export const DEPARTMENTS = [
  "Engineering",
  "Product",
  "Design",
  "Sales",
  "Marketing",
  "Customer Success",
  "Operations",
  "Finance",
  "People & HR",
  "Legal",
  "IT",
  "Data",
  "Research",
  "Support",
  "Business Development",
  "Consulting",
] as const;

export const SENIORITY_LEVELS = [
  "Owner",
  "Founder",
  "C-Suite",
  "Partner",
  "Vice President",
  "Head",
  "Director",
  "Manager",
  "Senior",
  "Entry",
  "Trainee",
  "Unpaid",
] as const;

// Models (and people) say "HR" or "Recruiting"; CleanList only knows "People & HR".
const DEPARTMENT_ALIASES: Record<string, string> = {
  hr: "People & HR",
  "human resources": "People & HR",
  people: "People & HR",
  "people and hr": "People & HR",
  "people operations": "People & HR",
  recruiting: "People & HR",
  recruitment: "People & HR",
  recruiter: "People & HR",
  recruiters: "People & HR",
  talent: "People & HR",
  "talent acquisition": "People & HR",
  "information technology": "IT",
  "data science": "Data",
  "customer support": "Support",
  "biz dev": "Business Development",
};

const SENIORITY_ALIASES: Record<string, string> = {
  vp: "Vice President",
  svp: "Vice President",
  evp: "Vice President",
  "c-level": "C-Suite",
  "c level": "C-Suite",
  cxo: "C-Suite",
  executive: "C-Suite",
  lead: "Head",
  "head of": "Head",
  "hiring manager": "Manager",
  sr: "Senior",
  junior: "Entry",
  "entry level": "Entry",
  intern: "Trainee",
};

export class CleanlistError extends Error {
  status: number;
  code: string | null;
  detail: string | null;
  retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string | null;
      detail?: string | null;
      retryAfterSeconds?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "CleanlistError";
    this.status = options.status ?? 0;
    this.code = options.code ?? null;
    this.detail = options.detail ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export interface CleanlistPerson {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
  seniority?: string;
  company?: string;
  domain?: string;
  location?: string;
  linkedinUrl?: string;
}

export interface EnrichedPerson extends CleanlistPerson {
  email: string;
  emailStatus: string | null;
  provider: string | null;
}

/** Pull a readable reason out of CleanList's error envelopes. */
function parseErrorBody(text: string): { code: string | null; detail: string | null } {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (body.error && typeof body.error === "object") {
      const error = body.error as Record<string, unknown>;
      const parts = [error.problem ?? error.message, error.fix].filter(
        (part): part is string => typeof part === "string" && part.trim().length > 0,
      );
      return {
        code: typeof error.code === "string" ? error.code : null,
        detail: parts.join(" ") || null,
      };
    }
    if (typeof body.detail === "string") return { code: null, detail: body.detail };
    if (Array.isArray(body.detail)) {
      // FastAPI validation errors: [{ loc: [...], msg }]
      const messages = body.detail.map((item) => {
        const entry = item as Record<string, unknown>;
        const loc = Array.isArray(entry.loc) ? entry.loc.join(".") : "";
        return `${loc}: ${String(entry.msg ?? "invalid")}`;
      });
      return { code: "validation_error", detail: messages.join("; ") };
    }
    if (typeof body.message === "string") return { code: null, detail: body.message };
  } catch {
    // not JSON
  }
  const trimmed = text.trim();
  return { code: null, detail: trimmed ? trimmed.slice(0, 300) : null };
}

async function cleanlistRequest<T>(
  apiKey: string,
  options: { method: string; path: string; body?: unknown },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${CLEANLIST_BASE_URL}${options.path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CleanlistError(
      `Could not reach CleanList: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const { code, detail } = parseErrorBody(text);
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new CleanlistError(
      `CleanList ${options.method} ${options.path} failed (${res.status})${detail ? `: ${detail}` : ""}`,
      {
        status: res.status,
        code,
        detail,
        retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      },
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CleanlistError(
      `CleanList ${options.method} ${options.path} returned non-JSON`,
      { status: res.status },
    );
  }
}

const stripDecoration = (value: string): string =>
  value
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

const pickString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const toPerson = (record: Record<string, unknown>): CleanlistPerson | null => {
  const linkedinUrl = pickString(record, ["linkedin_url", "linkedinUrl"]);
  const firstName = stripDecoration(pickString(record, ["first_name", "firstName"]) ?? "");
  const lastName = stripDecoration(pickString(record, ["last_name", "lastName"]) ?? "");
  // Keep a record only if it can be enriched later.
  if (!linkedinUrl && !(firstName && lastName)) return null;
  return {
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    fullName: stripDecoration(
      pickString(record, ["full_name", "fullName", "name"]) ?? `${firstName} ${lastName}`,
    ),
    title: pickString(record, ["title", "job_title", "jobTitle"]),
    seniority: pickString(record, ["seniority"]),
    company: pickString(record, ["company", "company_name", "companyName"]),
    domain: pickString(record, ["domain", "company_domain", "companyDomain"]),
    location: pickString(record, ["location"]),
    linkedinUrl,
  };
};

const extractPeople = (payload: unknown): Record<string, unknown>[] => {
  if (!payload || typeof payload !== "object") return [];
  const envelope = payload as Record<string, unknown>;
  for (const key of ["results", "people", "leads", "items", "data"]) {
    const value = envelope[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
};

function normalizeVocab(
  values: string[] | undefined,
  allowed: readonly string[],
  aliases: Record<string, string>,
): { valid: string[]; ignored: string[] } {
  const valid = new Set<string>();
  const ignored: string[] = [];
  for (const raw of values ?? []) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const match = allowed.find((value) => value.toLowerCase() === key) ?? aliases[key];
    if (match) valid.add(match);
    else ignored.push(raw);
  }
  return { valid: [...valid], ignored };
}

/** "https://www.Stripe.com/jobs" -> "stripe.com" */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^(www|careers|jobs)\./, "")
    .split(/[/?#:]/)[0]
    .replace(/\.$/, "");
}

export interface SearchPeopleInput {
  domain?: string;
  companyName?: string;
  departments?: string[];
  seniority?: string[];
  /** Case-insensitive substrings matched against job titles, e.g. "recruit". */
  titleKeywords?: string[];
  /** Country name, e.g. "India" or "United States". */
  country?: string;
  limit?: number;
}

export interface SearchPeopleResult {
  people: CleanlistPerson[];
  /** CleanList's total for the filters (before local keyword matching). */
  total: number | null;
  /** True when no title matched the keywords, so `people` is unfiltered. */
  keywordFallback: boolean;
  /** Department/seniority values CleanList would reject (dropped). */
  ignoredFilters: string[];
  domain: string | null;
}

const searchCache = new Map<string, { at: number; rows: CleanlistPerson[]; total: number | null }>();

/** Free people search at one company (by domain, or by name if no domain). */
export async function searchPeople(
  apiKey: string,
  input: SearchPeopleInput,
): Promise<SearchPeopleResult> {
  const filters: Record<string, string[]> = {};
  const domain = input.domain ? normalizeDomain(input.domain) : "";
  if (domain) filters.company_domains = [domain];
  else if (input.companyName?.trim()) filters.company_names = [input.companyName.trim()];
  else {
    throw new CleanlistError(
      "Need the company's website domain (e.g. stripe.com) or its exact name.",
    );
  }

  const departments = normalizeVocab(input.departments, DEPARTMENTS, DEPARTMENT_ALIASES);
  const seniority = normalizeVocab(input.seniority, SENIORITY_LEVELS, SENIORITY_ALIASES);
  if (departments.valid.length) filters.departments = departments.valid;
  if (seniority.valid.length) filters.seniority = seniority.valid;
  if (input.country?.trim()) filters.location_country = [input.country.trim()];

  const keywords = (input.titleKeywords ?? [])
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean);
  const wanted = Math.min(Math.max(Math.round(input.limit ?? 15), 1), 50);
  // CleanList title filters are exact-match only, so with keywords pull a full
  // page (100 is the per-response max) and match locally. Same single search.
  const fetchLimit = keywords.length ? 100 : wanted;

  // Searches are capped per day — reuse identical recent searches.
  const cacheKey = JSON.stringify([apiKey.slice(-12), filters, fetchLimit]);
  const cached = searchCache.get(cacheKey);
  let rows: CleanlistPerson[];
  let total: number | null;
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) {
    ({ rows, total } = cached);
  } else {
    const payload = await cleanlistRequest<Record<string, unknown>>(apiKey, {
      method: "POST",
      path: "/people/find",
      body: { filters, limit: fetchLimit },
    });
    rows = extractPeople(payload)
      .map(toPerson)
      .filter((person): person is CleanlistPerson => person !== null);
    total = typeof payload.total === "number" ? payload.total : null;
    searchCache.set(cacheKey, { at: Date.now(), rows, total });
  }

  const matched = keywords.length
    ? rows.filter((person) => {
        const title = (person.title ?? "").toLowerCase();
        return keywords.some((keyword) => title.includes(keyword));
      })
    : rows;
  const keywordFallback = keywords.length > 0 && matched.length === 0 && rows.length > 0;

  return {
    people: (keywordFallback ? rows : matched).slice(0, wanted),
    total,
    keywordFallback,
    ignoredFilters: [...departments.ignored, ...seniority.ignored],
    domain: domain || null,
  };
}

const linkedinSlug = (url: string | undefined): string | null =>
  url?.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null;

/** The same person from a recent people search (for title/company/domain). */
export function findInRecentSearches(linkedinUrl: string | undefined): CleanlistPerson | null {
  const slug = linkedinSlug(linkedinUrl);
  if (!slug) return null;
  for (const entry of searchCache.values()) {
    const match = entry.rows.find((person) => linkedinSlug(person.linkedinUrl) === slug);
    if (match) return match;
  }
  return null;
}

// ---------- enrichment ----------

const leadListIds = new Map<string, string>();

function extractListId(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const direct = pickString(record, ["list_id", "id"]);
    if (direct) return direct;
    for (const key of ["list", "data", "lead_list", "result"]) {
      const nested = record[key];
      if (nested && typeof nested === "object") {
        const id = pickString(nested as Record<string, unknown>, ["list_id", "id"]);
        if (id) return id;
      }
    }
  }
  throw new CleanlistError("CleanList lead-list response has no list_id");
}

/** Lead list that enriched contacts land in. POST is idempotent by name. */
async function ensureLeadList(apiKey: string, name: string): Promise<string> {
  const cacheKey = `${apiKey.slice(-12)}::${name.toLowerCase()}`;
  const cached = leadListIds.get(cacheKey);
  if (cached) return cached;
  const payload = await cleanlistRequest<unknown>(apiKey, {
    method: "POST",
    path: "/lead-lists",
    body: { name, description: "Auto-managed by the Outreach job-application assistant." },
  });
  const id = extractListId(payload);
  leadListIds.set(cacheKey, id);
  return id;
}

export interface EnrichPersonInput {
  /** Name of the CleanList lead list to store results in (created if missing). */
  listName: string;
  firstName?: string;
  lastName?: string;
  domain?: string;
  companyName?: string;
  linkedinUrl?: string;
}

export type EnrichOutcome =
  | { kind: "found"; workflowId: string; person: EnrichedPerson; creditsCharged: number | null }
  | { kind: "not_found"; workflowId: string; reason: string }
  | { kind: "pending"; workflowId: string };

interface StatusResponse {
  status?: string;
  credits_charged?: number | null;
  refund_status?: string | null;
  refund_message?: string | null;
  result?: {
    status?: string | null;
    email?: string | null;
    email_status?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    full_name?: string | null;
    linkedin_url?: string | null;
    title?: string | null;
    company?: string | null;
    provider?: string | null;
    failure_kind?: string | null;
    error?: string | null;
  } | null;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
  "canceled",
  "terminated",
]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function interpretStatus(
  status: StatusResponse,
  workflowId: string,
  input?: Partial<EnrichPersonInput>,
): EnrichOutcome {
  const outer = (status.status ?? "").toLowerCase();
  if (!TERMINAL_STATUSES.has(outer)) return { kind: "pending", workflowId };

  const result = status.result ?? null;
  if (result?.email) {
    return {
      kind: "found",
      workflowId,
      creditsCharged: typeof status.credits_charged === "number" ? status.credits_charged : null,
      person: {
        firstName: result.first_name ?? input?.firstName,
        lastName: result.last_name ?? input?.lastName,
        fullName:
          result.full_name ??
          ([input?.firstName, input?.lastName].filter(Boolean).join(" ") || undefined),
        title: result.title ?? undefined,
        company: result.company ?? input?.companyName,
        domain: input?.domain ? normalizeDomain(input.domain) : undefined,
        linkedinUrl: result.linkedin_url ?? input?.linkedinUrl,
        email: result.email,
        emailStatus: result.email_status ?? null,
        provider: result.provider ?? null,
      },
    };
  }

  let reason: string;
  if (result?.failure_kind === "person_opted_out") {
    reason = "This person opted out of data enrichment. No credit charged — don't retry.";
  } else if (result?.failure_kind === "miss" || outer === "completed") {
    reason = "No email found for this person. No credit charged.";
  } else if (result?.error) {
    reason = `Enrichment failed: ${result.error}`;
  } else {
    reason = `Enrichment ended with status "${outer}" and no email.`;
  }
  if (status.refund_status === "pending_review") {
    reason += ` CleanList flagged a refund for review${status.refund_message ? `: ${status.refund_message}` : "."}`;
  }
  return { kind: "not_found", workflowId, reason };
}

async function fetchStatus(apiKey: string, workflowId: string): Promise<StatusResponse> {
  return cleanlistRequest<StatusResponse>(apiKey, {
    method: "GET",
    path: `/enrichment/status/${encodeURIComponent(workflowId)}`,
  });
}

const isTransient = (err: unknown) =>
  err instanceof CleanlistError && (err.status === 0 || err.status === 429 || err.status >= 500);

async function pollEnrichment(
  apiKey: string,
  workflowId: string,
  input: Partial<EnrichPersonInput>,
): Promise<EnrichOutcome> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    await sleep(POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]);
    try {
      const outcome = interpretStatus(await fetchStatus(apiKey, workflowId), workflowId, input);
      if (outcome.kind !== "pending") return outcome;
    } catch (err) {
      // The credit is already reserved — ride out blips instead of giving up.
      if (!isTransient(err)) throw err;
    }
    if (Date.now() - startedAt > POLL_MAX_WAIT_MS) return { kind: "pending", workflowId };
  }
}

const hasUsableIdentifier = (input: EnrichPersonInput): boolean =>
  Boolean(
    input.linkedinUrl ||
      (input.firstName && input.lastName && (input.domain || input.companyName)),
  );

/**
 * Enrich one person for a work email (1 credit, only when found). Waits up to
 * ~2 minutes; longer runs come back as `pending` with a workflow id.
 */
export async function enrichPerson(
  apiKey: string,
  input: EnrichPersonInput,
): Promise<EnrichOutcome> {
  if (!hasUsableIdentifier(input)) {
    throw new CleanlistError(
      "Need a LinkedIn URL, or first + last name plus the company domain or name.",
    );
  }
  const body = {
    enrichment_type: "partial",
    ...(input.linkedinUrl ? { linkedin_url: input.linkedinUrl } : {}),
    ...(input.firstName ? { first_name: input.firstName } : {}),
    ...(input.lastName ? { last_name: input.lastName } : {}),
    ...(input.domain ? { domain: normalizeDomain(input.domain) } : {}),
    ...(input.companyName ? { company_name: input.companyName } : {}),
  };

  const dispatch = async () =>
    cleanlistRequest<{ workflow_id?: string }>(apiKey, {
      method: "POST",
      path: "/enrichment/person",
      body: { ...body, lead_list_id: await ensureLeadList(apiKey, input.listName) },
    });

  let dispatched: { workflow_id?: string };
  try {
    dispatched = await dispatch();
  } catch (err) {
    // The cached list may have been deleted in CleanList — recreate once.
    if (err instanceof CleanlistError && err.status === 404) {
      leadListIds.clear();
      dispatched = await dispatch();
    } else {
      throw err;
    }
  }
  if (!dispatched.workflow_id) {
    throw new CleanlistError("CleanList enrichment dispatch returned no workflow_id");
  }
  return pollEnrichment(apiKey, dispatched.workflow_id, input);
}

/** One status check for an enrichment that was still running earlier. */
export async function checkEnrichment(
  apiKey: string,
  workflowId: string,
): Promise<EnrichOutcome> {
  return interpretStatus(await fetchStatus(apiKey, workflowId), workflowId);
}

/** Map a CleanlistError to a user-facing sentence. */
export function cleanlistFailureMessage(err: unknown): string {
  if (!(err instanceof CleanlistError)) {
    return err instanceof Error ? err.message : "Unknown CleanList error";
  }
  const detail = err.detail ? `: ${err.detail}` : "";
  const code = (err.code ?? "").toLowerCase();
  if (err.status === 0) return err.message;
  if (err.status === 401) return "CleanList rejected the API key — check it in Settings.";
  if (err.status === 402 || code === "insufficient_credits") {
    return `Not enough CleanList credits${detail}`;
  }
  if (err.status === 403) return `CleanList refused this request${detail}`;
  if (err.status === 429) {
    const wait = err.retryAfterSeconds
      ? ` Try again in about ${Math.ceil(err.retryAfterSeconds / 60)} min.`
      : "";
    return `CleanList rate limit reached (people search: 60 searches/day; 30 requests/min).${wait}`;
  }
  if (err.status >= 500) {
    return `CleanList is having problems right now (HTTP ${err.status}) — try again shortly.`;
  }
  return `CleanList rejected the request (HTTP ${err.status})${detail}`;
}
