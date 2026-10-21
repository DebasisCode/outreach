import {
  addMemory,
  allKnowledge,
  deleteMemory,
  findKnownEmail,
  findMemory,
  ftsSearchKnowledge,
  getContactByEmail,
  markJobEmailed,
  recordEmail,
  saveJob,
  searchContacts,
  updateMemory,
  upsertContact,
} from "@/lib/db";
import {
  checkEnrichment,
  cleanlistFailureMessage,
  DEPARTMENTS,
  enrichPerson,
  findInRecentSearches,
  normalizeDomain,
  searchPeople,
  SENIORITY_LEVELS,
  type EnrichOutcome,
} from "@/lib/cleanlist";
import { createDraft, searchJobs, sendEmail, type JobPosting } from "@/lib/composio";
import { getEmbedClient } from "@/lib/embeddings";
import {
  jobForEmail,
  recentPosting,
  rememberPostings,
  requestTrackerSync,
  trackerReport,
} from "@/lib/tracker";
import type {
  ContactsLookupOutput,
  EmailToolOutput,
  EnrichOutput,
  FindJobsOutput,
  FindPeopleOutput,
  JobResult,
  MemoryToolOutput,
  SaveJobOutput,
  TrackerFields,
} from "@/lib/tool-outputs";
import { jsonSchema, type ToolSet } from "ai";
import { JOB_STATUSES, type UserKeys } from "@/lib/types";

/**
 * The tools the model can call, built per request from the user's own keys:
 *  - find_jobs                   job listings via Composio (Google Jobs or Dice)
 *  - cleanlist_find_people       free people search at a company
 *  - cleanlist_enrich_person     1 credit -> work email (skips known emails)
 *  - cleanlist_check_enrichment  finish an enrichment that was still running
 *  - composio_send_email         send from the user's Gmail/Outlook; the chat
 *                                route makes this wait for the user's click
 *  - composio_create_draft       save to the user's drafts instead
 *  - tracker_save_job            save a job / its status to the tracker
 *  - memory_save / memory_forget facts about the user, always in context
 *  - knowledge_search / contacts_lookup / save_contact   local memory
 *
 * Found contacts, saved jobs and sent emails are also copied to the user's
 * Google Sheet tracker when Google Sheets is connected (tracker.ts).
 */

export const SEND_EMAIL_TOOL = "composio_send_email";
export const CREATE_DRAFT_TOOL = "composio_create_draft";
/** Tools that touch the user's mailbox — each waits for the user's click. */
export const APPROVAL_TOOLS = [SEND_EMAIL_TOOL, CREATE_DRAFT_TOOL] as const;

const LEAD_LIST_NAME = "Job Outreach Assistant";
const EMAIL_PATTERN = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/;
// CleanList marks deliverable addresses "verified" (some providers say "valid").
const GOOD_EMAIL_STATUSES = new Set(["verified", "valid", "deliverable"]);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Compacted<T> = { [K in keyof T]?: Exclude<T[K], null | undefined> };

/** Drop null/undefined/empty values so tool results stay small. */
function compact<T extends Record<string, unknown>>(record: T): Compacted<T> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== null && value !== undefined && value !== "",
    ),
  ) as Compacted<T>;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const KnowledgeSearchSchema = jsonSchema<{ query: string; limit?: number }>({
  type: "object",
  properties: {
    query: { type: "string", description: "What to look up" },
    limit: { type: "integer", default: 6 },
  },
  required: ["query"],
});

const ContactsLookupSchema = jsonSchema<{ query: string }>({
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "e.g. 'stripe recruiter', 'vercel.com' or 'jane@acme.com'",
    },
  },
  required: ["query"],
});

const SaveContactSchema = jsonSchema<{
  name: string;
  email?: string;
  email_status?: string;
  title?: string;
  company?: string;
  domain?: string;
  linkedin_url?: string;
}>({
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
    email_status: { type: "string" },
    title: { type: "string" },
    company: { type: "string" },
    domain: { type: "string" },
    linkedin_url: { type: "string" },
  },
  required: ["name"],
});

const FindJobsSchema = jsonSchema<{
  query: string;
  location?: string;
  remote_only?: boolean;
  posted_within_days?: number;
  limit?: number;
}>({
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Role keywords, e.g. 'backend engineer' or 'data analyst python'",
    },
    location: {
      type: "string",
      description: "City, region or country, e.g. 'Bangalore, India' or 'New York'",
    },
    remote_only: { type: "boolean", description: "Only remote roles" },
    posted_within_days: {
      type: "integer",
      description: "Only postings from the last N days, e.g. 7",
    },
    limit: { type: "integer", description: "Max jobs (default 8, max 20)" },
  },
  required: ["query"],
});

