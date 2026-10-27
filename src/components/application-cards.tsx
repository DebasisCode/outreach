"use client";

import { Kbd } from "@/components/kbd";
import { TrackerNote } from "@/components/tracker-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  parseToolOutput,
  type ApplicationFieldSummary,
  type ApplicationOutput,
  type BrowseOutput,
} from "@/lib/tool-outputs";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  AppWindowIcon,
  BanIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ClipboardCheckIcon,
  ExternalLinkIcon,
  ImageIcon,
  LoaderCircleIcon,
  MousePointerClickIcon,
  SendIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Chat cards for job applications filled in the browser window: progress
 * (what's filled, what's still needed, what the user must do in the window),
 * the review before submitting, and approval for risky browser clicks.
 */

const STATUS_LABEL: Record<string, { text: string; tone: "ok" | "wait" | "bad" | "muted" }> = {
  needs_answers: { text: "needs answers", tone: "wait" },
  needs_user: { text: "your turn in the browser", tone: "wait" },
  next_page: { text: "page done", tone: "muted" },
  ready_to_submit: { text: "ready to submit", tone: "ok" },
  submitted: { text: "submitted", tone: "ok" },
  failed: { text: "failed", tone: "bad" },
  in_progress: { text: "in progress", tone: "muted" },
};

function StatusBadge({ status }: { status?: string }) {
  if (!status) return null;
  const info = STATUS_LABEL[status] ?? { text: status.replace(/_/g, " "), tone: "muted" as const };
  return (
    <Badge
      className={`rounded-full text-[10px] ${
        info.tone === "ok"
          ? "text-green-700 dark:text-green-500"
          : info.tone === "wait"
            ? "text-amber-700 dark:text-amber-500"
            : info.tone === "bad"
              ? "text-destructive"
              : ""
      }`}
      variant="outline"
    >
      {info.text}
    </Badge>
  );
}

async function showBrowser(id?: string): Promise<string | null> {
  try {
    const res = await fetch("/api/browser", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "show", id }),
    });
    const data = (await res.json()) as { error?: string };
    return res.ok ? null : (data.error ?? "Couldn't show the browser.");
  } catch {
    return "Couldn't reach the app.";
  }
}

function ShowBrowserButton({ id }: { id?: string }) {
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {note ? <span className="text-muted-foreground text-[11px]">{note}</span> : null}
      <Button
        onClick={() => void showBrowser(id).then(setNote)}
        size="xs"
        title="Bring the browser window to the front"
        variant="ghost"
      >
        <AppWindowIcon /> Show browser
      </Button>
    </span>
  );
}

function ScreenshotLink({ id, at }: { id?: string; at?: number }) {
  if (!id || !at) return null;
  return (
    <Button asChild size="xs" variant="ghost">
      <a href={`/api/applications/${id}/screenshot?v=${at}`} rel="noopener noreferrer" target="_blank">
        <ImageIcon /> Screenshot
      </a>
    </Button>
  );
}

