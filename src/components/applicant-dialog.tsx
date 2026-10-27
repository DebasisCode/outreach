"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyApplicantProfile,
  type ApplicantProfile,
  type ResumeFileInfo,
  type UserKeys,
} from "@/lib/types";
import { FileTextIcon, IdCardIcon, LoaderCircleIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Key = keyof ApplicantProfile;

interface FieldSpec {
  key: Key;
  label: string;
  placeholder?: string;
  type?: "text" | "email" | "tel" | "url" | "yesno" | "long";
  wide?: boolean;
}

const SECTIONS: Array<{ title: string; note?: string; fields: FieldSpec[] }> = [
  {
    title: "You",
    fields: [
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "email", label: "Email", type: "email" },
      { key: "phone", label: "Phone", type: "tel", placeholder: "+91 98765 43210" },
      { key: "preferredName", label: "Preferred name" },
      { key: "pronouns", label: "Pronouns" },
    ],
  },
  {
    title: "Location",
    fields: [
      { key: "city", label: "City" },
      { key: "region", label: "State / region" },
      { key: "country", label: "Country" },
      { key: "postalCode", label: "Postal code" },
      { key: "address", label: "Street address", wide: true },
    ],
  },
  {
    title: "Links",
    fields: [
      { key: "linkedinUrl", label: "LinkedIn", type: "url", placeholder: "https://www.linkedin.com/in/…" },
      { key: "githubUrl", label: "GitHub", type: "url" },
      { key: "websiteUrl", label: "Website / portfolio", type: "url", wide: true },
    ],
  },
  {
    title: "Work",
    fields: [
      { key: "currentCompany", label: "Current company" },
      { key: "currentTitle", label: "Current title" },
      { key: "yearsOfExperience", label: "Years of experience" },
      { key: "noticePeriod", label: "Notice period", placeholder: "e.g. 30 days" },
      { key: "salaryExpectation", label: "Salary expectation", placeholder: "e.g. ₹40L or $150k" },
      { key: "earliestStartDate", label: "Earliest start date" },
      { key: "needsSponsorship", label: "Needs visa sponsorship?", type: "yesno" },
      { key: "willingToRelocate", label: "Willing to relocate?", type: "yesno" },
      {
        key: "workAuthorization",
        label: "Work authorization",
        type: "long",
        placeholder: "e.g. Indian citizen. Authorized to work in India; would need H-1B sponsorship for the US.",
        wide: true,
      },
    ],
  },
  {
    title: "Voluntary self-identification",
    note: "Optional. Left empty, forms get the \"decline to self-identify\" answer.",
    fields: [
      { key: "gender", label: "Gender" },
      { key: "ethnicity", label: "Race / ethnicity" },
      { key: "veteranStatus", label: "Veteran status" },
      { key: "disabilityStatus", label: "Disability status" },
    ],
  },
  {
    title: "Anything else forms ask",
    fields: [
      {
        key: "notes",
        label: "Notes",
        type: "long",
        placeholder: "Degree, university, graduation year, languages, how you usually heard about jobs…",
        wide: true,
      },
    ],
  },
];

const formatSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * What job application forms are filled from: contact details, links, work
 * authorization… and the resume file to attach. Stored locally.
 */
