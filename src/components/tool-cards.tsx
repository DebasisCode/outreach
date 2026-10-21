"use client";

import { TrackerNote } from "@/components/tracker-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  jobKeys,
  linkedinKey,
  parseToolOutput,
  type ContactResult,
  type ContactsLookupOutput,
  type EnrichOutput,
  type FindJobsOutput,
  type FindPeopleOutput,
  type JobResult,
  type MemoryToolOutput,
  type PersonResult,
  type SaveJobOutput,
} from "@/lib/tool-outputs";
import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import {
  BookmarkCheckIcon,
  BookmarkPlusIcon,
  BrainIcon,
  BriefcaseBusinessIcon,
  CheckCircle2Icon,
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MailCheckIcon,
  MailIcon,
  MapPinIcon,
  RefreshCwIcon,
  UserSearchIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Chat cards for tool results — people, jobs, found emails, saved contacts —
 * instead of raw JSON. Their buttons send a plain chat message as the user
 * (e.g. "Get the work email for …"), so the assistant sees every step. The
 * one exception is Save on a job, which goes straight to the tracker.
 */

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

export interface KnownEmail {
  email: string;
  status?: string;
}

export interface CardContext {
  /** Send a chat message as the user — what every card button does. */
  onAction: (text: string) => void;
  /** True while the assistant is working; buttons wait. */
  disabled: boolean;
  /** Emails found earlier in this chat, keyed by LinkedIn profile. */
  knownEmails: Map<string, KnownEmail>;
  /** Tracker status of a saved job ("Saved", "Emailed", …); undefined if not saved. */
  jobStatus: (job: JobResult) => string | undefined;
  /** Save a job to the tracker. Find recruiter saves the job too. */
  onSaveJob: (job: JobResult, source?: string) => Promise<void>;
  /** Google Sheets is connected, so saved jobs land in the sheet. */
  trackerConnected: boolean;
  /** Undo a memory the assistant just saved. */
  onForgetMemory: (id: string) => Promise<void>;
}

const ENRICH_TOOLS = new Set(["cleanlist_enrich_person", "cleanlist_check_enrichment"]);
const PEOPLE_PREVIEW = 6;
const JOBS_PREVIEW = 5;

// ---------- messages the buttons send ----------

function describePerson(person: { name?: string; title?: string; company?: string; linkedin_url?: string }) {
  const role = [person.title, person.company].filter(Boolean).join(", ");
  return `${person.name ?? "this person"}${role ? ` (${role})` : ""}${
    person.linkedin_url ? ` — ${person.linkedin_url}` : ""
  }`;
}

function enrichMessage(people: PersonResult[]): string {
  if (people.length === 1) return `Get the work email for ${describePerson(people[0])}`;
  return `Get the work emails for these ${people.length} people:\n${people
    .map((person) => `- ${describePerson(person)}`)
    .join("\n")}`;
}

function draftMessage(contact: { name?: string; title?: string; company?: string; email: string }) {
  const role = [contact.title, contact.company].filter(Boolean).join(", ");
  return `Write a short outreach email to ${contact.name ?? contact.email}${
    role ? ` (${role})` : ""
  } at ${contact.email}.`;
}

function findRecruiterMessage(job: JobResult) {
  const company = job.company_domain ? `${job.company} (${job.company_domain})` : job.company;
  return `Find the recruiter or hiring manager at ${company} for the "${job.title}" role${
    job.url ? ` — ${job.url}` : ""
  }.`;
}

/** Emails found by enrichment anywhere in this chat, by LinkedIn profile. */
export function collectKnownEmails(messages: UIMessage[]): Map<string, KnownEmail> {
  const known = new Map<string, KnownEmail>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part) || part.state !== "output-available") continue;
      if (!ENRICH_TOOLS.has(getToolName(part))) continue;
      const output = parseToolOutput<EnrichOutput>(part.output);
      const input = part.input as { linkedin_url?: string } | undefined;
      const key = linkedinKey(output?.linkedin_url ?? input?.linkedin_url);
      if (output?.found && output.email && key) {
        known.set(key, { email: output.email, status: output.email_status });
      }
    }
  }
  return known;
}