function FieldList({ fields, showValue }: { fields: ApplicationFieldSummary[]; showValue?: boolean }) {
  return (
    <ul className="space-y-1">
      {fields.map((field) => (
        <li className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 text-xs" key={field.id}>
          <span className="text-muted-foreground truncate" title={field.label}>
            {field.label}
            {field.required ? <span className="text-amber-600"> *</span> : null}
          </span>
          <span className="min-w-0 truncate" title={showValue ? field.value : field.error ?? field.hint}>
            {showValue ? (
              field.value
            ) : field.error ? (
              <span className="text-destructive">{field.error}</span>
            ) : field.options?.length ? (
              <span className="text-muted-foreground">
                {field.options.slice(0, 4).join(" · ")}
                {field.options.length > 4 || field.more_options ? " …" : ""}
              </span>
            ) : (
              <span className="text-muted-foreground">{field.kind ?? ""}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Collapsible({ title, children, open: initiallyOpen = false }: { title: ReactNode; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div>
      <button
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        {title}
      </button>
      {open ? <div className="mt-1.5 pl-4.5">{children}</div> : null}
    </div>
  );
}

function Shell({ title, meta, footer, children }: { title: ReactNode; meta?: ReactNode; footer?: ReactNode; children?: ReactNode }) {
  return (
    <div className="not-prose bg-card mb-4 w-full overflow-hidden rounded-lg border">
      <div className="bg-muted/40 flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <ClipboardCheckIcon className="size-3.5 shrink-0" />
          <span className="truncate">{title}</span>
        </div>
        {meta ? <div className="flex shrink-0 items-center gap-1.5 text-[11px]">{meta}</div> : null}
      </div>
      {children}
      {footer ? <div className="border-t px-3 py-2">{footer}</div> : null}
    </div>
  );
}

const jobTitle = (output: ApplicationOutput) =>
  [output.title, output.company].filter(Boolean).join(" · ") || output.page_title || "Job application";

/** Progress of an application: browser_apply_start / fill / next / check. */
export function ApplicationCard({
  output,
  disabled,
  onAction,
}: {
  output: ApplicationOutput;
  disabled: boolean;
  onAction: (text: string) => void;
}) {
  const needs = output.needs ?? [];
  const required = needs.filter((field) => field.required);
  return (
    <Shell
      footer={
        <div className="flex flex-wrap items-center justify-end gap-1">
          <ScreenshotLink at={output.screenshot_at} id={output.application_id} />
          {output.status !== "submitted" ? <ShowBrowserButton id={output.application_id} /> : null}
          {output.status === "needs_user" ? (
            <Button
              disabled={disabled}
              onClick={() => onAction("I'm done in the browser window — check the application again.")}
              size="xs"
            >
              <CheckCircle2Icon /> Done — continue
            </Button>
          ) : null}
        </div>
      }
      meta={
        <>
          {output.ats ? <span className="text-muted-foreground">{output.ats}</span> : null}
          <StatusBadge status={output.status} />
        </>
      }
      title={jobTitle(output)}
    >
      <div className="space-y-2 px-3 py-2.5">
        {output.url ? (
          <a
            className="text-muted-foreground inline-flex max-w-full items-center gap-1 truncate text-[11px] hover:underline"
            href={output.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span className="truncate">{output.url}</span>
            <ExternalLinkIcon className="size-3 shrink-0 opacity-60" />
          </a>
        ) : null}
        {output.user_action ? (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-300">
            <AppWindowIcon className="mt-px size-3.5 shrink-0" />
            {output.user_action}
          </p>
        ) : null}
        {output.status === "submitted" ? (
          <p className="flex items-start gap-1.5 text-xs text-green-700 dark:text-green-500">
            <CheckCircle2Icon className="mt-px size-3.5 shrink-0" />
            {output.note ?? output.confirmation ?? "Application submitted."}
          </p>
        ) : output.note ? (
          <p className="text-muted-foreground text-xs">{output.note}</p>
        ) : null}
        {output.resume ? <p className="text-xs text-amber-700 dark:text-amber-500">{output.resume}</p> : null}
        {output.page_errors?.length ? (
          <div className="text-destructive space-y-0.5 text-xs">
            {output.page_errors.map((error) => (
              <p className="flex items-start gap-1.5" key={error}>
                <CircleAlertIcon className="mt-px size-3.5 shrink-0" /> {error}
              </p>
            ))}
          </div>
        ) : null}
        {output.filled?.length ? (
          <Collapsible title={`Filled ${output.filled_count ?? output.filled.length} field${(output.filled_count ?? 0) === 1 ? "" : "s"}`}>
            <FieldList fields={output.filled} showValue />
          </Collapsible>
        ) : null}
        {needs.length ? (
          <Collapsible
            open={required.length > 0}
            title={
              required.length
                ? `${required.length} required question${required.length === 1 ? "" : "s"} left${
                    needs.length > required.length ? ` · ${needs.length - required.length} optional` : ""
                  }`
                : `${needs.length} optional field${needs.length === 1 ? "" : "s"} left`
            }
          >
            <FieldList fields={needs} />
          </Collapsible>
        ) : null}
        {output.problems?.length ? (
          <div className="text-destructive space-y-0.5 text-xs">
            {output.problems.map((problem) => (
              <p key={`${problem.id}-${problem.error}`}>
                {problem.label}: {problem.error}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

interface ApplicationDetails {
  id: string;
  status: string;
  title: string | null;
  company: string | null;
  url: string | null;
  summary: ApplicationOutput | null;
  screenshot: string | null;
}

function Line({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "bad" }) {
  return (
    <p
      className={`flex items-center gap-1.5 text-xs ${
        tone === "ok" ? "text-green-700 dark:text-green-500" : tone === "bad" ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {children}
    </p>
  );
}

/**
 * The filled form, before it is submitted: a screenshot and every answer,
 * with Submit / Don't submit. Nothing is submitted until the user clicks.
 */
export function ApplicationSubmitCard({
  applicationId,
  state,
  approved,
  output,
  errorText,
  onRespond,
  mac = false,
}: {
  applicationId?: string;
  state: string;
  approved?: boolean;
  output?: unknown;
  errorText?: string;
  onRespond?: (approved: boolean) => void;
  mac?: boolean;
}) {
  const [details, setDetails] = useState<ApplicationDetails | null>(null);
  const result = parseToolOutput<ApplicationOutput>(output);

  useEffect(() => {
    if (!applicationId) return;
    let cancelled = false;
    fetch(`/api/applications/${encodeURIComponent(applicationId)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ application: ApplicationDetails }>) : null))
      .then((data) => {
        if (!cancelled && data) setDetails(data.application);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [applicationId, state]);

  const summary = result ?? details?.summary ?? null;
  const waiting = state === "approval-requested" && onRespond;
  const requiredLeft = summary?.needs?.filter((field) => field.required).length ?? 0;

  let footer: ReactNode;
  if (waiting) {
    footer = (
      <div className="flex items-center justify-end gap-2">
        <ShowBrowserButton id={applicationId} />
        <Button onClick={() => onRespond(false)} size="sm" variant="ghost">
          <BanIcon /> Don&apos;t submit
          <Kbd className="ml-1 hidden h-4.5 sm:inline-flex" keys={["esc"]} mac={mac} />
        </Button>
        <Button onClick={() => onRespond(true)} size="sm">
          <SendIcon /> Submit application
          <Kbd
            className="bg-primary-foreground/15 text-primary-foreground ml-1 hidden h-4.5 border-transparent sm:inline-flex"
            keys={["mod", "enter"]}
            mac={mac}
          />
        </Button>
      </div>
    );
  } else if (state === "approval-requested") {
    footer = (
      <Line>
        <BanIcon className="size-3.5" /> Not submitted — the chat moved on without a decision.
      </Line>
    );
  } else if ((state === "approval-responded" && approved !== false) || state === "input-available") {
    footer = (
      <Line>
        <LoaderCircleIcon className="size-3.5 animate-spin" /> Submitting…
      </Line>
    );
  } else if (state === "output-denied" || state === "approval-responded") {
    footer = (
      <Line>
        <BanIcon className="size-3.5" /> Not submitted.
      </Line>
    );
  } else if (state === "output-error") {
    footer = (
      <Line tone="bad">
        <XCircleIcon className="size-3.5" /> Not submitted: {errorText ?? "unknown error"}
      </Line>
    );
  } else if (state === "output-available" && result) {
    footer =
      result.status === "submitted" ? (
        <div className="space-y-1">
          <Line tone="ok">
            <CheckCircle2Icon className="size-3.5" /> Submitted{result.confirmation ? ` · “${result.confirmation}”` : ""}
          </Line>
          <TrackerNote fields={result} />
        </div>
      ) : (
        <Line tone="bad">
          <CircleAlertIcon className="size-3.5" />
          {result.error ?? result.user_action ?? result.note ?? "Not submitted yet."}
        </Line>
      );
  } else {
    footer = (
      <Line>
        <LoaderCircleIcon className="size-3.5 animate-spin" /> Preparing…
      </Line>
    );
  }

  const screenshot = details?.screenshot;
  const title = summary ? jobTitle(summary) : [details?.title, details?.company].filter(Boolean).join(" · ") || "Job application";
  return (
    <Shell
      footer={footer}
      meta={summary?.ats ? <span className="text-muted-foreground">{summary.ats}</span> : null}
      title={waiting ? `Review before submitting · ${title}` : title}
    >
      <div className="space-y-2 px-3 py-2.5">
        {waiting && requiredLeft ? (
          <p className="text-destructive text-xs">
            {requiredLeft} required field{requiredLeft === 1 ? " is" : "s are"} still empty — the site will likely reject it. Click Don&apos;t submit and
            answer {requiredLeft === 1 ? "it" : "them"} first.
          </p>
        ) : waiting && summary?.needs?.length ? (
          <p className="text-xs text-amber-700 dark:text-amber-500">
            {summary.needs.length} optional field{summary.needs.length === 1 ? " is" : "s are"} empty — that&apos;s fine to submit.
          </p>
        ) : null}
        {summary?.filled?.length ? <FieldList fields={summary.filled} showValue /> : null}
        {screenshot ? (
          <a href={screenshot} rel="noopener noreferrer" target="_blank" title="Open the full screenshot">
            {/* eslint-disable-next-line @next/next/no-img-element -- local, changing screenshot */}
            <img
              alt="The filled application form"
              className="max-h-72 w-full rounded-md border object-cover object-top"
              src={screenshot}
            />
          </a>
        ) : null}
      </div>
    </Shell>
  );
}

/** The element a browser_act call points at, from the latest page read in this chat. */
export function findBrowseElement(messages: UIMessage[], id: string | undefined) {
  if (!id) return null;
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const parts = messages[m].parts;
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p];
      if (!isToolUIPart(part) || part.state !== "output-available") continue;
      const name = getToolName(part);
      if (name !== "browser_open" && name !== "browser_act") continue;
      const output = parseToolOutput<BrowseOutput>(part.output);
      const element = output?.elements?.find((item) => item.id === id);
      if (output?.elements) return element ? { label: element.label, url: output.url } : null;
    }
  }
  return null;
}

/** A browser click that would submit, send, buy or delete something: the user decides. */
export function BrowserActApprovalCard({
  input,
  element,
  state,
  approved,
  onRespond,
  mac = false,
}: {
  input: { id?: string; action?: string; value?: string };
  element: { label: string; url?: string } | null;
  state: string;
  approved?: boolean;
  onRespond?: (approved: boolean) => void;
  mac?: boolean;
}) {
  let host = "";
  try {
    host = element?.url ? new URL(element.url).host : "";
  } catch {
    // keep empty
  }
  const what =
    input.action === "press"
      ? `Press ${input.value ?? "Enter"} in “${element?.label ?? input.id}”`
      : `Click “${element?.label ?? input.id}”`;
  return (
    <div className="not-prose bg-card mb-4 w-full overflow-hidden rounded-lg border">
      <div className="bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
        <MousePointerClickIcon className="size-3.5" />
        {state === "approval-requested" && onRespond ? "Allow this browser action?" : "Browser action"}
      </div>
      <p className="px-3 py-2.5 text-sm">
        {what}
        {host ? <span className="text-muted-foreground"> on {host}</span> : null}
      </p>
      <div className="border-t px-3 py-2">
        {state === "approval-requested" && onRespond ? (
          <div className="flex items-center justify-end gap-2">
            <ShowBrowserButton />
            <Button onClick={() => onRespond(false)} size="sm" variant="ghost">
              <BanIcon /> Don&apos;t
              <Kbd className="ml-1 hidden h-4.5 sm:inline-flex" keys={["esc"]} mac={mac} />
            </Button>
            <Button onClick={() => onRespond(true)} size="sm">
              <MousePointerClickIcon /> Allow
              <Kbd
                className="bg-primary-foreground/15 text-primary-foreground ml-1 hidden h-4.5 border-transparent sm:inline-flex"
                keys={["mod", "enter"]}
                mac={mac}
              />
            </Button>
          </div>
        ) : state === "output-denied" || (state === "approval-responded" && approved === false) ? (
          <Line>
            <BanIcon className="size-3.5" /> Not done.
          </Line>
        ) : state === "approval-requested" ? (
          <Line>
            <BanIcon className="size-3.5" /> Not done — the chat moved on without a decision.
          </Line>
        ) : (
          <Line>
            <LoaderCircleIcon className="size-3.5 animate-spin" /> Working…
          </Line>
        )}
      </div>
    </div>
  );
}
