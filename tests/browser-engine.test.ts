import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { serveFixtures, testEnvironment } from "./helpers";

const resumePath = testEnvironment();

type Engine = {
  session: typeof import("@/lib/browser/session");
  scan: typeof import("@/lib/browser/scan");
  flow: typeof import("@/lib/browser/flow");
  fill: typeof import("@/lib/browser/fill");
  match: typeof import("@/lib/browser/match");
  browse: typeof import("@/lib/browser/browse");
};
let engine: Engine;
let site: { origin: string; close: () => Promise<void> };
let frameSite: { origin: string; close: () => Promise<void> };

before(async () => {
  engine = {
    session: await import("@/lib/browser/session"),
    scan: await import("@/lib/browser/scan"),
    flow: await import("@/lib/browser/flow"),
    fill: await import("@/lib/browser/fill"),
    match: await import("@/lib/browser/match"),
    browse: await import("@/lib/browser/browse"),
  };
  // localhost vs 127.0.0.1 makes the embedded form cross-origin.
  frameSite = await serveFixtures();
  site = await serveFixtures(frameSite.origin.replace("127.0.0.1", "localhost"));
});

after(async () => {
  await engine.session.closeBrowser();
  await site.close();
  await frameSite.close();
});

const profile = () => ({
  ...engine.match.DECLINE && {},
  firstName: "Asha", lastName: "Rao", preferredName: "", email: "asha@example.com", phone: "+1 415 555 0134",
  city: "Bengaluru", region: "Karnataka", country: "India", postalCode: "", address: "",
  linkedinUrl: "https://www.linkedin.com/in/asha-rao", githubUrl: "https://github.com/asha", websiteUrl: "",
  currentCompany: "Initech", currentTitle: "Backend Engineer", yearsOfExperience: "6", workAuthorization: "",
  needsSponsorship: "yes", willingToRelocate: "", noticePeriod: "", salaryExpectation: "", earliestStartDate: "",
  pronouns: "", gender: "", ethnicity: "", veteranStatus: "", disabilityStatus: "", notes: "",
});

async function page(key: string) {
  const opened = await engine.session.pageFor(key);
  assert.ok(opened);
  return opened.page;
}

/** Fill everything the profile can answer; returns the results. */
async function autofill(p: import("playwright-core").Page) {
  const scan = await engine.scan.scanPage(p);
  const answers = new Map<string, string>();
  for (const field of scan.fields) {
    if (field.filled) continue;
    const value = engine.match.profileAnswer(field, profile());
    if (value) answers.set(field.key, value);
  }
  return engine.flow.fillAnswers(p, scan, answers, { resumePath });
}

const byLabel = (scan: import("@/lib/browser/scan").PageScan, pattern: RegExp) => {
  const field = scan.fields.find((candidate) => pattern.test(candidate.label));
  assert.ok(field, `no field labelled ${pattern} in: ${scan.fields.map((f) => f.label).join(" / ")}`);
  return field;
};

test("greenhouse-style: labels, hidden resume input, comboboxes, EEO decline, honeypot, submit", async () => {
  const p = await page("gh");
  const { scan } = await engine.flow.openForm(p, `${site.origin}/greenhouse.html`, "gh");
  const labels = scan.fields.map((field) => field.label);
  assert.ok(!labels.some((label) => /website confirm/i.test(label)), "honeypot must be ignored");
  assert.equal(byLabel(scan, /^First Name$/).required, true);
  assert.equal(byLabel(scan, /^Resume\/CV$/).kind, "file");
  assert.equal(byLabel(scan, /authorized to work/).kind, "combobox");

  const results = await autofill(p);
  const failed = results.filter((result) => !result.ok);
  assert.deepEqual(failed, [], JSON.stringify(failed));

  let now = await engine.scan.scanPage(p);
  assert.equal(byLabel(now, /^Location \(City\)$/).value, "Bengaluru, Karnataka, India");
  assert.equal(byLabel(now, /^Gender$/).value, "Decline To Self Identify");
  assert.equal(byLabel(now, /^Veteran Status$/).value, "I don't wish to answer");
  assert.equal(byLabel(now, /^Referrer email$/).filled, false, "someone else's email stays empty");

  const auth = byLabel(now, /authorized to work/);
  const why = byLabel(now, /Why do you want/);
  const consent = byLabel(now, /privacy policy/);
  const more = await engine.flow.fillAnswers(p, now, new Map([[auth.key, "No"], [why.key, "I like Acme."], [consent.key, "yes"]]), { resumePath });
  assert.ok(more.every((result) => result.ok), JSON.stringify(more));
  now = await engine.scan.scanPage(p);
  assert.equal(byLabel(now, /authorized to work/).value, "No");
  assert.deepEqual(engine.flow.missingRequired(now).map((f) => f.label), []);

  const submit = engine.flow.findSubmitButton(now);
  assert.equal(submit?.text, "Submit application");
  const outcome = await engine.flow.submitForm(p, now, submit!, "gh");
  assert.equal(outcome.kind, "submitted", JSON.stringify(outcome.kind === "errors" ? outcome.errors : outcome.kind));
});

