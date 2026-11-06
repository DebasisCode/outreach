"use client";

import { Kbd } from "@/components/kbd";
import { TrackerNote } from "@/components/tracker-note";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { parseToolOutput, type EmailToolOutput } from "@/lib/tool-outputs";
import {
  BanIcon,
  CheckCircle2Icon,
  FileTextIcon,
  LoaderCircleIcon,
  MailIcon,
  PaperclipIcon,
  PencilIcon,
  SendIcon,
  XCircleIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

export interface EmailDraft {
  to?: string;
  subject?: string;
  body?: string;
  /** The role the email is about (logged with it in the tracker). */
  job_title?: string;
  /** Attach the resume from the Applicant profile before sending. */
  attach_resume?: boolean;
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
  /**
   * Present only while this email is waiting for the user's decision. When
   * the user edited the email, the edited version goes back and is sent.
   */
  onRespond?: (approved: boolean, edited?: EmailDraft) => void;
  /** Live-syncs edits into the email the server will send. */
  onEdit?: (edited: EmailDraft) => void;
  /** File name of the resume in the Applicant profile, when uploaded. */
  resumeName?: string | null;
  /** Show Mac key names in the shortcut hints. */
  mac?: boolean;
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
 * The email exactly as it will be sent (or saved), with buttons to approve,
 * decline, or edit first: the Edit toggle turns To / Subject / Body into
 * fields, and every change goes straight back into the message — so what
 * the user sees (even with the Ctrl+Enter shortcut) is exactly what goes
 * out. Nothing reaches the user's mailbox until they click.
 */
export function EmailApprovalCard({
  mode,
  draft,
  state,
  approved,
  output,
  errorText,
  onRespond,
  onEdit,
  resumeName,
  mac = false,
}: EmailApprovalCardProps) {
  const result = parseToolOutput<EmailToolOutput>(output) ?? {};
  const succeeded = mode === "send" ? result.sent === true : result.drafted === true;
  const doneVerb = mode === "send" ? "Sent" : "Saved to drafts";
  const notDone = mode === "send" ? "Not sent" : "Not saved";

  const waiting = state === "approval-requested" && onRespond;
  const [editing, setEditing] = useState(false);

  const shownTo = draft.to ?? "";
  const shownSubject = draft.subject ?? "";
  const shownBody = draft.body ?? "";
  const shownAttach = Boolean(draft.attach_resume);

  // Edits write straight into the tool input the server will use.
  const editDraft = (patch: Partial<EmailDraft>) => onEdit?.({ ...draft, ...patch });

  const canApprove = Boolean(shownTo.includes("@") && shownSubject.trim() && shownBody.trim());
  const approve = () =>
    onRespond?.(true, {
      to: shownTo.trim(),
      subject: shownSubject.trim(),
      body: shownBody,
      attach_resume: shownAttach,
    });

  let footer: ReactNode;
  if (waiting) {
    footer = (
      <div className="flex items-center justify-between gap-2">
        {onEdit ? (
          <Button onClick={() => setEditing((open) => !open)} size="sm" variant="ghost">
            <PencilIcon /> {editing ? "Done editing" : "Edit"}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button onClick={() => onRespond(false)} size="sm" variant="ghost">
            <BanIcon /> {mode === "send" ? "Don't send" : "Don't save"}
            <Kbd className="ml-1 hidden h-4.5 sm:inline-flex" keys={["esc"]} mac={mac} />
          </Button>
          <Button disabled={!canApprove} onClick={approve} size="sm">
            {mode === "send" ? <SendIcon /> : <FileTextIcon />}
            {mode === "send" ? "Send email" : "Save to drafts"}
            <Kbd
              className="bg-primary-foreground/15 text-primary-foreground ml-1 hidden h-4.5 border-transparent sm:inline-flex"
              keys={["mod", "enter"]}
              mac={mac}
            />
          </Button>
        </div>
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
          {result.attachment ? ` · with ${result.attachment}` : ""}
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
        {waiting
          ? mode === "send"
            ? "Review before sending"
            : "Review draft"
          : mode === "send"
            ? "Email"
            : "Gmail draft"}
      </div>
      {waiting && editing && onEdit ? (
        <div className="grid grid-cols-1 gap-2.5 px-3 pt-3 pb-1 text-xs">
          <label className="grid gap-1">
            <span className="text-muted-foreground">To</span>
            <Input
              className="font-mono text-xs"
              onChange={(event) => editDraft({ to: event.target.value })}
              value={shownTo}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">Subject</span>
            <Input
              onChange={(event) => editDraft({ subject: event.target.value })}
              value={shownSubject}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-muted-foreground">Body</span>
            <Textarea
              className="max-h-72 min-h-36 resize-y text-sm leading-relaxed"
              onChange={(event) => editDraft({ body: event.target.value })}
              value={shownBody}
            />
          </label>
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 pt-0.5">
            <input
              checked={shownAttach}
              className="accent-primary size-3.5"
              onChange={(event) => editDraft({ attach_resume: event.target.checked })}
              type="checkbox"
            />
            <PaperclipIcon className="size-3.5" />
            Attach my resume{resumeName ? ` (${resumeName})` : ""}
            {resumeName ? "" : " — upload one under Applicant profile first"}
          </label>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 pt-3 text-xs">
            <dt className="text-muted-foreground">To</dt>
            <dd className="truncate font-mono">{shownTo || "…"}</dd>
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="font-medium">{shownSubject || "…"}</dd>
            {draft.job_title ? (
              <>
                <dt className="text-muted-foreground">Role</dt>
                <dd>{draft.job_title}</dd>
              </>
            ) : null}
            {shownAttach ? (
              <>
                <dt className="text-muted-foreground">Attachment</dt>
                <dd className="flex items-center gap-1.5">
                  <PaperclipIcon className="text-muted-foreground size-3" />
                  {resumeName ?? "Resume (Applicant profile)"}
                </dd>
              </>
            ) : null}
          </dl>
          <div className="px-3 py-3 text-sm leading-relaxed whitespace-pre-wrap">
            {shownBody}
          </div>
        </>
      )}
      <div className="border-t px-3 py-2">{footer}</div>
    </div>
  );
}
