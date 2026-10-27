/** Keys provided by the user in the UI and sent with every request. */
export interface UserKeys {
  /** LLM provider api key (required for chat). */
  llmApiKey: string;
  /** Which provider the llmApiKey belongs to. */
  llmProvider: "anthropic" | "openai" | "google" | "ollama";
  /** Model id, e.g. claude-sonnet-4-5 or gemma4:31b. */
  llmModel: string;
  /** CleanList key (clapi_...) — required for find-people / enrich tools. */
  cleanlistApiKey: string;
  /** Composio key — required for sending email / connected apps. */
  composioApiKey: string;
  /** Composio user id used for connections (default "default"). */
  composioUserId: string;
}

export interface ToolSettings {
  keys: UserKeys;
}

export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

export const LLM_PROVIDERS = [
  {
    id: "anthropic" as const,
    label: "Anthropic",
    defaultModel: "claude-sonnet-4-5",
    models: [
      "claude-sonnet-4-5",
      "claude-opus-4-6",
      "claude-haiku-4-5",
      "claude-3-7-sonnet-latest",
    ],
    keyHint: "sk-ant-...",
    needsApiKey: true,
  },
  {
    id: "openai" as const,
    label: "OpenAI",
    defaultModel: "gpt-5.2",
    models: ["gpt-5.2", "gpt-5.1", "gpt-5-mini", "gpt-4.1"],
    keyHint: "sk-proj-...",
    needsApiKey: true,
  },
  {
    id: "google" as const,
    label: "Google Gemini",
    defaultModel: "gemini-2.5-pro",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    keyHint: "AIza...",
    needsApiKey: true,
  },
  {
    id: "ollama" as const,
    label: "Ollama Cloud",
    defaultModel: "gpt-oss:120b",
    models: [],
    keyHint: "ollama.com/settings/keys",
    needsApiKey: true,
  },
] as const;

/**
 * Toolkits offered in the Connections dialog — only ones a tool uses.
 * `connect`: "oauth" opens Composio's hosted sign-in; "api_key" takes a key.
 */
export const COMPOSIO_TOOLKITS = [
  {
    slug: "gmail",
    label: "Gmail",
    description: "Send outreach email and save drafts from your Gmail.",
    connect: "oauth",
  },
  {
    slug: "outlook",
    label: "Outlook",
    description: "Send from Outlook instead (Gmail is used if both are connected).",
    connect: "oauth",
  },
  {
    slug: "googlesheets",
    label: "Google Sheets",
    description:
      "Application tracker: jobs you save, people whose email you find and every email you send are logged to a Google Sheet in your Drive.",
    connect: "oauth",
  },
  {
    slug: "serpapi",
    label: "SerpAPI (Google Jobs)",
    description:
      "Optional: worldwide job search via Google Jobs. Without it, job search uses Dice (mostly US tech roles). Free key at serpapi.com.",
    connect: "api_key",
  },
] as const;

export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number];

/** Status column of the tracker's Jobs tab (a dropdown in the sheet). */
export const JOB_STATUSES = [
  "Saved",
  "Emailed",
  "Applied",
  "Replied",
  "Interviewing",
  "Offer",
  "Rejected",
  "Closed",
] as const;

/**
 * What application forms ask about the user: filled in by the user in the
 * Applicant profile dialog (or saved by the assistant), used to fill forms.
 * Empty strings mean "not set". EEO fields left empty are answered with the
 * form's "decline to self-identify" option.
 */
export interface ApplicantProfile {
  firstName: string;
  lastName: string;
  preferredName: string;
  email: string;
  /** With the country code, e.g. "+91 98765 43210". */
  phone: string;
  city: string;
  /** State / province / region. */
  region: string;
  country: string;
  postalCode: string;
  address: string;
  linkedinUrl: string;
  githubUrl: string;
  websiteUrl: string;
  currentCompany: string;
  currentTitle: string;
  yearsOfExperience: string;
  /** e.g. "Indian citizen. Need H-1B sponsorship to work in the US." */
  workAuthorization: string;
  /** "yes" | "no" | "" */
  needsSponsorship: string;
  /** "yes" | "no" | "" */
  willingToRelocate: string;
  noticePeriod: string;
  salaryExpectation: string;
  earliestStartDate: string;
  pronouns: string;
  gender: string;
  ethnicity: string;
  veteranStatus: string;
  disabilityStatus: string;
  /** Anything else forms tend to ask: degree, school, how you heard about jobs… */
  notes: string;
}

export const APPLICANT_PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "preferredName",
  "email",
  "phone",
  "city",
  "region",
  "country",
  "postalCode",
  "address",
  "linkedinUrl",
  "githubUrl",
  "websiteUrl",
  "currentCompany",
  "currentTitle",
  "yearsOfExperience",
  "workAuthorization",
  "needsSponsorship",
  "willingToRelocate",
  "noticePeriod",
  "salaryExpectation",
  "earliestStartDate",
  "pronouns",
  "gender",
  "ethnicity",
  "veteranStatus",
  "disabilityStatus",
  "notes",
] as const satisfies ReadonlyArray<keyof ApplicantProfile>;

export function emptyApplicantProfile(): ApplicantProfile {
  return Object.fromEntries(APPLICANT_PROFILE_FIELDS.map((key) => [key, ""])) as unknown as ApplicantProfile;
}

/** The resume file applications upload (stored under .data/files). */
export interface ResumeFileInfo {
  fileName: string;
  size: number;
  uploadedAt: number;
}
