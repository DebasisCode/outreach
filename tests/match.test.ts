import assert from "node:assert/strict";
import { test } from "node:test";
import { DECLINE, declineOption, matchOption, parseRange, profileAnswer, RESUME } from "@/lib/browser/match";
import { emptyApplicantProfile } from "@/lib/types";

const pick = (options: string[], wanted: string) => {
  const match = matchOption(options, wanted);
  return match ? options[match.index] : null;
};

test("yes/no answers match long options", () => {
  const options = ["Yes, I will require sponsorship", "No, I will not"];
  assert.equal(pick(options, "No"), "No, I will not");
  assert.equal(pick(options, "yes"), "Yes, I will require sponsorship");
  assert.equal(pick(["None", "No"], "No"), "No");
});

test("numbers land in ranges", () => {
  const options = ["0-2 years", "3-5 years", "6-10 years", "10+ years"];
  assert.equal(pick(options, "6"), "6-10 years");
  assert.equal(pick(options, "4 years"), "3-5 years");
  assert.equal(pick(options, "12"), "10+ years");
  assert.deepEqual(parseRange("Less than 1 year")?.min, 0);
});

test("countries: exact, aliases, shortest wins ties", () => {
  const options = ["United States Minor Outlying Islands", "United States of America", "India", "British Indian Ocean Territory"];
  assert.equal(pick(options, "India"), "India");
  assert.equal(pick(options, "USA"), "United States of America");
  assert.equal(pick(options, "United States"), "United States of America");
});

test("nonsense doesn't match", () => {
  assert.equal(pick(["Male", "Female"], "Banana"), null);
});

test("decline options", () => {
  assert.equal(declineOption(["Male", "Female", "Decline To Self Identify"]), 2);
  assert.equal(declineOption(["Yes", "No", "I don't wish to answer"]), 2);
  assert.equal(declineOption(["Yes", "No"]), -1);
});

test("profile answers only certain fields", () => {
  const profile = { ...emptyApplicantProfile(), firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "+91 98765 43210", linkedinUrl: "https://linkedin.com/in/asha", city: "Bengaluru", region: "Karnataka", country: "India", currentCompany: "Initech" };
  const answer = (label: string, kind = "text", extra: Record<string, string> = {}) => profileAnswer({ label, kind, ...extra }, profile);
  assert.equal(answer("First Name"), "Asha");
  assert.equal(answer("Last Name"), "Rao");
  assert.equal(answer("Full name"), "Asha Rao");
  assert.equal(answer("Email"), "asha@example.com");
  assert.equal(answer("Referrer email"), null);
  assert.equal(answer("Hiring manager name"), null);
  assert.equal(answer("Company name"), null);
  assert.equal(answer("Current company"), "Initech");
  assert.equal(answer("Phone"), "+91 98765 43210");
  assert.equal(answer("Phone country code", "select"), null);
  assert.equal(answer("LinkedIn Profile"), "https://linkedin.com/in/asha");
  assert.equal(answer("Location (City)", "combobox"), "Bengaluru, Karnataka, India");
  assert.equal(answer("Location", "combobox"), "Bengaluru, Karnataka, India");
  assert.equal(answer("Country", "select"), "India");
  assert.equal(answer("Resume/CV", "file"), RESUME);
  assert.equal(answer("Cover letter", "file"), null);
  assert.equal(answer("Gender", "select"), DECLINE);
  assert.equal(answer("Are you a protected veteran?", "radio"), DECLINE);
  assert.equal(answer("Why do you want to work here?", "textarea"), null);
  assert.equal(answer("Will you require sponsorship?", "radio"), null);
  assert.equal(answer("", "text", { autocomplete: "given-name" }), "Asha");
});
