/**
 * #453 (owner, 2026-11-07; design thread #743) — the use-case DECISION SUMMARY, against a mocked gateway (the
 * *.mock.spec.ts harness):
 *
 *  - Summary is the record's first tab and its default; every older tab keeps its ?tab= deep link;
 *  - the header's decision panel is status only (no control that decides) and links to the decision records;
 *  - the four figures: risk counts and who accepted residual risk; evidence "Not measured" (no read counts it), never
 *    a number; conditions open, met and blocking; recertification from approvedUntil. A failed read says unavailable;
 *  - the one Next action follows the server's flags: Mark condition met (canMarkMet), else resubmission, else review;
 *  - ACCESS: the record opens to a signed-in non-admin OWNER read only; a non-owner gets the denied card under the
 *    record's heading; a tab that calls an admin-only route says "not available to you";
 *  - a phone width: the tab strip scrolls in its own box and the page never scrolls sideways;
 *  - axe (WCAG 2.x A/AA) in light and dark through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const UC = "5a5a5a5a-1111-4111-8111-111111111111";
const INST = "5a5a5a5a-4444-4444-8444-444444444444";
const AP = "5a5a5a5a-5555-4555-8555-555555555555";
const AGENT = "5a5a5a5a-6666-4666-8666-666666666666";
const C_BIAS = "5a5a5a5a-7777-4777-8777-777777777771";
const C_MON = "5a5a5a5a-7777-4777-8777-777777777772";
const C_DPIA = "5a5a5a5a-7777-4777-8777-777777777773";
const RECORD = `/ui/admin/governance/use-cases/${UC}`;

type Persona = { id: string; isAdmin: boolean; displayName: string };
const ADMIN: Persona = { id: "5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaa1", isAdmin: true, displayName: "Ada Admin" };
const OWNER: Persona = { id: "5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaa2", isAdmin: false, displayName: "Jordan Owner" };
const STRANGER: Persona = { id: "5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaa3", isAdmin: false, displayName: "Sam Stranger" };
const APPROVER = "5a5a5a5a-aaaa-4aaa-8aaa-aaaaaaaaaaa4";

interface MockState {
  me: Persona;
  status: "approved" | "under_review" | "needs_info";
  /** the server's per-viewer flag on the blocking condition */
  canMarkMet: boolean;
  detail: "ok" | "error";
  overview: "ok" | "forbidden" | "missing";
  calls: Array<{ method: string; path: string; body: unknown }>;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const overview = (s: MockState) => ({
  useCase: {
    id: UC, name: "Claims document intake", description: "Reads scanned claim forms and extracts policy and incident details for the claims team.",
    businessContext: "Faster claim handling with a person checking every field.", status: s.status, euAiActTier: "high", ownerName: "Jordan Owner", ownerUserId: OWNER.id,
    workflowInstanceId: INST, complianceTags: ["eu-ai-act", "iso-42001"], dataSensitivity: "confidential", intakeAnswers: { dataCategories: ["personal"] },
    createdAt: "2026-10-21T09:00:00Z", approvedAt: s.status === "approved" ? "2026-11-04T10:00:00Z" : null, approvedUntil: s.status === "approved" ? "2027-05-04T10:00:00Z" : null,
  },
  screening: { tier: "high", reasons: [{ reason: "Access to essential private services." }], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "art", version: 1, submittedAt: "2026-10-21T09:05:00Z" },
  stack: { agents: [{ id: AGENT, name: "Claims extractor", provider: "custom", model: null, lifecycleStatus: "active", halted: false, modelCards: [], modelCardApproved: true }], vendors: [] },
  risks: [
    { id: "r1", title: "Wrong field extracted", category: "reliability", dimension: "reliability", status: "mitigating", inherent: { likelihood: "high", impact: "high" }, residual: { likelihood: "low", impact: "medium" }, controls: [{ controlRef: "ISO42001-A.6.2.4", title: "Verification", linkedAt: "2026-10-22T00:00:00Z" }] },
    { id: "r2", title: "Personal data leaves region", category: "privacy", dimension: "privacy", status: "accepted", inherent: { likelihood: "medium", impact: "high" }, residual: { likelihood: "low", impact: "high" }, controls: [] },
    { id: "r3", title: "Biased outcomes", category: "bias", dimension: "bias", status: "open", inherent: { likelihood: "medium", impact: "high" }, residual: null, controls: [] },
  ],
  summary: { risks: 3, liveRisks: 2, liveWithoutControls: 1, agentsWithoutApprovedModelCard: 0, pendingApprovals: s.status === "under_review" ? 1 : 0 },
  approvals: [
    {
      id: AP, status: s.status === "approved" ? "approved" : s.status === "needs_info" ? "returned" : "pending", stageId: "signoff", approverUserId: APPROVER,
      requestedAt: "2026-10-21T09:05:05Z", decidedAt: s.status === "under_review" ? null : "2026-11-04T10:00:00Z",
      decisionReason: s.status === "approved" ? "Claims staff stay in the loop for every extracted field, and personal data stays in region." : s.status === "needs_info" ? "Attach the data protection assessment." : null,
    },
  ],
  audit: [{ id: 1, at: "2026-11-04T10:00:00Z", userId: APPROVER, ruleId: "use-case-approved", effect: "allow", reason: "approved" }],
  auditTotal: 11,
});

