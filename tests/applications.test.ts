import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { serveFixtures, testEnvironment } from "./helpers";

testEnvironment();

let apps: typeof import("@/lib/applications");
let applicant: typeof import("@/lib/applicant");
let db: typeof import("@/lib/db");
let session: typeof import("@/lib/browser/session");
let site: { origin: string; close: () => Promise<void> };

before(async () => {
  apps = await import("@/lib/applications");
  applicant = await import("@/lib/applicant");
  db = await import("@/lib/db");
  session = await import("@/lib/browser/session");
  site = await serveFixtures();
  applicant.saveApplicantProfile({
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@example.com",
    phone: "+1 415 555 0134",
    city: "Bengaluru",
    region: "Karnataka",
    country: "India",
    linkedinUrl: "https://www.linkedin.com/in/asha-rao",
    currentCompany: "Initech",
  });
  await applicant.saveResume(new File(["%PDF-1.4 resume"], "Asha_Rao_Resume.pdf", { type: "application/pdf" }));
});

after(async () => {
  await session.closeBrowser();
  await site.close();
});

const need = (output: { needs?: Array<{ id: string; label: string }> }, pattern: RegExp) => {
  const field = output.needs?.find((item) => pattern.test(item.label));
  assert.ok(field, `no need matching ${pattern}: ${JSON.stringify(output.needs?.map((n) => n.label))}`);
  return field;
};

test("start → answer → (window closed) → recover → submit → job Applied → no double apply", async () => {
  const job = db.saveJob({ title: "Senior Backend Engineer", company: "Acme", url: `${site.origin}/greenhouse.html` }).job;
  const url = `${site.origin}/greenhouse.html`;
  const started = await apps.startApplication({ url, title: "Senior Backend Engineer", company: "Acme", jobId: job.id });
  assert.equal(started.error, undefined, String(started.error));
  assert.equal(started.status, "needs_answers");
  assert.ok((started.filled_count ?? 0) >= 8, JSON.stringify(started.filled));
  assert.ok(started.filled?.some((f) => f.value === "Asha_Rao_Resume.pdf"), "resume attached under its own name");
  const auth = need(started, /authorized to work/);
  assert.deepEqual((started.needs?.find((n) => n.id === auth.id) as { options?: string[] }).options, ["Yes", "No"], "dropdown options were probed");
  const why = need(started, /Why do you want/);
  const consent = need(started, /privacy policy/);
  assert.ok(started.screenshot_at);

  // The user closes the tab: the next step reopens it and refills the saved answers.
  await session.livePage(started.application_id!)?.close();
  const answered = await apps.answerApplication(started.application_id!, [
    { field_id: auth.id, value: "Yes" },
    { field_id: why.id, value: "Acme's API platform is the kind of backend work I do best." },
    { field_id: consent.id, value: "yes" },
  ]);
  assert.equal(answered.error, undefined, String(answered.error));
  assert.match(answered.note ?? "", /reopened/);
  assert.equal(answered.status, "ready_to_submit", JSON.stringify(answered.needs));
  assert.ok(answered.filled?.some((f) => /First Name/.test(f.label) && f.value === "Asha"));

  const submitted = await apps.submitApplication(started.application_id!);
  assert.equal(submitted.status, "submitted", JSON.stringify(submitted));
  assert.equal(db.getJob(job.id)?.status, "Applied");

  const again = await apps.startApplication({ url });
  assert.equal(again.status, "submitted");
  assert.match(again.note ?? "", /Already applied/);
});

test("multi-page application with Next", async () => {
  const started = await apps.startApplication({ url: `${site.origin}/workday.html`, title: "SWE", company: "Big Co" });
  // The profile's country fills the custom Country dropdown, so page 1 is complete.
  assert.equal(started.status, "next_page", JSON.stringify(started.needs));
  assert.ok(started.filled?.some((f) => f.label === "Country" && f.value === "India"));
  assert.ok(started.filled?.some((f) => f.label === "Phone Number" && f.value === "(415) 555-0134"));
  const step2 = await apps.nextApplicationPage(started.application_id!);
  assert.equal(step2.status, "needs_answers");
  const sponsor = need(step2, /sponsorship/);
  const hear = step2.needs?.find((n) => /Hear About/i.test(n.label));
  const filled = await apps.answerApplication(started.application_id!, [
    { field_id: sponsor.id, value: "No" },
    ...(hear ? [{ field_id: hear.id, value: "LinkedIn" }] : []),
  ]);
  assert.equal(filled.status, "next_page");
  const review = await apps.nextApplicationPage(started.application_id!);
  assert.equal(review.status, "ready_to_submit", JSON.stringify(review));
  const done = await apps.submitApplication(started.application_id!);
  assert.equal(done.status, "submitted");
});

test("blocked sites, bad links and unknown fields are reported, not thrown", async () => {
  const linkedin = await apps.startApplication({ url: "https://www.linkedin.com/jobs/view/123" });
  assert.match(linkedin.error ?? "", /LinkedIn isn't automated/);
  const bad = await apps.startApplication({ url: "not a url" });
  assert.match(bad.error ?? "", /isn't a web link/);
  const started = await apps.startApplication({ url: `${site.origin}/lever.html` });
  const wrong = await apps.answerApplication(started.application_id!, [{ field_id: "fdeadbe", value: "x" }]);
  assert.equal(wrong.problems?.[0]?.id, "fdeadbe");
  const badChoice = await apps.answerApplication(started.application_id!, [
    { field_id: need(started, /visa sponsorship/).id, value: "Maybe later" },
  ]);
  const sponsor = need(badChoice, /visa sponsorship/) as { error?: string };
  assert.match(sponsor.error ?? "", /isn't one of the options/);
  const missing = await apps.answerApplication("nope", []);
  assert.match(missing.error ?? "", /No application/);
});
