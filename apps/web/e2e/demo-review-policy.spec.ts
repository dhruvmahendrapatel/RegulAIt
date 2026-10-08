/**
 * ADR-0168 amendment (afternoon) — the review policy, end to end, against a
 * REAL gateway on a `demo:prepare` database (playwright.demo-real.config.ts).
 * Every seam the web was first coded against mocks for is exercised here:
 *
 *   1. an admin (Ada) sets the review policy on its settings page: two roles,
 *      Security = Avery and Privacy = Dana, both required for the high tier,
 *      with a 12-month approval lifetime; Avery may accept risk;
 *   2. Ada registers a high-tier use case through the wizard — every Classify
 *      answer is persisted with it (`screeningAnswers`);
 *   3. Avery and Dana each see their own review; Dana sends it back, which
 *      closes Avery's review ("Closed — another review ended the round");
 *   4. Ada resubmits from the resubmit screen (prefilled, one answer changed);
 *   5. a new round with two reviews: Avery approves accepting a risk, Dana
 *      approves → approved, valid for the policy's 12 months.
 *
 * The proposer is a fresh admin fixture: another journey's outstanding draft
 * saves cannot arrive under this person's identity. The org review policy is
 * put back exactly as found, and the fixture is deactivated afterward.
 */
import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { passTotp, reprovisionTotp } from "./totp-sign-in";
import { PERSONA_EMAIL, preparedCredentials, signInPrepared, steppedUpAs } from "./demo-credentials";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3105";
const BOOT_TOKEN = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "e2e-bootstrap-token";
const BOOT = { authorization: `Bearer ${BOOT_TOKEN}`, "content-type": "application/json" };
const RUN = randomUUID();
const NAME = `Credit-limit assistant (policy run ${RUN})`;
const ADMIN_EMAIL = `policy-${RUN}@example.test`;
const ADMIN_NAME = "Ada Admin";

type Json = Record<string, any>;
const api = async (path: string, init: RequestInit = {}): Promise<Json> => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...BOOT, ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  expect(res.ok, `${init.method ?? "GET"} ${path} → ${res.status} ${JSON.stringify(body)}`).toBe(true);
  return body as Json;
};

const LANDING = (page: Page) =>
  page.getByRole("heading", { name: /Welcome back/ }).or(page.getByRole("region", { name: "AI policy acknowledgement" }));

/**
 * B4S-06: a one-time password for `id`. Issuing someone else's password is a
 * settings_relax step-up; the bootstrap credential gives it only while no admin
 * can step up. With demo:prepare's printed credentials, Ada issues it, stepped
 * up with her authenticator (in a page of her own); without them, the
 * bootstrap path (first-admin setup only).
 */
async function oneTimePassword(browser: Browser | null, id: string): Promise<string> {
  if (browser && preparedCredentials()) {
    const ada = await browser.newPage();
    try {
      expect(await signInPrepared(ada, PERSONA_EMAIL.admin, "E2e-Demo-Intake!", LANDING(ada)), "Ada signs in").toBe(true);
      const r = await steppedUpAs(ada.request, PERSONA_EMAIL.admin, "POST", `${BASE}/v1/users/${id}/set-initial-password`, { force: true });
      expect(r.status(), `one-time password: ${await r.text()}`).toBe(200);
      return ((await r.json()) as { password: string }).password;
    } finally {
      await ada.close();
    }
  }
  return ((await api(`/v1/users/${id}/set-initial-password`, { method: "POST", body: JSON.stringify({ force: true }) })) as { password: string }).password;
}

async function signIn(page: Page, email: string, password: string, browser: Browser | null = null) {
  // B4S-06: a seeded persona signs in with the credentials demo:prepare printed
  if (Object.values(PERSONA_EMAIL).includes(email as never) && (await signInPrepared(page, email, password, LANDING(page)))) return;
  const users = (await api("/v1/users")) as { users: Array<{ id: string; email: string }> };
  const id = users.users.find((user) => user.email === email)?.id;
  expect(id, `journey persona ${email} must exist`).toBeTruthy();
  // ADR-0181 (FX2): the seed enrolled the admin's TOTP outside this run; re-provision it
  if (!preparedCredentials()) await reprovisionTotp(BASE, BOOT, email);
  const minted = { password: await oneTimePassword(browser, id!) };
  await page.goto("/ui");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // ADR-0181: an admin who already enrolled answers the TOTP challenge first
  await passTotp(page, email, page.getByLabel("Current (one-time) password"));
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password & continue" }).click();
  // ...and an admin who has not enrols now, from the secret on screen
  // A new fixture has not acknowledged the required AI policy yet. That
  // authenticated interstitial replaces Home; the journey acknowledges it
  // below before entering the governed intake, without relaxing the gate.
  await passTotp(page, email, LANDING(page));
}