test("listing page → Apply link → lever-style form with div labels, radios, checkboxes, ranges", async () => {
  const p = await page("lever");
  const { scan } = await engine.flow.openForm(p, `${site.origin}/listing.html`, "lever");
  assert.ok(scan.url.endsWith("/lever.html"), scan.url);
  assert.equal(byLabel(scan, /^Full name$/).required, true);
  const sponsor = byLabel(scan, /visa sponsorship/);
  assert.equal(sponsor.kind, "radio");
  assert.deepEqual(sponsor.options?.map((o) => o.label), ["Yes, I will require sponsorship", "No, I will not"]);
  const offices = byLabel(scan, /Which offices/);
  assert.equal(offices.kind, "checkboxes");
  const years = byLabel(scan, /Years of professional/);

  const results = await autofill(p);
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const answers = new Map([[sponsor.key, "yes"], [offices.key, "Bangalore; Remote"], [years.key, "6"]]);
  const more = await engine.flow.fillAnswers(p, await engine.scan.scanPage(p), answers, { resumePath });
  assert.ok(more.every((result) => result.ok), JSON.stringify(more));
  const now = await engine.scan.scanPage(p);
  assert.equal(byLabel(now, /^Full name$/).value, "Asha Rao");
  assert.equal(byLabel(now, /^Current company$/).value, "Initech");
  assert.equal(byLabel(now, /^GitHub URL$/).value, "https://github.com/asha");
  assert.equal(byLabel(now, /visa sponsorship/).value, "Yes, I will require sponsorship");
  assert.equal(byLabel(now, /Which offices/).value, "Bangalore; Remote");
  assert.equal(byLabel(now, /Years of professional/).value, "6-10 years");
  const outcome = await engine.flow.submitForm(p, now, engine.flow.findSubmitButton(now)!, "lever");
  assert.equal(outcome.kind, "submitted");
});

