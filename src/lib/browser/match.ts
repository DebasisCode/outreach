import type { ApplicantProfile } from "@/lib/types";

/**
 * Text matching for form filling — no browser, so it is easy to test.
 *  - matchOption: pick the option a value means ("No" -> "No, I will not
 *    require sponsorship", "6" -> "5-10 years", "USA" -> "United States").
 *  - profileAnswer: answers for fields whose meaning is certain (name, email,
 *    phone, links, location, resume, voluntary self-ID). Everything that needs
 *    judgment (sponsorship, salary, "why us?") is left to the assistant.
 */

/** Value meaning "pick the form's decline-to-answer option". */
export const DECLINE = "__decline__";
/** Value meaning "upload the resume file from the Applicant profile". */
export const RESUME = "__resume__";

const ALIASES: Record<string, string> = {
  us: "united states",
  usa: "united states",
  "u s": "united states",
  "u s a": "united states",
  "united states of america": "united states",
  america: "united states",
  uk: "united kingdom",
  "u k": "united kingdom",
  "great britain": "united kingdom",
  uae: "united arab emirates",
};

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim();
}

const canonical = (text: string) => {
  const n = normalize(text);
  return ALIASES[n] ?? n;
};

const YES = new Set(["yes", "y", "true", "1", "checked", "agree", "i agree", "accept", "on", "yep"]);
const NO = new Set(["no", "n", "false", "0", "unchecked", "disagree", "off", "nope"]);

/** "yes" / "true" / "I agree" -> true; "no" / "false" -> false; anything else -> null. */
export function parseBoolean(value: string): boolean | null {
  const n = normalize(value);
  if (YES.has(n)) return true;
  if (NO.has(n)) return false;
  return null;
}

/** The yes/no an option starts with: "No, I will not require…" -> false. */
function optionBoolean(option: string): boolean | null {
  const first = normalize(option).split(" ")[0] ?? "";
  if (first === "yes") return true;
  if (first === "no") return false;
  return null;
}

const tokens = (text: string) => normalize(text).split(" ").filter(Boolean);

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = new Set(a.filter((token) => setB.has(token))).size;
  return (2 * shared) / (new Set(a).size + setB.size);
}

/** "3-5 years" -> [3,5]; "10+" -> [10,∞); "Less than 1 year" -> [0,1). */
export function parseRange(text: string): { min: number; max: number } | null {
  const t = text.toLowerCase().replace(/,/g, "");
  let m = t.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:\+|or more|and above|and over|plus)/) ?? t.match(/(?:more than|over|above)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: Number(m[1]), max: Number.POSITIVE_INFINITY };
  m = t.match(/(?:less than|under|fewer than|below|<)\s*(\d+(?:\.\d+)?)/);
  if (m) return { min: 0, max: Number(m[1]) - 1e-9 };
  m = t.match(/^\s*(\d+(?:\.\d+)?)\s*(?:years?|yrs?)?\s*$/);
  if (m) return { min: Number(m[1]), max: Number(m[1]) };
  return null;
}

/**
 * The option that `wanted` means, or null when nothing is close enough.
 * Ties go to the shorter option ("United States" over "United States Minor
 * Outlying Islands").
 */
export function matchOption(options: string[], wanted: string): { index: number; score: number } | null {
  const w = canonical(wanted);
  if (!w) return null;
  const wantBool = parseBoolean(wanted);
  const wantNumber = /^\s*\d+(\.\d+)?\s*(\+)?\s*(years?|yrs?)?\s*$/i.test(wanted) ? parseFloat(wanted) : null;
  const wStripped = canonical(wanted.replace(/\(.*?\)/g, " "));
  let best = { index: -1, score: 0 };
  const consider = (index: number, score: number) => {
    if (score > best.score) best = { index, score };
  };

  options.forEach((option, index) => {
    const o = canonical(option);
    if (!o) return;
    const lengthPenalty = Math.min(0.05, Math.abs(o.length - w.length) * 0.001);
    if (o === w) return consider(index, 1);
    const oStripped = canonical(option.replace(/\(.*?\)/g, " "));
    if (oStripped && oStripped === wStripped) consider(index, 0.95);
    if (wantBool !== null && optionBoolean(option) === wantBool) consider(index, 0.9 - lengthPenalty);
    if (wantNumber !== null) {
      const range = parseRange(option);
      if (range && wantNumber >= range.min && wantNumber <= range.max) consider(index, 0.85);
    }
    if (o.startsWith(`${w} `) || w.startsWith(`${o} `)) consider(index, 0.8 - lengthPenalty);
    else if (` ${o} `.includes(` ${w} `) || ` ${w} `.includes(` ${o} `)) consider(index, 0.7 - lengthPenalty);
    consider(index, 0.65 * dice(tokens(option), tokens(wanted)));
  });
  return best.score >= 0.45 ? best : null;
}

