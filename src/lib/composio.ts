import { AuthScheme, Composio } from "@composio/core";

/**
 * Composio holds the connections to the user's own accounts and runs actions
 * through them. This app uses it to:
 *  - send email and save drafts from the user's Gmail (or Outlook)
 *  - search job listings: Google Jobs via SerpAPI when connected, else Dice
 *
 * Everything is scoped to the user's Composio API key plus a user id
 * ("default" unless changed), both sent per request from the UI.
 */

export class ComposioActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposioActionError";
  }
}

const clients = new Map<string, Composio>();

export function getComposio(apiKey: string): Composio {
  let client = clients.get(apiKey);
  if (!client) {
    client = new Composio({ apiKey, allowTracking: false, disableVersionCheck: true });
    clients.set(apiKey, client);
  }
  return client;
}

/**
 * Toolkit versions the hand-built arguments below were checked against.
 * Composio requires an explicit version for manual execution; if one of these
 * is retired, the newest available version is used instead.
 */
const PINNED_TOOLKIT_VERSIONS: Record<string, string> = {
  gmail: "20261018_00",
  outlook: "20261021_00",
  serpapi: "20261014_01",
  dice_mcp: "20261018_00",
  googlesheets: "20261018_00",
};

const toolVersions = new Map<string, string>();

async function resolveToolVersion(
  composio: Composio,
  slug: string,
  toolkit: string,
): Promise<string> {
  const cached = toolVersions.get(slug);
  if (cached) return cached;
  const pinned = PINNED_TOOLKIT_VERSIONS[toolkit];
  let version = pinned;
  try {
    const tool = await composio.tools.getRawComposioToolBySlug(slug);
    const available = tool.availableVersions ?? [];
    if (!pinned || (available.length > 0 && !available.includes(pinned))) {
      version = tool.version ?? pinned;
    }
  } catch {
    // Metadata lookup failed — try the pinned version.
  }
  if (!version) throw new ComposioActionError(`No usable version found for ${slug}`);
  toolVersions.set(slug, version);
  return version;
}