const FindPeopleSchema = jsonSchema<{
  domain?: string;
  company_name?: string;
  departments?: string[];
  seniority?: string[];
  title_keywords?: string[];
  country?: string;
  limit?: number;
}>({
  type: "object",
  properties: {
    domain: {
      type: "string",
      description: "Company website domain, e.g. stripe.com (most reliable)",
    },
    company_name: {
      type: "string",
      description: "Company name — use only when the domain is unknown",
    },
    departments: {
      type: "array",
      items: { type: "string", enum: [...DEPARTMENTS] },
      description: "Recruiters and HR are in 'People & HR'",
    },
    seniority: {
      type: "array",
      items: { type: "string", enum: [...SENIORITY_LEVELS] },
    },
    title_keywords: {
      type: "array",
      items: { type: "string" },
      description:
        "Words to look for in job titles (case-insensitive), e.g. ['recruit', 'talent'] or ['engineering manager']",
    },
    country: {
      type: "string",
      description: "Only people based in this country, e.g. 'India'",
    },
    limit: { type: "integer", description: "Max people to return (default 15)" },
  },
});

const EnrichPersonSchema = jsonSchema<{
  linkedin_url?: string;
  first_name?: string;
  last_name?: string;
  domain?: string;
  company_name?: string;
  title?: string;
}>({
  type: "object",
  properties: {
    linkedin_url: {
      type: "string",
      description: "Best identifier — copy it from cleanlist_find_people",
    },
    first_name: { type: "string" },
    last_name: { type: "string" },
    domain: { type: "string", description: "Company domain, e.g. stripe.com" },
    company_name: { type: "string" },
    title: { type: "string", description: "Their job title, saved with the contact" },
  },
});

const CheckEnrichmentSchema = jsonSchema<{ workflow_id: string }>({
  type: "object",
  properties: {
    workflow_id: {
      type: "string",
      description: "workflow_id returned by cleanlist_enrich_person",
    },
  },
  required: ["workflow_id"],
});

const EMAIL_PROPERTIES = {
  to: { type: "string", description: "Recipient email address" },
  subject: { type: "string" },
  body: { type: "string", description: "Plain-text body, including the sign-off" },
} as const;

const DraftEmailSchema = jsonSchema<{ to: string; subject: string; body: string }>({
  type: "object",
  properties: EMAIL_PROPERTIES,
  required: ["to", "subject", "body"],
});

const SendEmailSchema = jsonSchema<{
  to: string;
  subject: string;
  body: string;
  job_title?: string;
  job_url?: string;
}>({
  type: "object",
  properties: {
    ...EMAIL_PROPERTIES,
    job_title: {
      type: "string",
      description:
        "The role this email is about, e.g. 'Senior Backend Engineer' — the tracker logs the email with that job",
    },
    job_url: { type: "string", description: "Link to that job posting, if known" },
  },
  required: ["to", "subject", "body"],
});

const SaveJobSchema = jsonSchema<{
  title: string;
  company: string;
  url?: string;
  location?: string;
  status?: string;
}>({
  type: "object",
  properties: {
    title: { type: "string", description: "Job title" },
    company: { type: "string" },
    url: { type: "string", description: "Link to the posting, if known" },
    location: { type: "string" },
    status: {
      type: "string",
      enum: [...JOB_STATUSES],
      description:
        "Where the user is with this job, e.g. 'Applied' when they say they applied. Leave out to keep the current status (new jobs start as 'Saved').",
    },
  },
  required: ["title", "company"],
});

const MemorySaveSchema = jsonSchema<{ fact: string; replaces?: string }>({
  type: "object",
  properties: {
    fact: {
      type: "string",
      description:
        "One short, lasting fact about the user, e.g. 'Targets senior backend roles in Bangalore or remote' or 'Signs emails as Debasis'",
    },
    replaces: {
      type: "string",
      description: "Id of an outdated memory item this fact replaces, e.g. 'a1b2c3'",
    },
  },
  required: ["fact"],
});

const MemoryForgetSchema = jsonSchema<{ id: string }>({
  type: "object",
  properties: { id: { type: "string", description: "Id of the memory item, e.g. 'a1b2c3'" } },
  required: ["id"],
});