const conditions = (s: MockState) =>
  s.status !== "approved"
    ? []
    : [
        { id: C_BIAS, approvalId: AP, text: "Complete a bias test and attach the results", ownerUserId: "dana", ownerName: "Dana Developer", dueAt: "2026-12-12T00:00:00Z", blocking: true, status: "open", metAt: null, metByName: null, overdue: false, canMarkMet: s.canMarkMet },
        { id: C_MON, approvalId: AP, text: "Agree a production monitoring plan", ownerUserId: OWNER.id, ownerName: "Jordan Owner", dueAt: "2027-01-19T00:00:00Z", blocking: false, status: "open", metAt: null, metByName: null, overdue: false, canMarkMet: false },
        { id: C_DPIA, approvalId: AP, text: "Data protection impact assessment", ownerUserId: ADMIN.id, ownerName: "Ada Admin", dueAt: "2026-11-02T00:00:00Z", blocking: true, status: "met", metAt: "2026-11-02T00:00:00Z", metByName: "Ada Admin", overdue: false, canMarkMet: false },
      ];

async function mockGateway(page: Page, patch: Partial<MockState> = {}): Promise<MockState> {
  const s: MockState = { me: ADMIN, status: "approved", canMarkMet: true, detail: "ok", overview: "ok", calls: [], ...patch };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    s.calls.push({ method: req.method(), path: p, body });
    const me = s.me;
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, via: "session", user: { id: me.id, email: "someone@example.test", displayName: me.displayName }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, user: { id: me.id, email: "someone@example.test", displayName: me.displayName } });
    if (p === `/v1/use-cases/${UC}/overview`) {
      if (s.overview === "forbidden") return json(route, { error: "forbidden", detail: "a use case is visible to its owner and to admins" }, 403);
      if (s.overview === "missing") return json(route, { error: "not_found" }, 404);
      return json(route, overview(s));
    }
    if (p === `/v1/use-cases/${UC}`) {
      if (s.overview === "forbidden") return json(route, { error: "forbidden" }, 403);
      if (s.detail === "error") return json(route, { error: "internal" }, 500);
      return json(route, {
        useCase: { id: UC, status: s.status, ownerUserId: OWNER.id, approvedAt: s.status === "approved" ? "2026-11-04T10:00:00Z" : null, approvedUntil: s.status === "approved" ? "2027-05-04T10:00:00Z" : null, approvalExpired: false, recertification: false },
        conditions: conditions(s),
        reviews: s.status === "approved" ? [
          { roleId: "risk", roleName: "Risk", status: "approved", deciderName: "Avery Approver", decidedAt: "2026-11-04T10:00:00Z", approvalId: AP },
          { roleId: "privacy", roleName: "Privacy", status: "approved", deciderName: "Morgan Reyes", decidedAt: "2026-11-04T09:00:00Z", approvalId: AP },
        ] : [],
        risks: [{ id: "r2", title: "Personal data leaves region", status: "accepted", acceptedByName: "Morgan Reyes", acceptedAt: "2026-11-04T09:00:00Z", acceptanceRationale: "Covered by the regional hosting contract." }],
        resubmission: s.status === "needs_info" ? { allowed: true, screeningAnswers: null, questionnaire: null, returnReason: "Attach the data protection assessment.", returnedByName: "Avery Approver" } : undefined,
        discovery: { findingId: "f1", finding: null },
      });
    }
    if (p === `/v1/use-cases/${UC}/conditions/${C_BIAS}/met` && req.method() === "POST") return json(route, { id: C_BIAS, status: "met" });
    if (p === "/v1/users/directory") return json(route, { users: [{ id: APPROVER, name: "Avery Approver", teams: [] }, { id: OWNER.id, name: "Jordan Owner", teams: [] }] });
    // the admin-only reads a tab of the record calls: refused for a non-admin, as the gateway does (app.ts admin_only)
    if (p === "/v1/inventory/graph" || p === `/v1/agents/${AGENT}/card` || p === "/v1/energy/estimate") {
      if (!me.isAdmin) return json(route, { error: "admin_only" }, 403);
      if (p === "/v1/inventory/graph") return json(route, { nodes: [], edges: [], summary: { nodes: 0, edges: 0, unattachedRisks: 0 } });
    }
    if (p === "/v1/risks/scenarios") return json(route, { scenarios: [], note: "" });
    // signed links ON with one live link, so a write control would show if the tab offered one
    if (p === `/v1/use-cases/${UC}/feedback-links`) return json(route, { enabled: true, links: [{ id: "l1", createdAt: "2026-11-01T09:00:00Z", expiresAt: "2026-11-20T09:00:00Z", uses: 2, maxUses: 50, state: "active" }] });
    return json(route, {});
  });
  return s;
}