test("form inside a cross-origin iframe", async () => {
  const p = await page("embed");
  const { scan } = await engine.flow.openForm(p, `${site.origin}/company-embed.html`, "embed");
  const first = byLabel(scan, /^First Name$/);
  assert.notEqual(first.frame, p.mainFrame());
  const results = await autofill(p);
  assert.ok(results.length >= 5 && results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(engine.flow.detectAts(p), null);
});

test("Apply opens a new tab; yes/no buttons reveal a follow-up question; ids survive re-renders", async () => {
  const p = await page("ashby");
  const opened = await engine.flow.openForm(p, `${site.origin}/listing-popup.html`, "ashby");
  assert.ok(opened.page.url().endsWith("/ashby.html"));
  assert.equal(engine.session.livePage("ashby"), opened.page);
  const name = byLabel(opened.scan, /^Name$/);
  const visa = byLabel(opened.scan, /visa sponsorship/);
  assert.equal(visa.kind, "radio");
  let results = await engine.flow.fillAnswers(opened.page, opened.scan, new Map([[name.key, "Asha Rao"], [visa.key, "Yes"]]), { resumePath });
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const now = await engine.scan.scanPage(opened.page);
  assert.equal(byLabel(now, /^Name$/).key, name.key, "same id after re-render");
  assert.equal(byLabel(now, /^Name$/).value, "Asha Rao");
  assert.equal(byLabel(now, /visa sponsorship/).value, "Yes");
  const followUp = byLabel(now, /Which visa/);
  results = await engine.flow.fillAnswers(opened.page, now, new Map([[followUp.key, "H-1B"]]), { resumePath });
  assert.ok(results[0].ok);
});

test("workday-style: listbox button, masked phone, multi-step Next, review, submit", async () => {
  const p = await page("wd");
  let { scan } = await engine.flow.openForm(p, `${site.origin}/workday.html`, "wd");
  const country = byLabel(scan, /^Country$/);
  assert.equal(country.kind, "combobox");
  const results = await engine.flow.fillAnswers(p, scan, new Map([[country.key, "United States"]]), { resumePath });
  assert.ok(results[0].ok, JSON.stringify(results));
  assert.equal(results[0].value, "United States of America");
  const auto = await autofill(p);
  assert.ok(auto.every((result) => result.ok), JSON.stringify(auto));
  scan = await engine.scan.scanPage(p);
  assert.equal(byLabel(scan, /^Phone Number$/).value, "(415) 555-0134");
  assert.equal(engine.flow.findSubmitButton(scan), null);
  const next = engine.flow.findNextButton(scan);
  assert.equal(next?.text, "Save and Continue");
  await engine.flow.clickButton(p, next!, "wd");
  scan = await engine.flow.waitForChange(p, scan);
  const sponsor = byLabel(scan, /require sponsorship/);
  const source = byLabel(scan, /How Did You Hear/);
  const step2 = await engine.flow.fillAnswers(p, scan, new Map([[sponsor.key, "No"], [source.key, "Company website"]]), { resumePath });
  assert.ok(step2.every((result) => result.ok), JSON.stringify(step2));
  scan = await engine.scan.scanPage(p);
  await engine.flow.clickButton(p, engine.flow.findNextButton(scan)!, "wd");
  scan = await engine.flow.waitForChange(p, scan);
  assert.match(scan.text + scan.buttons.map((b) => b.text).join(" "), /Submit/);
  const submit = engine.flow.findSubmitButton(scan);
  assert.ok(submit);
  const outcome = await engine.flow.submitForm(p, scan, submit, "wd");
  assert.equal(outcome.kind, "submitted");
});

test("sign-in pages and CAPTCHAs are handed to the user", async () => {
  const p = await page("login");
  const { scan } = await engine.flow.openForm(p, `${site.origin}/login.html`, "login");
  assert.match(engine.flow.blocker(scan) ?? "", /Sign in/);
  assert.ok(!scan.fields.some((field) => /password/i.test(field.label)), "passwords are never fields");

  const c = await page("captcha");
  const opened = await engine.flow.openForm(c, `${site.origin}/captcha.html`, "captcha");
  await engine.flow.fillAnswers(c, opened.scan, new Map([[byLabel(opened.scan, /Full name/).key, "Asha"], [byLabel(opened.scan, /Email/).key, "a@b.co"]]), { resumePath });
  const now = await engine.scan.scanPage(c);
  const outcome = await engine.flow.submitForm(c, now, engine.flow.findSubmitButton(now)!, "captcha");
  assert.equal(outcome.kind, "needs_user");
});

test("blocked sites and URL shapes", () => {
  assert.equal(engine.flow.blockedSite("https://www.linkedin.com/jobs/view/1"), "LinkedIn");
  assert.equal(engine.flow.blockedSite("https://in.indeed.com/viewjob?jk=1"), "Indeed");
  assert.equal(engine.flow.blockedSite("https://boards.greenhouse.io/acme/jobs/1"), null);
  assert.equal(
    engine.flow.applicationUrl("https://jobs.lever.co/acme/0f6f3f3e-1111-2222-3333-444455556666"),
    "https://jobs.lever.co/acme/0f6f3f3e-1111-2222-3333-444455556666/apply",
  );
  assert.equal(
    engine.flow.applicationUrl("https://jobs.ashbyhq.com/acme/0f6f3f3e-1111-2222-3333-444455556666/"),
    "https://jobs.ashbyhq.com/acme/0f6f3f3e-1111-2222-3333-444455556666/application",
  );
});

test("browsing: snapshot ids, risky clicks need approval, fill and click", async () => {
  const snap = await engine.browse.browseOpen(`${site.origin}/browse.html`);
  const order = snap.elements.find((element) => element.label === "Place order");
  const details = snap.elements.find((element) => element.label === "Show details");
  const careers = snap.elements.find((element) => element.label === "Careers");
  const coupon = snap.elements.find((element) => element.label === "Coupon");
  assert.ok(order && details && careers && coupon);
  assert.equal(engine.browse.actNeedsApproval({ id: order.id, action: "click" }), true);
  assert.equal(engine.browse.actNeedsApproval({ id: details.id, action: "click" }), false);
  assert.equal(engine.browse.actNeedsApproval({ id: careers.id, action: "click" }), false);
  assert.equal(engine.browse.actNeedsApproval({ id: coupon.id, action: "press", value: "Enter" }), true);
  const filled = await engine.browse.browseAct({ id: coupon.id, action: "fill", value: "SAVE10" });
  assert.match(filled.did, /SAVE10/);
  const next = await engine.browse.browseAct({ id: filled.elements.find((e) => e.label === "Careers")!.id, action: "click" });
  assert.ok(next.url.endsWith("/lever.html"));
});

test("field ids don't change when errors, counters or an attached file appear", async () => {
  const p = await page("errors");
  const { scan } = await engine.flow.openForm(p, `${site.origin}/errors.html`, "errors");
  const before = scan.fields.map((field) => `${field.key}:${field.label}`);
  const submit = engine.flow.findSubmitButton(scan)!;
  const outcome = await engine.flow.submitForm(p, scan, submit, "errors");
  assert.equal(outcome.kind, "errors");
  assert.ok(outcome.scan.errors.some((error) => /required|valid email/.test(error)), JSON.stringify(outcome.scan.errors));
  assert.deepEqual(outcome.scan.fields.map((field) => `${field.key}:${field.label}`), before);

  const gh = await page("gh-file");
  const opened = await engine.flow.openForm(gh, `${site.origin}/greenhouse.html`, "gh-file");
  const resume = byLabel(opened.scan, /^Resume\/CV$/);
  const result = await engine.fill.fillField(gh, resume, engine.match.RESUME, { resumePath });
  assert.ok(result.ok, String(result.error));
  const after = byLabel(await engine.scan.scanPage(gh), /^Resume\/CV$/);
  assert.equal(after.key, resume.key);
  assert.equal(after.label, "Resume/CV");
});