/** "applied" -> "Applied"; anything else -> null. */
function jobStatus(value: string | undefined): string | null {
  const wanted = value?.trim().toLowerCase();
  return JOB_STATUSES.find((status) => status.toLowerCase() === wanted) ?? null;
}

function describeJob(job: JobPosting): JobResult {
  return compact({
    title: job.title,
    company: job.company,
    company_domain: job.companyDomain,
    location: job.location,
    remote: job.remote === true ? true : null,
    posted: job.posted,
    salary: job.salary,
    type: job.employmentType,
    posted_by: job.postedBy,
    url: job.url,
    summary: job.summary,
  });
}

/**
 * Turn an enrichment outcome into the tool result. Found contacts are saved
 * and logged to the tracker.
 */
async function reportEnrichment(
  outcome: EnrichOutcome,
  logToTracker: (budgetMs: number) => Promise<TrackerFields>,
  hints: { title?: string; domain?: string; companyName?: string } = {},
): Promise<EnrichOutput> {
  if (outcome.kind === "pending") {
    return {
      found: false,
      pending: true,
      workflow_id: outcome.workflowId,
      note: "CleanList is still working on this. Call cleanlist_check_enrichment with this workflow_id in a minute — don't enrich again.",
    };
  }
  if (outcome.kind === "not_found") return { found: false, note: outcome.reason };

  const person = outcome.person;
  // Enrichment often omits the title; the search that found them has it.
  const searched = findInRecentSearches(person.linkedinUrl);
  const name =
    person.fullName ?? [person.firstName, person.lastName].filter(Boolean).join(" ");
  const title = person.title ?? hints.title ?? searched?.title ?? null;
  const company = person.company ?? hints.companyName ?? searched?.company ?? null;
  upsertContact({
    name,
    email: person.email,
    emailStatus: person.emailStatus,
    title,
    company,
    domain:
      person.domain ??
      hints.domain ??
      searched?.domain ??
      person.email.split("@")[1]?.toLowerCase() ??
      null,
    linkedinUrl: person.linkedinUrl ?? null,
  });
  const tracker = await logToTracker(4000);
  return compact({
    found: true,
    email: person.email,
    email_status: person.emailStatus,
    full_name: name,
    title,
    company,
    linkedin_url: person.linkedinUrl,
    credits_charged: outcome.creditsCharged,
    warning:
      person.emailStatus && !GOOD_EMAIL_STATUSES.has(person.emailStatus.toLowerCase())
        ? `Email status is "${person.emailStatus}" — it may bounce.`
        : null,
    ...tracker,
  });
}

