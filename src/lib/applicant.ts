import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, getSetting, setSetting } from "@/lib/db";
import {
  APPLICANT_PROFILE_FIELDS,
  emptyApplicantProfile,
  type ApplicantProfile,
  type ResumeFileInfo,
} from "@/lib/types";

/**
 * The Applicant profile (what application forms ask) and the resume file
 * they upload. Both live locally: the profile in the settings table, the
 * file under .data/files.
 */

const PROFILE_KEY = "applicant_profile";
const RESUME_KEY = "applicant_resume";
const FILES_DIR = path.join(DATA_DIR, "files");
const RESUME_TYPES = /\.(pdf|docx?|txt|rtf|odt)$/i;
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

export function getApplicantProfile(): ApplicantProfile {
  const stored = getSetting<Partial<ApplicantProfile>>(PROFILE_KEY) ?? {};
  const profile = emptyApplicantProfile();
  for (const key of APPLICANT_PROFILE_FIELDS) {
    if (typeof stored[key] === "string") profile[key] = stored[key];
  }
  return profile;
}

/** Merge `patch` into the profile. Unknown keys are ignored; values are trimmed and capped. */
export function saveApplicantProfile(patch: Record<string, unknown>): ApplicantProfile {
  const profile = getApplicantProfile();
  for (const key of APPLICANT_PROFILE_FIELDS) {
    const value = patch[key];
    if (typeof value !== "string") continue;
    profile[key] = value.trim().slice(0, key === "notes" || key === "workAuthorization" ? 2000 : 300);
  }
  setSetting(PROFILE_KEY, profile);
  return profile;
}

export function getResumeInfo(): ResumeFileInfo | null {
  const info = getSetting<ResumeFileInfo & { stored: string }>(RESUME_KEY);
  if (!info || !fs.existsSync(path.join(FILES_DIR, info.stored))) return null;
  return { fileName: info.fileName, size: info.size, uploadedAt: info.uploadedAt };
}

/**
 * Where the resume is on disk, under its original name — forms show the file
 * name to the recruiter, so "Asha_Rao_Resume.pdf" beats "resume-17123.pdf".
 */
export function resumePath(): string | null {
  const info = getSetting<{ stored: string }>(RESUME_KEY);
  if (!info) return null;
  const file = path.join(FILES_DIR, info.stored);
  return fs.existsSync(file) ? file : null;
}

export async function saveResume(file: File): Promise<ResumeFileInfo> {
  if (!RESUME_TYPES.test(file.name)) throw new Error("Use a PDF, DOC, DOCX, TXT, RTF or ODT file.");
  if (file.size > MAX_RESUME_BYTES) throw new Error("File too large (max 10MB).");
  const safeName = path.basename(file.name).replace(/[^\w.\- ()]+/g, "_").slice(-120) || "resume.pdf";
  const folder = `resume-${Date.now()}`;
  fs.mkdirSync(path.join(FILES_DIR, folder), { recursive: true });
  fs.writeFileSync(path.join(FILES_DIR, folder, safeName), Buffer.from(await file.arrayBuffer()));
  deleteResume();
  const info = { fileName: safeName, size: file.size, uploadedAt: Date.now(), stored: path.join(folder, safeName) };
  setSetting(RESUME_KEY, info);
  return { fileName: info.fileName, size: info.size, uploadedAt: info.uploadedAt };
}

export function deleteResume(): void {
  const info = getSetting<{ stored: string }>(RESUME_KEY);
  if (!info) return;
  const folder = path.join(FILES_DIR, path.dirname(info.stored));
  if (folder.startsWith(FILES_DIR) && folder !== FILES_DIR) fs.rmSync(folder, { recursive: true, force: true });
  setSetting(RESUME_KEY, null);
}

const LABELS: Record<keyof ApplicantProfile, string> = {
  firstName: "First name",
  lastName: "Last name",
  preferredName: "Preferred name",
  email: "Email",
  phone: "Phone",
  city: "City",
  region: "State/region",
  country: "Country",
  postalCode: "Postal code",
  address: "Address",
  linkedinUrl: "LinkedIn",
  githubUrl: "GitHub",
  websiteUrl: "Website",
  currentCompany: "Current company",
  currentTitle: "Current title",
  yearsOfExperience: "Years of experience",
  workAuthorization: "Work authorization",
  needsSponsorship: "Needs visa sponsorship",
  willingToRelocate: "Willing to relocate",
  noticePeriod: "Notice period",
  salaryExpectation: "Salary expectation",
  earliestStartDate: "Earliest start date",
  pronouns: "Pronouns",
  gender: "Gender (self-ID)",
  ethnicity: "Race/ethnicity (self-ID)",
  veteranStatus: "Veteran status (self-ID)",
  disabilityStatus: "Disability status (self-ID)",
  notes: "Other notes",
};

/** The profile as lines for the system prompt (set fields only). */
export function profileSummary(): string {
  const profile = getApplicantProfile();
  const lines = APPLICANT_PROFILE_FIELDS.filter((key) => profile[key]).map((key) => `- ${LABELS[key]}: ${profile[key]}`);
  const resume = getResumeInfo();
  lines.push(resume ? `- Resume file: ${resume.fileName} (attached to applications automatically)` : "- Resume file: none uploaded yet");
  return lines.join("\n");
}