const figure = (page: Page, key: string) => page.getByTestId(`figure-${key}`);

test.describe("the decision summary", () => {
  test("Summary is the first tab and the default; the header decision panel is status only", async ({ page }) => {
    await mockGateway(page);
    await page.goto(RECORD);
    const tabs = page.getByRole("tablist", { name: "Use case record sections" }).getByRole("tab");
    await expect(tabs.first()).toHaveText("Summary");
    await expect(tabs).toHaveCount(13);
    await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { level: 1, name: "Claims document intake" })).toBeVisible();

    const panel = page.getByTestId("decision-panel");
    await expect(panel).toContainText("Approved with 3 conditions");
    await expect(panel).toContainText("Avery Approver and Morgan Reyes, 4 Nov 2026");
    await expect(panel).toContainText("2 of 2 required reviews approved");
    // status only: the panel holds a link to the record and no control that decides
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Open the decision records →" })).toHaveAttribute("href", `${RECORD}?tab=decisions`);

    const chips = page.getByRole("list", { name: "Record status" });
    await expect(chips).toContainText("Approved");
    await expect(page.getByTestId("chip-conditions")).toHaveText("2 open conditions · 1 before go-live");
    await expect(chips).toContainText("High tier");
    await expect(chips).toContainText("Approval valid until 4 May 2027");
    await expectAxeClean(page, "decision summary (approved, admin)");
  });

  test("each figure says what it covers; evidence is not measured and never a number", async ({ page }) => {
    await mockGateway(page);
    await page.goto(RECORD);
    await expect(figure(page, "risk")).toContainText("3 risks");
    await expect(figure(page, "risk")).toContainText("residual rated for 2 of 3 after the linked controls · 1 accepted by Morgan Reyes");
    await expect(figure(page, "risk")).toContainText("Scope: The risks registered against this use case");
    await expect(figure(page, "evidence")).toHaveAttribute("data-state", "unmeasured");
    await expect(figure(page, "evidence")).toContainText("Not measured");
    await expect(figure(page, "evidence").locator("p").first()).not.toHaveText(/\d/);
    await expect(figure(page, "evidence").getByRole("link", { name: "Open the audit evidence" })).toHaveAttribute("href", `${RECORD}?tab=audit`);
    await expect(figure(page, "conditions")).toContainText("2 open");
    await expect(figure(page, "conditions")).toContainText("1 of 3 met · 1 blocks go-live (the deploy gate refuses)");
    await expect(figure(page, "recertification")).toContainText("4 May 2027");

    const why = page.locator("[data-rg-card]").filter({ hasText: "Why it was approved" });
    await expect(why).toContainText("The reviewer's recorded reason: Claims staff stay in the loop");
    await expect(why).toContainText("2 of 3 risks have a residual rating");
    await expect(why).toContainText("1 live risk has no linked control");
    const glance = page.locator("[data-rg-card]").filter({ hasText: "At a glance" });
    await expect(glance).toContainText("Jordan Owner");
    await expect(glance).toContainText("Claims extractor");
    await expect(glance).toContainText("EU AI Act");
    await expect(glance).toContainText("21 Oct 2026, from a discovery finding");
    const conds = page.locator("[data-rg-card]").filter({ hasText: "Conditions (2 open)" });
    await expect(conds.getByRole("heading", { name: "Before go-live" })).toBeVisible();
    await expect(conds.getByRole("heading", { name: "After go-live" })).toBeVisible();
    await expect(conds).toContainText("Open · Dana Developer · due 12 Dec 2026");
    await expect(conds).toContainText("Met by Ada Admin, 2 Nov 2026");
  });

  test("a failed detail read makes its figures unavailable, never 0, with a Retry", async ({ page }) => {
    await mockGateway(page, { detail: "error" });
    await page.goto(RECORD);
    await expect(figure(page, "conditions")).toHaveAttribute("data-state", "unavailable");
    await expect(figure(page, "conditions")).toContainText("Unavailable");
    await expect(figure(page, "conditions")).not.toContainText("0 open");
    await expect(figure(page, "recertification")).toHaveAttribute("data-state", "unavailable");
    await expect(figure(page, "risk")).toContainText("who accepted residual risk could not be loaded");
    await expect(page.getByTestId("chip-conditions")).toHaveText("Conditions could not be loaded");
    await expect(page.getByRole("button", { name: "Retry loading the conditions" })).toBeVisible();
    // the next action never guesses a condition it cannot see
    await expect(page.getByTestId("next-action")).toHaveCount(0);
    await expectAxeClean(page, "decision summary (detail read failed)");
  });

  test("Next: an open blocking condition the viewer may close opens the existing Mark condition met flow", async ({ page }) => {
    const s = await mockGateway(page);
    await page.goto(RECORD);
    const next = page.getByTestId("next-action");
    await expect(next).toHaveAttribute("data-kind", "mark-met");
    await expect(next).toContainText("Next: Complete a bias test and attach the results");
    await next.getByRole("button", { name: "Mark condition met: Complete a bias test and attach the results" }).click();
    const dialog = page.getByRole("dialog", { name: "Mark condition met" });
    await dialog.getByRole("button", { name: "Mark met" }).click();
    await expect(dialog).toContainText("Say what was done to meet this condition");
    await dialog.getByLabel("What was done").fill("Bias test run on 400 synthetic claims; results attached.");
    await dialog.getByRole("button", { name: "Mark met" }).click();
    await expect(dialog).toBeHidden();
    expect(s.calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      [`/v1/use-cases/${UC}/conditions/${C_BIAS}/met`, { note: "Bias test run on 400 synthetic claims; results attached." }],
    ]);
  });

  test("Next: never an action the server's flag does not allow", async ({ page }) => {
    await mockGateway(page, { canMarkMet: false });
    await page.goto(RECORD);
    await expect(figure(page, "conditions")).toContainText("2 open");
    await expect(page.getByTestId("next-action")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Mark condition met/ })).toHaveCount(0);
  });

  test("Next: needs information links to the resubmission; under review links to the approvals", async ({ page }) => {
    await mockGateway(page, { status: "needs_info" });
    await page.goto(RECORD);
    const next = page.getByTestId("next-action");
    await expect(next).toHaveAttribute("data-kind", "resubmit");
    await expect(next).toContainText("Attach the data protection assessment.");
    await expect(next.getByRole("link", { name: "Open the update form" })).toHaveAttribute("href", `/ui/admin/governance/intake?resubmit=${UC}`);
    await expect(page.getByTestId("decision-panel")).toContainText("Sent back for information");
    await expect(figure(page, "conditions")).toContainText("None attached");
    await expect(figure(page, "recertification")).toHaveAttribute("data-state", "unmeasured");
    await expect(figure(page, "recertification")).toContainText("No end date");
    await expectAxeClean(page, "decision summary (needs information)");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockGateway(page, { status: "under_review" });
    await page.goto(RECORD);
    await expect(page.getByTestId("next-action")).toHaveAttribute("data-kind", "review");
    await expect(page.getByTestId("decision-panel")).toContainText("Awaiting a decision");
    await page.getByTestId("next-action").getByRole("link", { name: "Open the approvals" }).click();
    await expect(page).toHaveURL(`${RECORD}?tab=approvals`);
    await expect(page.getByRole("tab", { name: /Approvals/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Approval history")).toBeVisible();
  });

  test("deep links to the older tabs keep working", async ({ page }) => {
    await mockGateway(page);
    for (const [tab, name, text] of [
      ["overview", "Overview", "Lifecycle tracker"],
      ["risks", "Risks", "Wrong field extracted"],
      ["approvals", "Approvals", "Approval history"],
      ["audit", "Audit", "Recent use-case audit evidence"],
    ] as const) {
      await page.goto(`${RECORD}?tab=${tab}`);
      await expect(page.getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText(text).first()).toBeVisible();
    }
    // a link from the summary is a real ?tab= link
    await page.goto(RECORD);
    await page.locator("[data-rg-card]").filter({ hasText: "Related" }).getByRole("link", { name: "Risks (3)" }).click();
    await expect(page).toHaveURL(`${RECORD}?tab=risks`);
  });
});

test.describe("access: the record opens to its owner, read only", () => {
  // #745 review (code + security, 2026-11-08): the owner reads the record; no tab offers the owner a write. The same
  // pages as an admin show each control, so a missing control is the gate working, not a page that did not load.
  const WRITES: Array<{ tab: string; ready: RegExp; controls: Array<{ role: "button" | "combobox"; name: RegExp }> }> = [
    { tab: "risks", ready: /Wrong field extracted/, controls: [{ role: "button", name: /^Link control$/ }, { role: "button", name: /^Save residual$/ }, { role: "button", name: /Remove.*ISO42001-A\.6\.2\.4/ }] },
    { tab: "incidents", ready: /EU AI Act role of the organisation/, controls: [{ role: "combobox", name: /EU AI Act role/ }] },
    { tab: "feedback", ready: /Public signed links/, controls: [{ role: "button", name: /^Create link$/ }, { role: "button", name: /^Revoke/ }] },
  ];
  for (const w of WRITES) {
    test(`${w.tab}: an admin has its write controls; the owner reads the tab without them`, async ({ page }) => {
      await mockGateway(page, { me: ADMIN });
      await page.goto(`${RECORD}?tab=${w.tab}`);
      await expect(page.getByText(w.ready).first()).toBeVisible();
      for (const c of w.controls) await expect(page.getByRole(c.role, { name: c.name }).first()).toBeVisible();

      await page.unrouteAll({ behavior: "ignoreErrors" });
      await mockGateway(page, { me: OWNER, canMarkMet: false });
      await page.goto(`${RECORD}?tab=${w.tab}`);
      await expect(page.getByText(w.ready).first()).toBeVisible();
      for (const c of w.controls) await expect(page.getByRole(c.role, { name: c.name })).toHaveCount(0);
    });
  }

  test("stack and audit: the owner gets no write control there either", async ({ page }) => {
    await mockGateway(page, { me: OWNER, canMarkMet: false });
    for (const tab of ["stack", "audit"]) {
      await page.goto(`${RECORD}?tab=${tab}`);
      await expect(page.getByRole("heading", { level: 1, name: "Claims document intake" })).toBeVisible();
      await expect(page.getByRole("tabpanel").getByRole("button", { name: /^(Add|Link|Save|Remove|Revoke|Create|Delete|Edit|Halt|Approve)\b/ })).toHaveCount(0);
    }
  });

  test("a signed-in non-admin owner opens it; admin-only parts say they are not available", async ({ page }) => {
    await mockGateway(page, { me: OWNER, canMarkMet: false });
    await page.goto(RECORD);
    await expect(page.getByRole("heading", { level: 1, name: "Claims document intake" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("You don't have access to this view")).toHaveCount(0);
    // the registry is an admin screen: the owner reads its name, not a link that refuses
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs).toContainText("AI registry");
    await expect(crumbs.getByRole("link")).toHaveCount(0);
    await expect(page.getByTestId("next-action")).toHaveCount(0);
    await expectAxeClean(page, "decision summary (non-admin owner)");

    await page.goto(`${RECORD}?tab=dependencies`);
    await expect(page.getByTestId("not-available-to-you")).toContainText("The dependency graph is not available to you.");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.goto(`${RECORD}?tab=stack`);
    await expect(page.getByTestId("not-available-to-you").first()).toBeVisible();
    await expect(page.getByText("This agent's card is not available to you.")).toBeVisible();
    await expect(page.getByText("The energy estimate is not available to you.")).toBeVisible();
    await expect(page.getByText(/could not be loaded/)).toHaveCount(0);
    await page.goto(`${RECORD}?tab=audit`);
    await expect(page.getByTestId("use-case-audit-admin-only")).toBeVisible();
    // the conditions card offers no admin-only control to a non-admin
    await page.goto(`${RECORD}?tab=overview`);
    await expect(page.getByRole("button", { name: /^Waive:/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Mark met:/ })).toHaveCount(0);
  });

  test("a non-admin who is not the owner gets the denied card under the record's heading", async ({ page }) => {
    await mockGateway(page, { me: STRANGER, overview: "forbidden" });
    await page.goto(RECORD);
    await expect(page.getByRole("heading", { level: 1, name: "AI use-case record" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("AI registry");
    await expect(page.getByText("You don't have access to this view")).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expectAxeClean(page, "use-case record refused (403)");
  });

  test("a record that does not exist says so under the heading", async ({ page }) => {
    await mockGateway(page, { me: OWNER, overview: "missing" });
    await page.goto(RECORD);
    await expect(page.getByRole("heading", { level: 1, name: "AI use-case record" })).toBeVisible();
    await expect(page.getByText("No such use case")).toBeVisible();
  });
});

test("a phone width: the tab strip scrolls in its own box and the page never scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockGateway(page);
  await page.goto(RECORD);
  await expect(figure(page, "conditions")).toContainText("2 open");
  const widths = await page.evaluate(() => {
    const strip = document.querySelector('[role="tablist"][aria-label="Use case record sections"]') as HTMLElement;
    return {
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      stripScroll: strip.scrollWidth,
      stripBox: strip.clientWidth,
      stripOverflow: getComputedStyle(strip).overflowX,
      stripRight: strip.getBoundingClientRect().right,
    };
  });
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);
  expect(widths.stripRight).toBeLessThanOrEqual(widths.viewport);
  expect(widths.stripOverflow).toBe("auto");
  expect(widths.stripScroll).toBeGreaterThan(widths.stripBox);
  // the last tab is reachable inside the strip's own box
  await page.getByRole("tab", { name: "Feedback" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("tab", { name: "Feedback" })).toBeInViewport();
  await expectAxeClean(page, "decision summary (phone)");
});