export function buildTools(keys: UserKeys): { tools: ToolSet; enabled: string[] } {
  const tools: ToolSet = {};
  const enabled: string[] = [
    "knowledge_search",
    "contacts_lookup",
    "save_contact",
    "tracker_save_job",
    "memory_save",
    "memory_forget",
  ];
  const composioUserId = keys.composioUserId?.trim() || "default";
  const composioKey = keys.composioApiKey?.trim() ?? "";

  // Copy new rows to the Google Sheet tracker (when connected) and report how
  // that went, waiting at most budgetMs; a slower sync finishes in the background.
  const logToTracker = (budgetMs: number): Promise<TrackerFields> =>
    composioKey
      ? trackerReport(requestTrackerSync(composioKey, composioUserId), budgetMs)
      : Promise.resolve({});

  tools.knowledge_search = {
    description:
      "Search the user's knowledge base (resume, job descriptions, notes). Check it before drafting outreach so the email is specific.",
    inputSchema: KnowledgeSearchSchema,
    execute: async (input) => {
      try {
        const embed = getEmbedClient(keys);
        let results: Array<{ title: string | null; content: string; score: number }>;
        if (embed) {
          const [queryVec] = await embed.embed([input.query]);
          const scored = allKnowledge()
            .filter((c) => c.embedding?.length === queryVec.length)
            .map((c) => ({
              chunk: c,
              score: cosine(queryVec, c.embedding as number[]),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, input.limit ?? 6);
          results = scored.map((s) => ({
            title: s.chunk.title,
            content: s.chunk.content,
            score: Number(s.score.toFixed(4)),
          }));
        } else {
          const fallback = ftsSearchKnowledge(input.query, input.limit ?? 6);
          results = fallback.map((c) => ({
            title: c.title,
            content: c.content,
            score: 0,
          }));
        }
        if (results.length === 0) return "No matching knowledge found.";
        return results
          .map((r, i) => `[${i + 1}] ${r.title ?? "(untitled)"} (${r.score})\n${r.content}`)
          .join("\n\n");
      } catch (err) {
        return `Knowledge search failed: ${errorMessage(err)}`;
      }
    },
  };

  tools.contacts_lookup = {
    description:
      "Search people already found or enriched (name, company, domain, title, email). Use before enriching — the email may already be known — and to see who was already emailed.",
    inputSchema: ContactsLookupSchema,
    execute: async (input) => {
      const result: ContactsLookupOutput = {
        contacts: searchContacts(input.query, 15).map((r) =>
          compact({
            name: r.name,
            email: r.email,
            email_status: r.emailStatus,
            title: r.title,
            company: r.company,
            domain: r.domain,
            linkedin_url: r.linkedinUrl,
            last_emailed: r.lastEmailedAt ? day(r.lastEmailedAt) : null,
          }),
        ),
      };
      return JSON.stringify(result);
    },
  };

  tools.save_contact = {
    description:
      "Remember a person (name/title/company + email or LinkedIn URL). Enriched people are saved automatically.",
    inputSchema: SaveContactSchema,
    execute: async (input) => {
      const saved = upsertContact({
        name: input.name,
        email: input.email || null,
        emailStatus: input.email_status || null,
        title: input.title || null,
        company: input.company || null,
        domain: input.domain ? normalizeDomain(input.domain) : null,
        linkedinUrl: input.linkedin_url || null,
        source: "manual",
      });
      if (saved?.email && composioKey) void requestTrackerSync(composioKey, composioUserId);
      return saved
        ? `Saved contact ${saved.name} (${saved.email ?? "no email"}).`
        : "Could not save — need an email or a LinkedIn URL.";
    },
  };

  tools.memory_save = {
    description:
      "Remember a lasting fact about the user for future chats: background, skills, target roles and locations, preferences for emails (tone, length, sign-off), constraints. One short fact per call. Pass replaces=<id> to update an outdated item from Memory. Not for one-off task details, secrets, or contacts/jobs (those are stored already).",
    inputSchema: MemorySaveSchema,
    execute: async (input) => {
      try {
        const outdated = input.replaces ? findMemory(input.replaces) : null;
        if (outdated) {
          const updated = updateMemory(outdated.id, input.fact);
          const output: MemoryToolOutput = compact({
            saved: true,
            id: updated?.id,
            fact: updated?.content,
            replaced: outdated.content,
          });
          return JSON.stringify(output);
        }
        const memory = addMemory(input.fact, "assistant");
        const output: MemoryToolOutput = { saved: true, id: memory.id, fact: memory.content };
        return JSON.stringify(output);
      } catch (err) {
        const failed: MemoryToolOutput = { error: errorMessage(err) };
        return JSON.stringify(failed);
      }
    },
  };

  tools.memory_forget = {
    description: "Forget a memory item the user says is wrong or no longer true.",
    inputSchema: MemoryForgetSchema,
    execute: async (input) => {
      const memory = findMemory(input.id);
      const output: MemoryToolOutput =
        memory && deleteMemory(memory.id)
          ? { forgotten: true, id: memory.id, fact: memory.content }
          : { error: `No memory item "${input.id}".` };
      return JSON.stringify(output);
    },
  };

  tools.tracker_save_job = {
    description:
      "Save a job to the user's application tracker (their Google Sheet, once Google Sheets is connected), or update its status. Use when the user asks to save or track a job, or says they applied, interviewed, got an offer or were rejected somewhere. The Save and Find recruiter buttons on job cards already save the job — don't call this for those.",
    inputSchema: SaveJobSchema,
    execute: async (input) => {
      const title = input.title?.trim();
      const company = input.company?.trim();
      if (!title || !company) {
        const missing: SaveJobOutput = { error: "Pass the job title and the company." };
        return JSON.stringify(missing);
      }
      const url = input.url?.trim() || null;
      const fromSearch = url ? recentPosting(url) : null;
      const { job } = saveJob({
        ...fromSearch,
        title,
        company,
        url,
        location: input.location?.trim() || fromSearch?.location || null,
        source: fromSearch?.source ?? "Manual",
        status: jobStatus(input.status),
      });
      const output: SaveJobOutput = compact({
        saved: true,
        title: job.title,
        company: job.company,
        status: job.status,
        url: job.url,
        ...(await logToTracker(5000)),
      });
      return JSON.stringify(output);
    },
  };

  if (keys.cleanlistApiKey) {
    enabled.push(
      "cleanlist_find_people",
      "cleanlist_enrich_person",
      "cleanlist_check_enrichment",
    );

    tools.cleanlist_find_people = {
      description:
        "FREE (but capped at ~60 searches/day). Find people who work at one company, by website domain (preferred) or name. Returns name, title, location and linkedin_url. For recruiters use departments ['People & HR'] + title_keywords ['recruit','talent']; for hiring managers use the team's department + seniority ['Manager','Director','Head'].",
      inputSchema: FindPeopleSchema,
      execute: async (input) => {
        if (!input.domain?.trim() && !input.company_name?.trim()) {
          return JSON.stringify({ error: "Pass the company domain (e.g. stripe.com) or company_name." });
        }
        try {
          const result = await searchPeople(keys.cleanlistApiKey, {
            domain: input.domain,
            companyName: input.company_name,
            departments: input.departments,
            seniority: input.seniority,
            titleKeywords: input.title_keywords,
            country: input.country,
            limit: input.limit,
          });
          const notes: string[] = [];
          if (result.ignoredFilters.length) {
            notes.push(`Ignored unsupported filter values: ${result.ignoredFilters.join(", ")}.`);
          }
          if (result.keywordFallback) {
            notes.push(
              `No titles contained ${(input.title_keywords ?? []).join(" / ")}; showing other people from the same search instead.`,
            );
          }
          if (result.people.length === 0) {
            notes.push(
              result.domain
                ? `Nobody at ${result.domain} matched these filters — try fewer filters or check the domain.`
                : "Nobody matched — the company's name may be listed differently; try its website domain.",
            );
          }
          const output: FindPeopleOutput = compact({
            company_domain: result.domain,
            total_matches: result.total,
            people: result.people.map((person) => {
              // Emails we already paid for show up without another credit.
              const known = findKnownEmail({ linkedinUrl: person.linkedinUrl });
              return compact({
                name: person.fullName,
                first_name: person.firstName,
                last_name: person.lastName,
                title: person.title,
                seniority: person.seniority,
                location: person.location,
                company: person.company,
                domain: person.domain,
                linkedin_url: person.linkedinUrl,
                email: known?.email,
                email_status: known?.emailStatus,
              });
            }),
            note: notes.join(" ") || null,
          });
          return JSON.stringify(output);
        } catch (err) {
          return JSON.stringify({ error: cleanlistFailureMessage(err) });
        }
      },
    };

    tools.cleanlist_enrich_person = {
      description:
        "COSTS 1 CLEANLIST CREDIT (only charged when an email is found). Get one person's work email. Pass linkedin_url from cleanlist_find_people (best), or first_name + last_name + domain. Emails already in contacts are returned for free.",
      inputSchema: EnrichPersonSchema,
      execute: async (input) => {
        const domain = input.domain ? normalizeDomain(input.domain) : undefined;
        const known = findKnownEmail({
          linkedinUrl: input.linkedin_url,
          firstName: input.first_name,
          lastName: input.last_name,
          domain,
        });
        if (known?.email) {
          const cached: EnrichOutput = compact({
            found: true,
            cached: true,
            email: known.email,
            email_status: known.emailStatus,
            full_name: known.name,
            title: known.title,
            company: known.company,
            linkedin_url: known.linkedinUrl,
            note: `Already in contacts — no credit spent.${
              known.lastEmailedAt ? ` You already emailed them on ${day(known.lastEmailedAt)}.` : ""
            }`,
          });
          return JSON.stringify(cached);
        }
        try {
          const outcome = await enrichPerson(keys.cleanlistApiKey, {
            listName: LEAD_LIST_NAME,
            linkedinUrl: input.linkedin_url,
            firstName: input.first_name,
            lastName: input.last_name,
            domain,
            companyName: input.company_name,
          });
          return JSON.stringify(
            await reportEnrichment(outcome, logToTracker, {
              title: input.title,
              domain,
              companyName: input.company_name,
            }),
          );
        } catch (err) {
          return JSON.stringify({ error: cleanlistFailureMessage(err) });
        }
      },
    };

    tools.cleanlist_check_enrichment = {
      description:
        "Free. Check an enrichment that cleanlist_enrich_person reported as pending.",
      inputSchema: CheckEnrichmentSchema,
      execute: async (input) => {
        try {
          const outcome = await checkEnrichment(keys.cleanlistApiKey, input.workflow_id);
          return JSON.stringify(await reportEnrichment(outcome, logToTracker));
        } catch (err) {
          return JSON.stringify({ error: cleanlistFailureMessage(err) });
        }
      },
    };
  }

  if (keys.composioApiKey) {
    enabled.push("find_jobs", SEND_EMAIL_TOOL, CREATE_DRAFT_TOOL);

    tools.find_jobs = {
      description:
        "Search open job postings by role keywords and location (via Composio: Google Jobs when SerpAPI is connected, otherwise Dice — mostly US tech). Can take ~20 seconds.",
      inputSchema: FindJobsSchema,
      execute: async (input) => {
        try {
          const result = await searchJobs(keys.composioApiKey, composioUserId, {
            query: input.query,
            location: input.location,
            remoteOnly: input.remote_only,
            postedWithinDays: input.posted_within_days,
            limit: input.limit,
          });
          rememberPostings(result.source, result.jobs);
          const output: FindJobsOutput = {
            source: result.source,
            note:
              result.jobs.length === 0
                ? `No listings matched. Try broader keywords or another location. ${result.note}`
                : result.note,
            jobs: result.jobs.map(describeJob),
          };
          return JSON.stringify(output);
        } catch (err) {
          return JSON.stringify({ error: `Job search failed: ${errorMessage(err)}` });
        }
      },
    };

    tools[SEND_EMAIL_TOOL] = {
      description:
        "Send an email from the user's connected Gmail (or Outlook). The app shows the user this exact email with Send / Don't send buttons; it goes out only if they click Send. Pass job_title (and job_url if known) when the email is about a specific role.",
      inputSchema: SendEmailSchema,
      execute: async (input) => {
        const to = input.to.trim();
        if (!EMAIL_PATTERN.test(to)) {
          const invalid: EmailToolOutput = { sent: false, error: `"${input.to}" is not a valid email address.` };
          return JSON.stringify(invalid);
        }
        let sent: Awaited<ReturnType<typeof sendEmail>>;
        try {
          sent = await sendEmail(keys.composioApiKey, composioUserId, {
            to,
            subject: input.subject,
            body: input.body,
          });
        } catch (err) {
          const failed: EmailToolOutput = { sent: false, error: errorMessage(err) };
          return JSON.stringify(failed);
        }
        // The email is out. Bookkeeping below must never turn that into "not sent".
        let tracker: TrackerFields = {};
        try {
          const job = jobForEmail({
            jobUrl: input.job_url,
            jobTitle: input.job_title,
            toEmail: to,
            contact: getContactByEmail(to),
          });
          recordEmail({
            toEmail: to,
            subject: input.subject,
            body: input.body,
            toolkit: sent.toolkit,
            fromAddress: sent.from,
            jobId: job?.id ?? null,
          });
          if (job) markJobEmailed(job.id);
          tracker = await logToTracker(6000);
        } catch (err) {
          console.error("Sent, but logging the email failed:", err);
        }
        const output: EmailToolOutput = compact({
          sent: true,
          to,
          from: sent.from ?? `your ${sent.toolkit}`,
          via: sent.toolkit,
          ...tracker,
        });
        return JSON.stringify(output);
      },
    };

    tools[CREATE_DRAFT_TOOL] = {
      description:
        "Save the email as a draft in the user's connected Gmail (or Outlook), only when they ask for a draft. The app shows it with Save / Don't save buttons. Nothing is sent.",
      inputSchema: DraftEmailSchema,
      execute: async (input) => {
        const to = input.to.trim();
        if (!EMAIL_PATTERN.test(to)) {
          const invalid: EmailToolOutput = { drafted: false, error: `"${input.to}" is not a valid email address.` };
          return JSON.stringify(invalid);
        }
        try {
          const draft = await createDraft(keys.composioApiKey, composioUserId, {
            to,
            subject: input.subject,
            body: input.body,
          });
          const output: EmailToolOutput = compact({
            drafted: true,
            to,
            mailbox: draft.from ?? draft.toolkit,
            via: draft.toolkit,
            note: `Saved in ${draft.toolkit === "outlook" ? "Outlook" : "Gmail"} drafts — not sent.`,
          });
          return JSON.stringify(output);
        } catch (err) {
          const failed: EmailToolOutput = { drafted: false, error: errorMessage(err) };
          return JSON.stringify(failed);
        }
      },
    };
  }

  return { tools, enabled };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