const DECLINE_PATTERN =
  /decline|prefer not|rather not|not (to )?(wish|want)|don.?t (wish|want)|do not (wish|want)|choose not|not (to )?(say|answer|disclose|identify|specify|self.?identify)|undisclosed|no answer/i;

/** Index of a "decline to self-identify" style option, or -1. */
export function declineOption(options: string[]): number {
  return options.findIndex((option) => DECLINE_PATTERN.test(option));
}

/** What the matcher needs to know about a field. */
export interface FieldInfo {
  kind: string;
  label: string;
  name?: string;
  autocomplete?: string;
  inputType?: string;
  placeholder?: string;
}

const CHOICE_KINDS = new Set(["select", "multiselect", "radio", "checkboxes", "combobox"]);
const TEXT_KINDS = new Set(["text", "textarea", "combobox"]);
/** Questions about someone else (a referrer, a manager) or a company. */
const NOT_ME =
  /\b(refer\w*|reference|manager|supervisor|recruiter|emergency|spouse|parent|guardian|school|university|college|hiring|interviewer|contact person|friend|employee)\b/;

const humanize = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-[\].]+/g, " ");

interface Rule {
  test: (text: string, field: FieldInfo, ac: string) => boolean;
  value: (profile: ApplicantProfile, field: FieldInfo) => string | null;
  kinds?: Set<string>;
  /** Run even when the label mentions a company or someone else. */
  allowOthers?: boolean;
}

const orNull = (value: string | undefined | null) => (value?.trim() ? value.trim() : null);
const fullName = (p: ApplicantProfile) => orNull([p.firstName, p.lastName].filter((s) => s.trim()).join(" "));
const location = (p: ApplicantProfile) => orNull([p.city, p.region, p.country].filter((s) => s.trim()).join(", "));
const eeo = (value: string) => orNull(value) ?? DECLINE;