export async function runAction(
  apiKey: string,
  slug: string,
  toolkit: string,
  options: { userId: string; connectedAccountId?: string; args: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const composio = getComposio(apiKey);
  const version = await resolveToolVersion(composio, slug, toolkit);
  const result = await composio.tools.execute(slug, {
    userId: options.userId,
    ...(options.connectedAccountId ? { connectedAccountId: options.connectedAccountId } : {}),
    arguments: options.args,
    version,
  });
  // Tool-level failures come back as successful: false, not as exceptions.
  if (!result.successful) {
    throw new ComposioActionError(String(result.error ?? `${slug} failed`));
  }
  const data = result.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** Read a field that may sit at the top level or one wrapper down. */
export function dig(data: Record<string, unknown>, key: string): unknown {
  if (data[key] !== undefined) return data[key];
  for (const wrapper of ["data", "response_data"]) {
    const inner = data[wrapper];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const value = (inner as Record<string, unknown>)[key];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];

// ---------- connections ----------

export interface ConnectionInfo {
  id: string;
  toolkitSlug: string;
  status: string;
  createdAt: string | null;
}

/** The user's connected accounts, newest first. */
export async function listConnections(
  apiKey: string,
  userId: string,
  toolkitSlugs?: string[],
): Promise<ConnectionInfo[]> {
  const response = await getComposio(apiKey).connectedAccounts.list({
    userIds: [userId],
    ...(toolkitSlugs?.length ? { toolkitSlugs } : {}),
    limit: 100,
  });
  return (response.items ?? [])
    .map((item) => ({
      id: item.id,
      toolkitSlug: item.toolkit?.slug ?? "",
      status: item.status,
      createdAt: item.createdAt ?? null,
    }))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** Newest ACTIVE connection, trying the toolkits in the given order. */
export async function findActiveConnection(
  apiKey: string,
  userId: string,
  toolkitSlugs: string[],
): Promise<ConnectionInfo | null> {
  const connections = await listConnections(apiKey, userId, toolkitSlugs);
  for (const slug of toolkitSlugs) {
    const match = connections.find((c) => c.toolkitSlug === slug && c.status === "ACTIVE");
    if (match) return match;
  }
  return null;
}

// Mailbox addresses never change; SerpAPI quota is refreshed every 5 minutes.
const accountLabels = new Map<string, { label: string; expiresAt: number }>();
const QUOTA_LABEL_TTL_MS = 5 * 60 * 1000;

/** Human label for a connection: the mailbox address, or SerpAPI quota. */
export async function describeConnection(
  apiKey: string,
  userId: string,
  connection: ConnectionInfo,
): Promise<string | null> {
  if (connection.status !== "ACTIVE") return null;
  const cached = accountLabels.get(connection.id);
  if (cached && cached.expiresAt > Date.now()) return cached.label;
  const base = { userId, connectedAccountId: connection.id };
  try {
    let label: string | null = null;
    if (connection.toolkitSlug === "serpapi") {
      const data = await runAction(apiKey, "SERPAPI_GET_ACCOUNT", "serpapi", { ...base, args: {} });
      const left = dig(data, "total_searches_left") ?? dig(data, "plan_searches_left");
      label = typeof left === "number" ? `${left} searches left this month` : null;
      if (label) {
        accountLabels.set(connection.id, { label, expiresAt: Date.now() + QUOTA_LABEL_TTL_MS });
      }
      return label;
    }
    if (connection.toolkitSlug === "gmail") {
      const data = await runAction(apiKey, "GMAIL_GET_PROFILE", "gmail", {
        ...base,
        args: { user_id: "me" },
      });
      label = str(dig(data, "emailAddress"));
    } else if (connection.toolkitSlug === "outlook") {
      const data = await runAction(apiKey, "OUTLOOK_GET_PROFILE", "outlook", {
        ...base,
        args: { user_id: "me" },
      });
      label = str(dig(data, "mail")) ?? str(dig(data, "userPrincipalName"));
    }
    if (label) accountLabels.set(connection.id, { label, expiresAt: Number.POSITIVE_INFINITY });
    return label;
  } catch {
    return null;
  }
}

/** An enabled auth config for the toolkit — created when the project has none. */
async function ensureAuthConfig(
  composio: Composio,
  toolkitSlug: string,
  scheme: "oauth" | "api_key",
): Promise<string> {
  const { items } = await composio.authConfigs.list({ toolkit: toolkitSlug });
  const usable = (items ?? []).filter((config) => config.status !== "DISABLED");
  const match =
    scheme === "oauth"
      ? (usable.find((config) => config.isComposioManaged) ??
        usable.find((config) => config.authScheme === "OAUTH2"))
      : usable.find((config) => config.authScheme === "API_KEY");
  if (match) return match.id;
  try {
    const created =
      scheme === "oauth"
        ? await composio.authConfigs.create(toolkitSlug, {
            type: "use_composio_managed_auth",
            name: `${toolkitSlug} (Outreach)`,
          })
        : await composio.authConfigs.create(toolkitSlug, {
            type: "use_custom_auth",
            authScheme: "API_KEY",
            credentials: {},
            name: `${toolkitSlug} (Outreach)`,
          });
    return created.id;
  } catch (err) {
    throw new ComposioActionError(
      `Couldn't set up ${toolkitSlug} in your Composio project (${
        err instanceof Error ? err.message : "unknown error"
      }). Create an auth config for it at platform.composio.dev, then try again.`,
    );
  }
}

/**
 * OAuth connect (Gmail, Outlook): returns Composio's hosted sign-in link.
 * Uses connectedAccounts.link — the older initiate() flow is retired for
 * Composio-managed OAuth.
 */
export async function createConnectLink(
  apiKey: string,
  userId: string,
  toolkitSlug: string,
  callbackUrl: string,
): Promise<{ connectedAccountId: string; redirectUrl: string }> {
  const composio = getComposio(apiKey);
  const authConfigId = await ensureAuthConfig(composio, toolkitSlug, "oauth");
  const request = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl,
    // Lets the user add a second mailbox; the newest active one is used.
    allowMultiple: true,
  });
  if (!request.redirectUrl) {
    throw new ComposioActionError("Composio did not return a sign-in link.");
  }
  return { connectedAccountId: request.id, redirectUrl: request.redirectUrl };
}

/** API-key connect (SerpAPI): the key goes straight to Composio. */
export async function connectWithApiKey(
  apiKey: string,
  userId: string,
  toolkitSlug: string,
  secret: string,
): Promise<{ connectedAccountId: string; status: string }> {
  const composio = getComposio(apiKey);
  const authConfigId = await ensureAuthConfig(composio, toolkitSlug, "api_key");
  const toolkit = await composio.toolkits.get(toolkitSlug);
  const fieldName =
    toolkit.authConfigDetails?.find((detail) => detail.mode === "API_KEY")?.fields
      ?.connectedAccountInitiation?.required?.[0]?.name ?? "api_key";
  const request = await composio.connectedAccounts.initiate(userId, authConfigId, {
    config: AuthScheme.APIKey(
      fieldName === "generic_api_key" ? { generic_api_key: secret } : { api_key: secret },
    ),
    allowMultiple: true,
  });
  const account = await composio.connectedAccounts.get(request.id);
  return { connectedAccountId: request.id, status: account.status };
}

/** Remove one of this user's connections (never another user's). */
export async function disconnectConnection(
  apiKey: string,
  userId: string,
  connectedAccountId: string,
): Promise<void> {
  const owned = await listConnections(apiKey, userId);
  if (!owned.some((connection) => connection.id === connectedAccountId)) {
    throw new ComposioActionError("That connection doesn't belong to this profile.");
  }
  await getComposio(apiKey).connectedAccounts.delete(connectedAccountId);
  accountLabels.delete(connectedAccountId);
}

// ---------- email ----------

const MAIL_TOOLKITS = ["gmail", "outlook"];

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

async function requireMailbox(apiKey: string, userId: string): Promise<ConnectionInfo> {
  const mailbox = await findActiveConnection(apiKey, userId, MAIL_TOOLKITS);
  if (!mailbox) {
    throw new ComposioActionError(
      "No Gmail or Outlook account is connected. Open Connections (plug icon, top right) and connect Gmail.",
    );
  }
  return mailbox;
}

/** Send from the user's connected mailbox (Gmail preferred over Outlook). */
export async function sendEmail(
  apiKey: string,
  userId: string,
  email: OutgoingEmail,
): Promise<{ toolkit: string; from: string | null; messageId: string | null }> {
  const mailbox = await requireMailbox(apiKey, userId);
  const base = { userId, connectedAccountId: mailbox.id };
  const cc = email.cc?.filter(Boolean) ?? [];
  const bcc = email.bcc?.filter(Boolean) ?? [];
  const data =
    mailbox.toolkitSlug === "outlook"
      ? await runAction(apiKey, "OUTLOOK_SEND_EMAIL", "outlook", {
          ...base,
          args: {
            to: email.to,
            subject: email.subject,
            body: email.body,
            is_html: false,
            save_to_sent_items: true,
            ...(cc.length ? { cc_emails: cc } : {}),
            ...(bcc.length ? { bcc_emails: bcc } : {}),
          },
        })
      : await runAction(apiKey, "GMAIL_SEND_EMAIL", "gmail", {
          ...base,
          args: {
            recipient_email: email.to,
            subject: email.subject,
            body: email.body,
            is_html: false,
            user_id: "me",
            ...(cc.length ? { cc } : {}),
            ...(bcc.length ? { bcc } : {}),
          },
        });
  return {
    toolkit: mailbox.toolkitSlug,
    from: await describeConnection(apiKey, userId, mailbox),
    messageId: str(dig(data, "id")),
  };
}

/** Save a draft in the user's mailbox instead of sending. */
export async function createDraft(
  apiKey: string,
  userId: string,
  email: OutgoingEmail,
): Promise<{ toolkit: string; from: string | null; draftId: string | null }> {
  const mailbox = await requireMailbox(apiKey, userId);
  const base = { userId, connectedAccountId: mailbox.id };
  const cc = email.cc?.filter(Boolean) ?? [];
  const bcc = email.bcc?.filter(Boolean) ?? [];
  const data =
    mailbox.toolkitSlug === "outlook"
      ? await runAction(apiKey, "OUTLOOK_CREATE_DRAFT", "outlook", {
          ...base,
          args: {
            subject: email.subject,
            body: email.body,
            is_html: false,
            to_recipients: [email.to],
            ...(cc.length ? { cc_recipients: cc } : {}),
            ...(bcc.length ? { bcc_recipients: bcc } : {}),
          },
        })
      : await runAction(apiKey, "GMAIL_CREATE_EMAIL_DRAFT", "gmail", {
          ...base,
          args: {
            recipient_email: email.to,
            subject: email.subject,
            body: email.body,
            is_html: false,
            user_id: "me",
            ...(cc.length ? { cc } : {}),
            ...(bcc.length ? { bcc } : {}),
          },
        });
  return {
    toolkit: mailbox.toolkitSlug,
    from: await describeConnection(apiKey, userId, mailbox),
    draftId: str(dig(data, "id")),
  };
}

// ---------- job search ----------

export interface JobPosting {
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean | null;
  posted: string | null;
  salary: string | null;
  employmentType: string | null;
  /** "Direct Hire" / "Recruiter" (Dice) or "via LinkedIn" (Google Jobs). */
  postedBy: string | null;
  url: string | null;
  /** The employer's own application link (an ATS or careers page), not a job board. */
  applyUrl: string | null;
  /** Company website guessed from a non-job-board apply link. */
  companyDomain: string | null;
  summary: string | null;
}

export interface JobSearchInput {
  query: string;
  location?: string;
  remoteOnly?: boolean;
  postedWithinDays?: number;
  limit?: number;
}

export interface JobSearchResult {
  source: "google_jobs" | "dice";
  jobs: JobPosting[];
  note: string;
}

// Hosts that are job boards / ATSs, not the employer's own site.
const JOB_BOARD_HOST =
  /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|monster|naukri|dice|simplyhired|wellfound|angel|builtin|lever|greenhouse|ashbyhq|workable|smartrecruiters|myworkdayjobs|workday|icims|jobvite|google|bebee|jooble|careerbuilder|foundit|instahyre|cutshort|iimjobs|shine|timesjobs|hirist|adzuna|talent|jobleads|upwork)\./i;

// Boards that only re-post jobs; ATS hosts (Greenhouse, Lever…) are where applying happens.
const REPOST_BOARD_HOST =
  /(^|\.)(linkedin|indeed|glassdoor|ziprecruiter|monster|naukri|dice|simplyhired|wellfound|angel|builtin|bebee|jooble|careerbuilder|foundit|instahyre|cutshort|iimjobs|shine|timesjobs|hirist|adzuna|jobleads|upwork|google)\./i;

/** The first apply link that isn't a re-posting job board. */
function employerApplyLink(links: string[]): string | null {
  for (const link of links) {
    try {
      if (!REPOST_BOARD_HOST.test(new URL(link).hostname)) return link;
    } catch {
      // not a URL
    }
  }
  return null;
}

function employerDomain(links: string[]): string | null {
  for (const link of links) {
    try {
      const host = new URL(link).hostname.toLowerCase();
      if (!JOB_BOARD_HOST.test(host)) return host.replace(/^(www|careers|jobs)\./, "");
    } catch {
      // not a URL
    }
  }
  return null;
}

const clip = (value: unknown, max: number): string | null => {
  const text = str(value);
  return text ? (text.length > max ? `${text.slice(0, max)}…` : text) : null;
};

function fromGoogleJobs(row: Record<string, unknown>): JobPosting {
  const ext = (row.detected_extensions ?? {}) as Record<string, unknown>;
  const links = records(row.apply_options)
    .map((option) => str(option.link))
    .filter((link): link is string => Boolean(link));
  return {
    title: str(row.title) ?? "(untitled)",
    company: str(row.company_name),
    location: str(row.location),
    remote: typeof ext.work_from_home === "boolean" ? ext.work_from_home : null,
    posted: str(ext.posted_at),
    salary: str(ext.salary),
    employmentType: str(ext.schedule_type),
    postedBy: str(row.via),
    url: links[0] ?? str(row.share_link),
    applyUrl: employerApplyLink(links),
    companyDomain: employerDomain(links),
    summary: clip(row.description, 280),
  };
}

function fromDice(row: Record<string, unknown>): JobPosting {
  const location = (row.jobLocation ?? {}) as Record<string, unknown>;
  const workplace = Array.isArray(row.workplaceTypes) ? (row.workplaceTypes as unknown[]) : [];
  const url = str(row.detailsPageUrl);
  return {
    title: str(row.title) ?? "(untitled)",
    company: str(row.companyName),
    location: str(location.displayName) ?? (row.isRemote ? "Remote" : null),
    remote:
      typeof row.isRemote === "boolean" ? row.isRemote || workplace.includes("Remote") : null,
    posted: str(row.postedDate)?.slice(0, 10) ?? null,
    salary: str(row.salary),
    employmentType: str(row.employmentType),
    postedBy: str(row.employerType),
    url: url ? url.split("?")[0] : null,
    applyUrl: null,
    companyDomain: null,
    summary: clip(row.summary, 280),
  };
}

/** "3 days ago" / "5 hours ago" -> age in days (null when unknown). */
function ageInDays(posted: string | null): number | null {
  const match = posted?.match(/(\d+)\s*(minute|hour|day|week|month)/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "minute" || unit === "hour") return 0;
  if (unit === "day") return amount;
  if (unit === "week") return amount * 7;
  return amount * 30;
}

/** Job listings: Google Jobs (SerpAPI) when connected, otherwise Dice. */
export async function searchJobs(
  apiKey: string,
  userId: string,
  input: JobSearchInput,
): Promise<JobSearchResult> {
  const limit = Math.min(Math.max(Math.round(input.limit ?? 8), 1), 20);
  const days = input.postedWithinDays && input.postedWithinDays > 0 ? input.postedWithinDays : null;

  const serp = await findActiveConnection(apiKey, userId, ["serpapi"]).catch(() => null);
  if (serp) {
    const data = await runAction(apiKey, "SERPAPI_GOOGLE_JOBS_SEARCH", "serpapi", {
      userId,
      connectedAccountId: serp.id,
      args: {
        q: input.query,
        ...(input.location ? { location: input.location } : {}),
        ...(input.remoteOnly ? { ltype: 1 } : {}),
      },
    });
    let jobs = records(dig(data, "jobs_results")).map(fromGoogleJobs);
    if (days !== null) {
      jobs = jobs.filter((job) => {
        const age = ageInDays(job.posted);
        return age === null || age <= days;
      });
    }
    return {
      source: "google_jobs",
      jobs: jobs.slice(0, limit),
      note: "Google Jobs results via SerpAPI. Verify details on the posting before applying.",
    };
  }

  const postedDate = days === null ? null : days <= 1 ? "ONE" : days <= 3 ? "THREE" : days <= 7 ? "SEVEN" : null;
  const data = await runAction(apiKey, "DICE_MCP_SEARCH_JOBS", "dice_mcp", {
    userId,
    args: {
      keyword: input.query,
      jobs_per_page: limit,
      ...(input.location ? { location: input.location } : {}),
      ...(input.remoteOnly ? { workplace_types: ["Remote"] } : {}),
      ...(postedDate ? { posted_date: postedDate, sort: "datePosted" } : {}),
    },
  });
  return {
    source: "dice",
    jobs: records(dig(data, "data")).map(fromDice).slice(0, limit),
    note:
      "Dice listings (mostly US tech roles), found with AI-assisted search — verify details with the employer before applying. For worldwide Google Jobs results, connect SerpAPI in Connections.",
  };
}