export function ApplicantDialog({
  open,
  onOpenChange,
  keys,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** For adding the resume's text to the knowledge base (embeddings). */
  keys: UserKeys | null;
  onSaved?: (message: string) => void;
}) {
  const [profile, setProfile] = useState<ApplicantProfile>(emptyApplicantProfile);
  const [resume, setResume] = useState<ResumeFileInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [addToKnowledge, setAddToKnowledge] = useState(true);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/applicant");
      const data = (await res.json()) as { profile?: ApplicantProfile; resume?: ResumeFileInfo | null };
      if (data.profile) setProfile(data.profile);
      setResume(data.resume ?? null);
    } catch {
      setMessage({ text: "Couldn't load your profile.", error: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      setMessage(null);
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [open, load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/applicant", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) throw new Error();
      onSaved?.("Applicant profile saved.");
      onOpenChange(false);
    } catch {
      setMessage({ text: "Couldn't save — try again.", error: true });
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (addToKnowledge) {
        form.append("addToKnowledge", "1");
        if (keys) form.append("keys", JSON.stringify(keys));
      }
      const res = await fetch("/api/applicant/resume", { method: "POST", body: form });
      const data = (await res.json()) as { resume?: ResumeFileInfo; knowledge?: string | null; error?: string };
      if (!res.ok || !data.resume) throw new Error(data.error ?? "Upload failed");
      setResume(data.resume);
      setMessage({
        text:
          data.knowledge === "added"
            ? "Resume saved and added to your knowledge base."
            : data.knowledge
              ? `Resume saved (knowledge base: ${data.knowledge}).`
              : "Resume saved.",
      });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Upload failed", error: true });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeResume = async () => {
    await fetch("/api/applicant/resume", { method: "DELETE" }).catch(() => undefined);
    setResume(null);
  };

  const set = (key: Key, value: string) => setProfile((prev) => ({ ...prev, [key]: value }));

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IdCardIcon className="size-4" /> Applicant profile
          </DialogTitle>
          <DialogDescription>
            What job applications are filled from. The assistant fills the form in a browser window on
            this computer and asks you before submitting. Stored only on this computer.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <FileTextIcon className="text-muted-foreground size-4 shrink-0" />
              {resume ? (
                <div className="min-w-0">
                  <a className="block truncate text-sm font-medium hover:underline" href="/api/applicant/resume">
                    {resume.fileName}
                  </a>
                  <p className="text-muted-foreground text-[11px]">
                    {formatSize(resume.size)} · added {new Date(resume.uploadedAt).toLocaleDateString()} · attached to every application
                  </p>
                </div>
              ) : (
                <p className="text-sm">
                  <span className="font-medium">Resume</span>{" "}
                  <span className="text-muted-foreground">— upload the file applications should attach.</span>
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {resume ? (
                <Button aria-label="Remove resume" onClick={() => void removeResume()} size="icon-sm" variant="ghost">
                  <Trash2Icon />
                </Button>
              ) : null}
              <Button disabled={uploading} onClick={() => fileRef.current?.click()} size="sm" variant="outline">
                {uploading ? <LoaderCircleIcon className="animate-spin" /> : <UploadIcon />}
                {resume ? "Replace" : "Upload"}
              </Button>
              <input
                accept=".pdf,.doc,.docx,.txt,.rtf,.odt"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
                ref={fileRef}
                type="file"
              />
            </div>
          </div>
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <input
              checked={addToKnowledge}
              className="accent-primary size-3.5 cursor-pointer"
              onChange={(event) => setAddToKnowledge(event.target.checked)}
              type="checkbox"
            />
            When uploading, also add its text to the knowledge base, so the assistant can answer questions from it
          </label>
        </section>

        {loading ? (
          <p className="text-muted-foreground py-6 text-center text-sm">Loading…</p>
        ) : (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {SECTIONS.map((section) => (
              <fieldset className="space-y-2" key={section.title}>
                <legend className="text-sm font-medium">{section.title}</legend>
                {section.note ? <p className="text-muted-foreground text-xs">{section.note}</p> : null}
                <div className="grid grid-cols-1 gap-x-3 gap-y-2.5 sm:grid-cols-2">
                  {section.fields.map((field) => (
                    <div className={`space-y-1 ${field.wide ? "sm:col-span-2" : ""}`} key={field.key}>
                      <Label className="text-muted-foreground text-xs font-normal" htmlFor={`applicant-${field.key}`}>
                        {field.label}
                      </Label>
                      {field.type === "long" ? (
                        <Textarea
                          className="min-h-14 text-sm"
                          id={`applicant-${field.key}`}
                          onChange={(event) => set(field.key, event.target.value)}
                          placeholder={field.placeholder}
                          value={profile[field.key]}
                        />
                      ) : field.type === "yesno" ? (
                        <select
                          className="border-input dark:bg-input/30 h-8 w-full rounded-lg border bg-transparent px-2 text-sm"
                          id={`applicant-${field.key}`}
                          onChange={(event) => set(field.key, event.target.value)}
                          value={profile[field.key]}
                        >
                          <option value="">—</option>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      ) : (
                        <Input
                          className="h-8 text-sm"
                          id={`applicant-${field.key}`}
                          onChange={(event) => set(field.key, event.target.value)}
                          placeholder={field.placeholder}
                          type={field.type ?? "text"}
                          value={profile[field.key]}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </fieldset>
            ))}
            <div className="bg-background sticky bottom-0 flex items-center justify-between gap-3 border-t pt-3">
              <p className={`text-xs ${message?.error ? "text-destructive" : "text-muted-foreground"}`}>
                {message?.text ?? "The assistant also saves answers you give it in chat."}
              </p>
              <Button disabled={saving} size="sm" type="submit">
                {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
                Save
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