const RULES: Rule[] = [
  {
    kinds: new Set(["file"]),
    test: (text) => /\b(resume|cv|curriculum vitae)\b/.test(text) || !/\b(cover|letter|transcript|portfolio|photo|picture|writing|sample)\b/.test(text),
    value: () => RESUME,
    allowOthers: true,
  },
  // Voluntary self-identification: the profile's answer, else "decline".
  { kinds: CHOICE_KINDS, test: (t) => /\b(gender|sex)\b/.test(t) && !/orientation/.test(t), value: (p) => eeo(p.gender) },
  { kinds: CHOICE_KINDS, test: (t) => /\b(race|ethnicity|ethnic|hispanic|latin[oax])\b/.test(t), value: (p) => eeo(p.ethnicity) },
  { kinds: CHOICE_KINDS, test: (t) => /\bveteran\b/.test(t), value: (p) => eeo(p.veteranStatus) },
  { kinds: CHOICE_KINDS, test: (t) => /\bdisabilit/.test(t), value: (p) => eeo(p.disabilityStatus) },
  { kinds: CHOICE_KINDS, test: (t) => /sexual orientation|transgender|lgbt/.test(t), value: () => DECLINE },
  {
    kinds: TEXT_KINDS,
    test: (t, f, ac) => ac === "email" || f.inputType === "email" || /\be ?mail( address)?\b/.test(t),
    value: (p) => orNull(p.email),
  },
  {
    kinds: TEXT_KINDS,
    test: (t) => /\b(preferred (first )?name|nick ?name|goes by)\b/.test(t),
    value: (p) => orNull(p.preferredName) ?? orNull(p.firstName),
  },
  {
    kinds: TEXT_KINDS,
    test: (t, _f, ac) => ac === "given-name" || /\b(first|given|fore) ?name\b|\bfname\b/.test(t),
    value: (p) => orNull(p.firstName),
  },
  {
    kinds: TEXT_KINDS,
    test: (t, _f, ac) => ac === "family-name" || /\b(last|family|sur) ?name\b|\blname\b/.test(t),
    value: (p) => orNull(p.lastName),
  },
  {
    kinds: TEXT_KINDS,
    test: (t, _f, ac) => ac === "name" || /^(your |full |legal |candidate )?(full )?name$/.test(t) || /^(full|legal) name\b/.test(t),
    value: fullName,
  },
  {
    kinds: TEXT_KINDS,
    test: (t, f, ac) =>
      (ac.startsWith("tel") || f.inputType === "tel" || /\b(phone|mobile|cell|telephone|contact number)\b/.test(t)) &&
      !/\b(country|dial|area) code\b|\bextension\b|\btype\b/.test(t),
    value: (p) => orNull(p.phone),
  },
  { kinds: TEXT_KINDS, test: (t) => /linked ?in/.test(t), value: (p) => orNull(p.linkedinUrl), allowOthers: true },
  { kinds: TEXT_KINDS, test: (t) => /git ?hub/.test(t), value: (p) => orNull(p.githubUrl), allowOthers: true },
  {
    kinds: TEXT_KINDS,
    test: (t) => /\b(website|portfolio|personal (site|url|page)|blog|homepage)\b/.test(t) && !/\b(company|linkedin|github)\b/.test(t),
    value: (p) => orNull(p.websiteUrl),
  },
  {
    kinds: new Set([...TEXT_KINDS]),
    test: (t) => /\bcurrent (company|employer)\b|^(current )?employer$/.test(t),
    value: (p) => orNull(p.currentCompany),
    allowOthers: true,
  },
  {
    kinds: TEXT_KINDS,
    test: (t) => /\bcurrent (job )?(title|role|position|designation)\b/.test(t),
    value: (p) => orNull(p.currentTitle),
  },
  { kinds: new Set([...TEXT_KINDS, ...CHOICE_KINDS]), test: (t) => /\bpronouns?\b/.test(t), value: (p) => orNull(p.pronouns) },
  {
    kinds: new Set([...TEXT_KINDS, "select"]),
    test: (t, _f, ac) => ac === "postal-code" || /\b(zip|postal|post|pin) ?code\b|^zip$/.test(t),
    value: (p) => orNull(p.postalCode),
  },
  {
    kinds: TEXT_KINDS,
    test: (t, _f, ac) => ac === "street-address" || ac === "address-line1" || /^(street |home |mailing )?address( line 1)?$/.test(t),
    value: (p) => orNull(p.address),
  },
  {
    kinds: new Set([...TEXT_KINDS, ...CHOICE_KINDS]),
    test: (t, _f, ac) => ac === "address-level2" || /^(current )?city( of residence)?$|^town$/.test(t),
    value: (p) => orNull(p.city),
  },
  {
    kinds: new Set([...TEXT_KINDS, ...CHOICE_KINDS]),
    test: (t, _f, ac) => ac === "address-level1" || /^(state|province|region|state province|state or province|county)$/.test(t),
    value: (p) => orNull(p.region),
  },
  {
    kinds: new Set([...TEXT_KINDS, ...CHOICE_KINDS]),
    test: (t, _f, ac) =>
      ac === "country" || ac === "country-name" || /^(current )?country( of residence)?$|^country region$|^which country do you (live|reside) in/.test(t),
    value: (p) => orNull(p.country),
  },
  {
    kinds: new Set([...TEXT_KINDS, ...CHOICE_KINDS]),
    test: (t) =>
      /^(current )?location( city)?$|^where are you (currently )?(located|based)\b|^(current|home) (location|city)\b|^location city$/.test(t),
    value: location,
  },
];

/**
 * The profile's answer for a field, when its meaning is certain. Returns
 * DECLINE or RESUME for those special cases, and null when the assistant (or
 * the user) should answer.
 */
export function profileAnswer(field: FieldInfo, profile: ApplicantProfile): string | null {
  const text = normalize(`${field.label || ""}`) || normalize(humanize(field.name ?? "")) || normalize(field.placeholder ?? "");
  const ac = (field.autocomplete ?? "").toLowerCase().split(/\s+/).pop() ?? "";
  if (!text && !ac && field.kind !== "file") return null;
  const aboutOthers = NOT_ME.test(text) || /\bcompany\b/.test(text);
  for (const rule of RULES) {
    if (rule.kinds && !rule.kinds.has(field.kind)) continue;
    if (aboutOthers && !rule.allowOthers) continue;
    if (!rule.test(text, field, ac)) continue;
    return rule.value(profile, field);
  }
  return null;
}