async function persona(browser: Browser, email: string, password: string) {
  const page = await browser.newPage();
  await signIn(page, email, password, browser);
  return page;
}

/** open this run's review in a persona's inbox */
async function openReview(page: Page) {
  await page.goto("/ui/inbox");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await page.getByRole("button", { name: `Review sign-off for ${NAME}` }).click();
  const drawer = page.getByRole("dialog", { name: "Review use case sign-off" });
  await expect(drawer).toBeVisible();
  return drawer;
}

const detailOf = (id: string) => api(`/v1/use-cases/${id}`);
const reviewsOf = async (id: string) =>
  ((await detailOf(id)).reviews as Array<{ roleId: string; status: string; deciderName: string | null }>)
    .map((r) => [r.roleId, r.status, r.deciderName])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

let originalPolicy: Json | null = null;
let adminFixtureId: string | null = null;

/**
 * B4S round 3: creating an account that is already an admin is a
 * settings_relax step-up (as granting admin is). With demo:prepare's printed
 * credentials, Ada creates the fixture admin, stepped up with her
 * authenticator (in a page of her own); without them, the bootstrap path
 * (first-admin setup only).
 */
async function createFixtureAdmin(browser: Browser): Promise<string> {
  const body = { email: ADMIN_EMAIL, displayName: ADMIN_NAME, isAdmin: true };
  if (preparedCredentials()) {
    const ada = await browser.newPage();
    try {
      expect(await signInPrepared(ada, PERSONA_EMAIL.admin, "E2e-Demo-Intake!", LANDING(ada)), "Ada signs in").toBe(true);
      const r = await steppedUpAs(ada.request, PERSONA_EMAIL.admin, "POST", `${BASE}/v1/users`, body);
      expect(r.status(), `fixture admin: ${await r.text()}`).toBe(201);
      return ((await r.json()) as { id: string }).id;
    } finally {
      await ada.close();
    }
  }
  return (await api("/v1/users", { method: "POST", body: JSON.stringify(body) })).id as string;
}

test.beforeAll(async ({ browser }) => {
  originalPolicy = await api("/v1/governance/review-policy");
  adminFixtureId = await createFixtureAdmin(browser);
});

test.afterAll(async () => {
  try {
    // the review policy is an org singleton: put back exactly what was there
    if (!originalPolicy) return;
    const body = { roles: originalPolicy.roles, tiers: originalPolicy.tiers, riskAcceptorUserIds: originalPolicy.riskAcceptorUserIds };
    // ADR-0182 A11: previewed first, under the strict decision-regression gate
    const run = await api("/v1/governance/decision-regression/preview", {
      method: "POST",
      body: JSON.stringify({ subject: "review_policy", candidate: body }),
    });
    await api("/v1/governance/review-policy", {
      method: "PUT",
      body: JSON.stringify({ ...body, regressionRunId: run.id, acceptChangedOutcomes: true, acceptReason: "demo spec: put the policy back as found" }),
    });
  } finally {
    if (adminFixtureId) {
      await api(`/v1/users/${adminFixtureId}/deactivate`, {
        method: "POST", body: JSON.stringify({ reason: "review-policy journey fixture finished" }),
      });
    }
  }
});