// ---------- building blocks ----------

function StatusLine({ state, children }: { state: "running" | "done" | "error"; children: ReactNode }) {
  return (
    <div className="not-prose text-muted-foreground mb-3 flex items-start gap-2 text-xs">
      {state === "running" ? (
        <LoaderCircleIcon className="mt-px size-3.5 shrink-0 animate-spin" />
      ) : state === "error" ? (
        <CircleAlertIcon className="text-destructive mt-px size-3.5 shrink-0" />
      ) : (
        <CheckCircle2Icon className="mt-px size-3.5 shrink-0 text-green-600" />
      )}
      <span className={state === "error" ? "text-destructive" : undefined}>{children}</span>
    </div>
  );
}

function CardShell({
  icon,
  title,
  meta,
  footer,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="not-prose bg-card mb-4 w-full overflow-hidden rounded-lg border">
      <div className="bg-muted/40 flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        {meta ? <div className="text-muted-foreground shrink-0 text-[11px]">{meta}</div> : null}
      </div>
      {children}
      {footer ? <div className="border-t px-3 py-2">{footer}</div> : null}
    </div>
  );
}

function ProfileLink({ href, children }: { href?: string; children: ReactNode }) {
  if (!href) return <span className="text-sm font-medium">{children}</span>;
  return (
    <a
      className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
      <ExternalLinkIcon className="size-3 opacity-50" />
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      aria-label="Copy email"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      size="icon-xs"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

const isGoodStatus = (status?: string) =>
  !!status && ["verified", "valid", "deliverable"].includes(status.toLowerCase());

function EmailStatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  return (
    <Badge className="rounded-full text-[10px]" variant={isGoodStatus(status) ? "secondary" : "outline"}>
      {status}
    </Badge>
  );
}

// ---------- cards ----------

function PeopleCard({
  output,
  input,
  ctx,
}: {
  output: FindPeopleOutput;
  input: { domain?: string; company_name?: string };
  ctx: CardContext;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);

  const people = output.people ?? [];
  const company =
    people[0]?.company ?? output.company_domain ?? input.domain ?? input.company_name ?? "the company";
  if (people.length === 0) {
    return <StatusLine state="done">{output.note ?? `No people found at ${company}.`}</StatusLine>;
  }

  const rows = people.map((person, index) => {
    const profileKey = linkedinKey(person.linkedin_url);
    const known: KnownEmail | undefined = person.email
      ? { email: person.email, status: person.email_status }
      : profileKey
        ? ctx.knownEmails.get(profileKey)
        : undefined;
    return { person, key: profileKey ?? `${person.name ?? "person"}-${index}`, known };
  });
  const visible = showAll ? rows : rows.slice(0, PEOPLE_PREVIEW);
  const chosen = rows.filter((row) => selected.has(row.key) && !row.known);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const enrich = (targets: PersonResult[]) => {
    ctx.onAction(enrichMessage(targets));
    setSelected(new Set());
  };

  return (
    <CardShell
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">
            {chosen.length
              ? `${chosen.length} selected · ${chosen.length} credit${chosen.length > 1 ? "s" : ""} max`
              : "Tick people to look up several at once"}
          </span>
          <Button
            disabled={ctx.disabled || chosen.length === 0}
            onClick={() => enrich(chosen.map((row) => row.person))}
            size="sm"
          >
            <MailIcon />
            {chosen.length > 1 ? `Get ${chosen.length} emails` : "Get email"}
          </Button>
        </div>
      }
      icon={<UsersRoundIcon className="size-3.5" />}
      meta={
        output.total_matches && output.total_matches > people.length
          ? `${people.length} of ${output.total_matches}`
          : `${people.length} found`
      }
      title={`People at ${company}`}
    >
      {output.note ? (
        <p className="text-muted-foreground border-b px-3 py-2 text-xs">{output.note}</p>
      ) : null}
      <ul className="divide-y">
        {visible.map(({ person, key, known }) => (
          <li className="flex items-start gap-3 px-3 py-2.5" key={key}>
            {known ? (
              <MailCheckIcon className="mt-0.5 size-4 shrink-0 text-green-600" />
            ) : (
              <input
                aria-label={`Select ${person.name ?? "person"}`}
                checked={selected.has(key)}
                className="accent-primary mt-1 size-3.5 shrink-0 cursor-pointer"
                disabled={ctx.disabled}
                onChange={() => toggle(key)}
                type="checkbox"
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <ProfileLink href={person.linkedin_url}>{person.name ?? "Unknown"}</ProfileLink>
                {person.seniority ? (
                  <Badge className="rounded-full text-[10px]" variant="outline">
                    {person.seniority}
                  </Badge>
                ) : null}
              </div>
              {person.title ? (
                <p className="text-muted-foreground truncate text-xs">{person.title}</p>
              ) : null}
              {person.location ? (
                <p className="text-muted-foreground flex items-center gap-1 truncate text-[11px]">
                  <MapPinIcon className="size-3 shrink-0" />
                  {person.location}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {known ? (
                <>
                  <span className="flex items-center gap-1">
                    <span className="font-mono text-xs">{known.email}</span>
                    <CopyButton text={known.email} />
                  </span>
                  <Button
                    disabled={ctx.disabled}
                    onClick={() =>
                      ctx.onAction(
                        draftMessage({
                          name: person.name,
                          title: person.title,
                          company: person.company,
                          email: known.email,
                        }),
                      )
                    }
                    size="xs"
                    variant="outline"
                  >
                    <MailIcon /> Write email
                  </Button>
                </>
              ) : (
                <Button
                  disabled={ctx.disabled}
                  onClick={() => enrich([person])}
                  size="xs"
                  title="Look up their work email (1 CleanList credit, only if found)"
                  variant="outline"
                >
                  Get email
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {rows.length > PEOPLE_PREVIEW ? (
        <button
          className="text-muted-foreground hover:text-foreground w-full border-t px-3 py-1.5 text-xs"
          onClick={() => setShowAll((value) => !value)}
          type="button"
        >
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </CardShell>
  );
}

function EnrichmentCard({ output, ctx }: { output: EnrichOutput; ctx: CardContext }) {
  if (output.pending) {
    return (
      <CardShell
        icon={<LoaderCircleIcon className="size-3.5 animate-spin" />}
        title="Still looking up the email"
      >
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <p className="text-muted-foreground text-xs">
            CleanList is taking longer than usual. No extra credit is used to check again.
          </p>
          <Button
            disabled={ctx.disabled || !output.workflow_id}
            onClick={() =>
              ctx.onAction(`Check the email lookup again (workflow ${output.workflow_id}).`)
            }
            size="xs"
            variant="outline"
          >
            <RefreshCwIcon /> Check again
          </Button>
        </div>
      </CardShell>
    );
  }

  if (!output.found || !output.email) {
    return (
      <StatusLine state="error">
        No email found{output.full_name ? ` for ${output.full_name}` : ""}.{" "}
        {output.note ?? "Try someone else from the list."}
      </StatusLine>
    );
  }

  const email = output.email;
  return (
    <CardShell
      footer={
        <div className="flex items-center justify-end">
          <Button
            disabled={ctx.disabled}
            onClick={() =>
              ctx.onAction(
                draftMessage({
                  name: output.full_name,
                  title: output.title,
                  company: output.company,
                  email,
                }),
              )
            }
            size="sm"
          >
            <MailIcon /> Write email
          </Button>
        </div>
      }
      icon={<MailCheckIcon className="size-3.5 text-green-600" />}
      meta={
        output.cached
          ? "already saved · no credit"
          : output.credits_charged
            ? `${output.credits_charged} credit used`
            : undefined
      }
      title="Work email found"
    >
      <div className="space-y-1 px-3 py-2.5">
        <ProfileLink href={output.linkedin_url}>{output.full_name ?? email}</ProfileLink>
        {output.title || output.company ? (
          <p className="text-muted-foreground text-xs">
            {[output.title, output.company].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        <div className="flex items-center gap-1.5 pt-0.5">
          <span className="font-mono text-sm">{email}</span>
          <CopyButton text={email} />
          <EmailStatusBadge status={output.email_status} />
        </div>
        {output.warning && !isGoodStatus(output.email_status) ? (
          <p className="text-xs text-amber-700 dark:text-amber-500">{output.warning}</p>
        ) : null}
        <TrackerNote fields={output} />
      </div>
    </CardShell>
  );
}

function formatPosted(posted: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(posted)
    ? `posted ${new Date(`${posted}T00:00:00`).toLocaleDateString()}`
    : posted;
}

function JobsCard({ output, ctx }: { output: FindJobsOutput; ctx: CardContext }) {
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const jobs = output.jobs ?? [];
  if (jobs.length === 0) {
    return <StatusLine state="done">{output.note ?? "No job listings matched."}</StatusLine>;
  }
  const visible = showAll ? jobs : jobs.slice(0, JOBS_PREVIEW);

  const save = async (job: JobResult, key: string) => {
    setSaving((prev) => new Set(prev).add(key));
    try {
      await ctx.onSaveJob(job, output.source);
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <CardShell
      icon={<BriefcaseBusinessIcon className="size-3.5" />}
      meta={output.source === "google_jobs" ? "Google Jobs" : "Dice"}
      title={`${jobs.length} job${jobs.length === 1 ? "" : "s"} found`}
    >
      <ul className="divide-y">
        {visible.map((job, index) => {
          const key = jobKeys(job)[0] ?? `${job.title}-${index}`;
          const status = ctx.jobStatus(job);
          return (
            <li
              className="flex items-start justify-between gap-3 px-3 py-2.5"
              key={`${key}-${index}`}
            >
              <div className="min-w-0">
                <ProfileLink href={job.url}>{job.title ?? "Untitled role"}</ProfileLink>
                <p className="text-muted-foreground text-xs">
                  {[job.company, job.location].filter(Boolean).join(" · ")}
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {job.remote ? (
                    <Badge className="rounded-full text-[10px]" variant="secondary">
                      Remote
                    </Badge>
                  ) : null}
                  {job.type ? (
                    <Badge className="rounded-full text-[10px]" variant="outline">
                      {job.type}
                    </Badge>
                  ) : null}
                  {job.salary ? (
                    <Badge className="rounded-full text-[10px]" variant="outline">
                      {job.salary}
                    </Badge>
                  ) : null}
                  {job.posted ? (
                    <Badge className="rounded-full text-[10px]" variant="outline">
                      {formatPosted(job.posted)}
                    </Badge>
                  ) : null}
                  {job.posted_by === "Recruiter" ? (
                    <Badge
                      className="rounded-full text-[10px]"
                      title="Posted by a staffing agency, not the employer"
                      variant="outline"
                    >
                      via agency
                    </Badge>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Button
                  disabled={ctx.disabled || !job.company}
                  onClick={() => {
                    // Looking for a recruiter means the user is going for it: track the job too.
                    if (!status) void ctx.onSaveJob(job, output.source);
                    ctx.onAction(findRecruiterMessage(job));
                  }}
                  size="xs"
                  variant="outline"
                >
                  <UserSearchIcon /> Find recruiter
                </Button>
                {status ? (
                  <Badge
                    className="rounded-full text-[10px]"
                    title={
                      ctx.trackerConnected
                        ? "In your tracker sheet"
                        : "Saved. Connect Google Sheets (plug icon) to log it to a sheet."
                    }
                    variant="secondary"
                  >
                    <BookmarkCheckIcon className="size-3 text-green-600" />
                    {status}
                  </Badge>
                ) : (
                  <Button
                    disabled={saving.has(key)}
                    onClick={() => void save(job, key)}
                    size="xs"
                    title={
                      ctx.trackerConnected
                        ? "Add to your tracker sheet"
                        : "Save this job. Connect Google Sheets (plug icon) to log saved jobs to a sheet."
                    }
                    variant="ghost"
                  >
                    {saving.has(key) ? (
                      <LoaderCircleIcon className="animate-spin" />
                    ) : (
                      <BookmarkPlusIcon />
                    )}
                    Save
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {jobs.length > JOBS_PREVIEW ? (
        <button
          className="text-muted-foreground hover:text-foreground w-full border-t px-3 py-1.5 text-xs"
          onClick={() => setShowAll((value) => !value)}
          type="button"
        >
          {showAll ? "Show fewer" : `Show all ${jobs.length}`}
        </button>
      ) : null}
      {output.note ? (
        <p className="text-muted-foreground border-t px-3 py-2 text-[11px]">{output.note}</p>
      ) : null}
    </CardShell>
  );
}

function ContactsCard({
  output,
  query,
  ctx,
}: {
  output: ContactsLookupOutput;
  query?: string;
  ctx: CardContext;
}) {
  const contacts = output.contacts ?? [];
  if (contacts.length === 0) {
    return (
      <StatusLine state="done">
        Checked saved contacts{query ? ` for “${query}”` : ""} — none yet.
      </StatusLine>
    );
  }
  return (
    <CardShell
      icon={<UsersRoundIcon className="size-3.5" />}
      title={`Saved contacts${query ? ` matching “${query}”` : ""}`}
    >
      <ul className="divide-y">
        {contacts.map((contact: ContactResult, index) => (
          <li
            className="flex items-start justify-between gap-3 px-3 py-2.5"
            key={contact.email ?? contact.linkedin_url ?? index}
          >
            <div className="min-w-0">
              <ProfileLink href={contact.linkedin_url}>{contact.name ?? contact.email}</ProfileLink>
              {contact.title || contact.company ? (
                <p className="text-muted-foreground truncate text-xs">
                  {[contact.title, contact.company ?? contact.domain].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              {contact.email ? (
                <span className="flex items-center gap-1">
                  <span className="font-mono text-xs">{contact.email}</span>
                  <CopyButton text={contact.email} />
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {contact.last_emailed ? (
                <Badge className="rounded-full text-[10px]" variant="secondary">
                  emailed {contact.last_emailed}
                </Badge>
              ) : null}
              {contact.email ? (
                <Button
                  disabled={ctx.disabled}
                  onClick={() =>
                    ctx.onAction(
                      draftMessage({
                        name: contact.name,
                        title: contact.title,
                        company: contact.company,
                        email: contact.email!,
                      }),
                    )
                  }
                  size="xs"
                  variant="outline"
                >
                  <MailIcon /> Write email
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function MemoryLine({ output, ctx }: { output: MemoryToolOutput; ctx: CardContext }) {
  const [undone, setUndone] = useState(false);
  return (
    <div className="not-prose text-muted-foreground mb-3 flex items-start gap-2 text-xs">
      <BrainIcon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">
        {undone ? (
          <span className="line-through">{output.fact}</span>
        ) : output.replaced ? (
          <>
            Updated memory: <span className="text-foreground">{output.fact}</span>
            <span className="opacity-70"> (was: {output.replaced})</span>
          </>
        ) : (
          <>
            Remembered: <span className="text-foreground">{output.fact}</span>
          </>
        )}
      </span>
      {!undone && !output.replaced && output.id ? (
        <button
          className="hover:text-foreground shrink-0 underline-offset-2 hover:underline"
          onClick={() => {
            const id = output.id;
            if (!id) return;
            void ctx.onForgetMemory(id).then(() => setUndone(true));
          }}
          type="button"
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}

// ---------- dispatcher ----------

function runningLabel(name: string, input: Record<string, unknown>): string {
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "find_jobs":
      return `Searching jobs${text("query") ? ` for “${text("query")}”` : ""}${
        text("location") ? ` in ${text("location")}` : ""
      }…`;
    case "cleanlist_find_people":
      return `Finding people at ${text("domain") || text("company_name") || "the company"}…`;
    case "cleanlist_enrich_person": {
      const name = [text("first_name"), text("last_name")].filter(Boolean).join(" ");
      return `Looking up the work email${name ? ` for ${name}` : ""} (1 credit if found) — can take up to a minute…`;
    }
    case "cleanlist_check_enrichment":
      return "Checking the email lookup…";
    case "contacts_lookup":
      return "Checking saved contacts…";
    case "knowledge_search":
      return "Reading your knowledge base…";
    case "save_contact":
      return "Saving contact…";
    case "tracker_save_job":
      return "Saving the job to your tracker…";
    case "memory_save":
      return "Saving to memory…";
    case "memory_forget":
      return "Updating memory…";
    default:
      return `Running ${name}…`;
  }
}

/** One tool call rendered as a card (or a one-line status for background steps). */
export function ToolResultCard({ part, ctx }: { part: AnyToolPart; ctx: CardContext }) {
  const name = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;

  if (part.state === "input-streaming" || part.state === "input-available") {
    return <StatusLine state="running">{runningLabel(name, input)}</StatusLine>;
  }
  if (part.state === "output-error") {
    return <StatusLine state="error">{part.errorText}</StatusLine>;
  }
  if (part.state !== "output-available") return null;

  const raw = part.output;
  const parsed = parseToolOutput<{ error?: string }>(raw);
  if (parsed?.error) return <StatusLine state="error">{parsed.error}</StatusLine>;

  switch (name) {
    case "cleanlist_find_people":
      return parsed ? (
        <PeopleCard
          ctx={ctx}
          input={input as { domain?: string; company_name?: string }}
          output={parsed as FindPeopleOutput}
        />
      ) : null;
    case "cleanlist_enrich_person":
    case "cleanlist_check_enrichment":
      return parsed ? <EnrichmentCard ctx={ctx} output={parsed as EnrichOutput} /> : null;
    case "find_jobs":
      return parsed ? <JobsCard ctx={ctx} output={parsed as FindJobsOutput} /> : null;
    case "memory_save":
      return parsed ? <MemoryLine ctx={ctx} output={parsed as MemoryToolOutput} /> : null;
    case "memory_forget": {
      const forgot = (parsed ?? {}) as MemoryToolOutput;
      return (
        <StatusLine state="done">
          Forgot: <span className="line-through">{forgot.fact ?? "a memory item"}</span>
        </StatusLine>
      );
    }
    case "tracker_save_job": {
      const saved = (parsed ?? {}) as SaveJobOutput;
      return (
        <div className="not-prose mb-3 space-y-1 text-xs">
          <p className="text-muted-foreground flex items-start gap-2">
            <BookmarkCheckIcon className="mt-px size-3.5 shrink-0 text-green-600" />
            <span>
              Saved “{saved.title ?? "the job"}”{saved.company ? ` at ${saved.company}` : ""}
              {saved.status ? ` · ${saved.status}` : ""}
            </span>
          </p>
          <div className="pl-5.5">
            <TrackerNote fields={saved} />
          </div>
        </div>
      );
    }
    case "contacts_lookup":
      return parsed ? (
        <ContactsCard
          ctx={ctx}
          output={parsed as ContactsLookupOutput}
          query={typeof input.query === "string" ? input.query : undefined}
        />
      ) : (
        <StatusLine state="done">Checked saved contacts — none yet.</StatusLine>
      );
    case "knowledge_search": {
      const count = typeof raw === "string" ? (raw.match(/^\[\d+\]/gm) ?? []).length : 0;
      return (
        <StatusLine state="done">
          {count
            ? `Read ${count} note${count === 1 ? "" : "s"} from your knowledge base`
            : "Nothing relevant in your knowledge base"}
        </StatusLine>
      );
    }
    default:
      return (
        <StatusLine state="done">{typeof raw === "string" ? raw.slice(0, 200) : name}</StatusLine>
      );
  }
}
