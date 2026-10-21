"use client";

import { TrackerNote } from "@/components/tracker-note";
import { Button } from "@/components/ui/button";
import { parseToolOutput, type EmailToolOutput } from "@/lib/tool-outputs";
import {
  BanIcon,
  CheckCircle2Icon,
  FileTextIcon,
  LoaderCircleIcon,
  MailIcon,
  SendIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export interface EmailDraft {
  to?: string;
  subject?: string;
  body?: string;
  /** The role the email is about (logged with it in the tracker). */
  job_title?: string;
}

interface EmailApprovalCardProps {
  /** "send" emails now; "draft" saves to the mailbox's Drafts. */
  mode: "send" | "draft";
  draft: EmailDraft;
  /** Tool part state from the AI SDK. */
  state: string;
  /** The user's answer, once given. */
  approved?: boolean;
  /** Tool result (a JSON string) once it ran. */
  output?: unknown;
  errorText?: string;
  /** Present only while this email is waiting for the user's decision. */
  onRespond?: (approved: boolean) => void;
}

const Line = ({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ok" | "bad" }) => (
  <p
    className={`flex items-center gap-1.5 text-xs ${
      tone === "ok"
        ? "text-green-700 dark:text-green-500"
        : tone === "bad"
          ? "text-destructive"
          : "text-muted-foreground"
    }`}
  >
    {children}
  </p>
);

/**
 * The email exactly as it will be sent (or saved), with buttons to approve or
 * decline. Nothing reaches the user's mailbox until they click.
 */
export function EmailApprovalCard({
  mode,
  draft,
  state,
  approved,
  output,
  errorText,
  onRespond,
}: EmailApprovalCardProps) {
  const result = parseToolOutput<EmailToolOutput>(output) ?? {};
  const succeeded = mode === "send" ? result.sent === true : result.drafted === true;
  const doneVerb = mode === "send" ? "Sent" : "Saved to drafts";
  const notDone = mode === "send" ? "Not sent" : "Not saved";

  let footer: ReactNode;
  if (state === "approval-requested" && onRespond) {
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button onClick={() => onRespond(false)} size="sm" variant="ghost">
          <BanIcon /> {mode === "send" ? "Don't send" : "Don't save"}
        </Button>
        <Button onClick={() => onRespond(true)} size="sm">
          {mode === "send" ? <SendIcon /> : <FileTextIcon />}
          {mode === "send" ? "Send email" : "Save to drafts"}
        </Button>
      </div>
    );
  } else if (state === "approval-requested") {
    footer = (
      <Line>
        <BanIcon className="size-3.5" /> {notDone} — the chat moved on without a decision.
      </Line>
    );
  } else if ((state === "approval-responded" && approved !== false) || state === "input-available") {
    footer = (
      <Line>
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        {mode === "send" ? "Sending…" : "Saving…"}
      </Line>
    );
  } else if (state === "output-denied" || state === "approval-responded") {
    footer = (
      <Line>
        <BanIcon className="size-3.5" /> {notDone}.
      </Line>
    );
  } else if (state === "output-error" || (state === "output-available" && !succeeded)) {
    footer = (
      <Line tone="bad">
        <XCircleIcon className="size-3.5" /> {notDone}: {errorText ?? result.error ?? "unknown error"}
      </Line>
    );
  } else if (state === "output-available") {
    const where = result.from ?? result.mailbox;
    footer = (
      <div className="space-y-1">
        <Line tone="ok">
          <CheckCircle2Icon className="size-3.5" /> {doneVerb}
          {where ? ` · ${where}` : ""}
        </Line>
        <TrackerNote fields={result} />
      </div>
    );
  } else {
    footer = (
      <Line>
        <LoaderCircleIcon className="size-3.5 animate-spin" /> Writing…
      </Line>
    );
  }

  return (
    <div className="not-prose border-border/80 bg-card mb-4 w-full overflow-hidden rounded-lg border">
      <div className="bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
        <MailIcon className="size-3.5" />
        {state === "approval-requested" && onRespond
          ? mode === "send"
            ? "Review before sending"
            : "Review draft"
          : mode === "send"
            ? "Email"
            : "Gmail draft"}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pt-3 text-xs">
        <dt className="text-muted-foreground">To</dt>
        <dd className="truncate font-mono">{draft.to ?? "…"}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd className="font-medium">{draft.subject ?? "…"}</dd>
        {draft.job_title ? (
          <>
            <dt className="text-muted-foreground">Role</dt>
            <dd>{draft.job_title}</dd>
          </>
        ) : null}
      </dl>
      <div className="px-3 py-3 text-sm leading-relaxed whitespace-pre-wrap">
        {draft.body ?? ""}
      </div>
      <div className="border-t px-3 py-2">{footer}</div>
    </div>
  );
}