test("review policy: two role reviews, a send-back, a prefilled resubmission and a risk-accepting approval", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const directory = (await api("/v1/users")) as { users: Array<{ id: string; email: string }> };
  const idOf = (email: string) => directory.users.find((u) => u.email === email)!.id;
  const [averyId, danaId] = [idOf("avery@regulait.local"), idOf("dana@regulait.local")];

  // 1. the admin sets the policy on its page
  await signIn(page, ADMIN_EMAIL, "E2e-Policy-Admin!", browser);
  // Same literacy standing as the seeded personas, without relaxing the gate.
  const literacyResponse = await page.request.get(`${BASE}/v1/me/ai-literacy`);
  expect(literacyResponse.ok()).toBe(true);
  const literacy = await literacyResponse.json();
  for (const document of literacy.documents ?? []) {
    if (document.state === "current") continue;
    const acknowledged = await page.request.post(`${BASE}/v1/ai-policies/${document.documentId}/acknowledge`, {
      headers: { "x-regulait-csrf": "1" },
      data: { version: document.version, digest: document.contentDigest },
    });
    expect(acknowledged.ok()).toBe(true);
  }
  await page.goto("/ui/admin/governance/review-policy");
  await expect(page.getByRole("heading", { level: 1, name: "Review policy" })).toBeVisible();
  for (const [role, person] of [["Security", "Avery Approver"], ["Privacy", "Dana Developer"]] as const) {
    await page.getByRole("button", { name: "+ Add role" }).click();
    await page.getByLabel("Role name").last().fill(role);
    await page.getByRole("combobox", { name: `Add a person to ${role}` }).selectOption({ label: person });
    await page.getByRole("group", { name: "Required reviews for the high tier" }).getByRole("checkbox", { name: role }).check();
  }
  await expect(page.getByRole("group", { name: "Required reviews for the high tier" })).toContainText("2 required reviews");
  await page.getByLabel("High tier: approval valid for (months)").fill("12");
  await page.getByRole("combobox", { name: "Add a person to risk acceptors" }).selectOption({ label: "Avery Approver" });
  // ADR-0182 A11: the "Preview impact" step shows the golden cases the policy
  // changes (the high tier now needs two reviews); the admin accepts them
  await page.getByRole("button", { name: "Preview impact" }).first().click();
  const impact = page.getByRole("dialog", { name: "Preview impact: the review policy" });
  await expect(impact.getByRole("status").filter({ hasText: /golden cases? changes?/ })).toBeVisible();
  await impact.getByRole("checkbox", { name: /I have reviewed these changed outcomes/ }).check();
  await impact.getByLabel("Why these outcomes should change").fill("High-tier use cases need a security and a privacy review.");
  await impact.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText(/Last changed .* by Ada Admin\./)).toBeVisible();
  const policy = await api("/v1/governance/review-policy");
  expect(policy.roles).toEqual(expect.arrayContaining([
    { id: "security", name: "Security", memberUserIds: [averyId] },
    { id: "privacy", name: "Privacy", memberUserIds: [danaId] },
  ]));
  expect(policy.tiers.high).toEqual({ roleIds: expect.arrayContaining(["security", "privacy"]), validityMonths: 12 });
  expect(policy.riskAcceptorUserIds).toEqual([averyId]);

  // 2. a high-tier registration through the wizard
  await page.goto("/ui/admin/governance/intake");
  const ownDraft = await page.request.get(`${BASE}/v1/use-cases/draft?scope=new`);
  expect(ownDraft.ok()).toBe(true);
  expect((await ownDraft.json()).draft).toBeNull();
  await expect(page.getByRole("button", { name: "Resume your draft" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("x17-owned-intake-fixture.png") });
  await page.getByRole("button", { name: "Fill in an example" }).click();
  await page.getByLabel("Use-case name").fill(NAME);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await expect(page.getByText(/Proposed tier:/)).toContainText("high");
  await page.getByRole("button", { name: /Accept all remaining/ }).click();
  for (let step = 0; step < 3; step += 1) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Submit for human review" }).click();
  await expect(page.getByRole("link", { name: "Open the use-case workspace" })).toBeVisible();
  const listed = (await api("/v1/use-cases")) as { useCases: Array<{ id: string; name: string }> };
  const useCaseId = listed.useCases.find((u) => u.name === NAME)!.id;
  let detail = await detailOf(useCaseId);
  expect(detail.useCase).toMatchObject({ status: "under_review", euAiActTier: "high", dataSensitivity: "regulated" });
  expect(await reviewsOf(useCaseId)).toEqual([["privacy", "pending", null], ["security", "pending", null]]);
  // every Classify answer the wizard collected is stored with the record
  expect(detail.resubmission.screeningAnswers).toEqual({
    purposeDomain: "essential-services",
    affectedPersons: ["customers"],
    decisionAutonomy: "human-reviews",
    biometricUse: "none",
    emotionRecognition: false,
    socialScoring: false,
    manipulativeTechniques: false,
    profilesNaturalPersons: true,
    safetyComponent: false,
    interactsWithHumans: true,
    generatesSyntheticContent: true,
    sectors: ["financial-services"],
    dataCategories: ["personal", "financial"],
    deployment: "customer-facing",
    euNexus: true,
    usesExternalVendor: true,
    generative: true,
    autonomousActions: false,
    toolsUsed: [],
    // ADR-0171: the answers the owner marked "Not sure" (none here)
    unsure: [],
  });

  // 3. both role members see their own review; Dana (Privacy) sends it back
  const avery = await persona(browser, "avery@regulait.local", "E2e-Policy-Avery!");
  const dana = await persona(browser, "dana@regulait.local", "E2e-Policy-Dana!");
  let review = await openReview(avery);
  await expect(review.getByText("Security review", { exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Cancel" }).click();
  review = await openReview(dana);
  await expect(review.getByText("Privacy review", { exact: true })).toBeVisible();
  await expect(review.getByRole("list", { name: "Other reviews" }).getByRole("listitem").filter({ hasText: "Security" })).toContainText("Awaiting decision");
  await review.getByRole("radio", { name: "Send back for information" }).check();
  await review.getByLabel("What information is missing (required)").fill("Say whether autonomous actions are in scope and attach the DPIA reference.");
  await review.getByRole("button", { name: "Send back" }).click();
  await expect(review).toBeHidden();
  expect(await reviewsOf(useCaseId)).toEqual([["privacy", "returned", "Dana Developer"], ["security", "superseded", null]]);
  expect((await detailOf(useCaseId)).useCase.status).toBe("needs_info");
  // Avery's review closed with the round: gone from her inbox, Closed on the record
  await avery.goto("/ui/inbox");
  await expect(avery.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(avery.getByRole("button", { name: `Review sign-off for ${NAME}` })).toHaveCount(0);
  await page.goto(`/ui/admin/governance/use-cases/${useCaseId}`);
  const tracker = page.locator("section", { has: page.getByText("Lifecycle tracker", { exact: true }) });
  await expect(tracker.getByRole("row").filter({ hasText: "Sign-off: Security" })).toContainText("Closed — another review ended the round");

  // 4. the proposer resubmits, prefilled, changing one answer
  await page.getByRole("link", { name: "Update and resubmit" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Update and resubmit" })).toBeVisible();
  await expect(page.getByRole("note", { name: "Why it was sent back" })).toContainText("attach the DPIA reference");
  await expect(page.getByLabel("Use-case name")).toHaveValue(NAME);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Primary purpose domain")).toHaveValue("essential-services");
  await expect(page.getByLabel("Deployment audience")).toHaveValue("customer-facing");
  await expect(page.getByLabel("Data categories: Financial", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Sectors: Financial services", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Uses an external AI vendor")).toHaveValue("yes");
  await expect(page.getByLabel("Can take autonomous actions")).toHaveValue("no");
  await page.getByLabel("Can take autonomous actions").selectOption("yes");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Update the questionnaire" })).toBeVisible();
  await page.getByLabel("4. Models and agents").fill("A third-party model is in the path. It may file the customer's limit request on its own; DPIA DP-2026-114 covers it.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Review and resubmit" })).toBeVisible();
  await page.getByRole("button", { name: "Resubmit for review" }).click();
  await expect(page).toHaveURL(new RegExp(`/ui/admin/governance/use-cases/${useCaseId}$`));

  detail = await detailOf(useCaseId);
  expect(detail.useCase.status).toBe("under_review");
  expect(detail.resubmission.screeningAnswers).toMatchObject({ autonomousActions: true, usesExternalVendor: true, dataCategories: ["personal", "financial"] });
  // 5. a NEW round: two pending reviews again
  expect(await reviewsOf(useCaseId)).toEqual([["privacy", "pending", null], ["security", "pending", null]]);
  const approvalIds = (detail.reviews as Array<{ approvalId: string }>).map((r) => r.approvalId);

  review = await openReview(avery);
  await review.getByRole("radio", { name: "Approve", exact: true }).check();
  await review.getByRole("checkbox", { name: "Accept residual risk" }).check();
  const riskChoice = review.getByRole("group", { name: "Risks to accept" }).getByRole("checkbox").first();
  const riskTitle = ((await riskChoice.locator("xpath=..").textContent()) ?? "").split(" · ")[0]!.trim();
  await riskChoice.check();
  await review.getByLabel("Why the residual risk is acceptable (required)").fill("A credit officer reviews every recommendation; the DPIA covers the residual bias.");
  await review.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(review).toBeHidden();
  expect(await reviewsOf(useCaseId)).toEqual([["privacy", "pending", null], ["security", "approved", "Avery Approver"]]);
  expect((await detailOf(useCaseId)).useCase.status).toBe("under_review"); // one role still to sign

  review = await openReview(dana);
  await review.getByRole("radio", { name: "Approve", exact: true }).check();
  await review.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(review).toBeHidden();
  await avery.close();
  await dana.close();

  detail = await detailOf(useCaseId);
  expect(detail.useCase.status).toBe("approved");
  expect(new Set((detail.reviews as Array<{ approvalId: string }>).map((r) => r.approvalId))).toEqual(new Set(approvalIds));
  expect(await reviewsOf(useCaseId)).toEqual([["privacy", "approved", "Dana Developer"], ["security", "approved", "Avery Approver"]]);
  // valid for the POLICY's 12 months (the high-tier default would be 6)
  const until = new Date(detail.useCase.approvedAt);
  until.setUTCMonth(until.getUTCMonth() + 12);
  expect(detail.useCase.approvedUntil).toBe(until.toISOString());
  const accepted = (detail.risks as Array<{ title: string; status: string; acceptedByName: string | null; acceptanceRationale: string | null }>)
    .filter((r) => r.status === "accepted");
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({ title: riskTitle, acceptedByName: "Avery Approver", acceptanceRationale: expect.stringContaining("DPIA covers the residual bias") });
});
