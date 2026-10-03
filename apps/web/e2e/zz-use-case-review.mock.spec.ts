/**
 * ADR-0168 items 3-6, from the browser's side against a mocked gateway:
 *  - the use-case RECORD: header band, lifecycle tracker derived from the
 *    record, conditions of approval with Mark met, the approval's lifetime;
 *    Mark met is offered only where the server says the viewer may close the
 *    condition, and a before-go-live one is closed with a note (ADR-0170 §3);
 *  - the REVIEW TASK drawer: every outcome posts exactly the decide contract,
 *    validation refuses before anything is sent, separation of duties holds,
 *    other approval kinds keep approve/deny, and the drawer is keyboard- and
 *    axe-clean in both themes.
 * Set REVIEW_SHOTS=<dir> to also save light + dark screenshots of the record
 * and the drawer (review material only — never an assertion).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const UC = "11111111-1111-4111-8111-111111111111";
const INST = "44444444-4444-4444-8444-444444444444";
const AP = "55555555-5555-4555-8555-555555555555";
const AP_DEPLOY = "66666666-6666-4666-8666-666666666666";
const C1 = "77777777-7777-4777-8777-777777777777";
const C2 = "88888888-8888-4888-8888-888888888888";
const RISK = "33333333-3333-4333-8333-333333333333";
const AGENT = "22222222-2222-4222-8222-222222222222";

type Persona = { id: string; isAdmin: boolean; displayName: string };
const ADMIN_REVIEWER: Persona = { id: "riley", isAdmin: true, displayName: "Riley Reviewer" };
const AVERY: Persona = { id: "avery", isAdmin: false, displayName: "Avery Approver" };
const PROPOSER: Persona = { id: "ada", isAdmin: true, displayName: "Ada Owner" };

const questionnaire = [
  "# AI use-case intake questionnaire", "",
  "## 1. Purpose and business context", "Recommends credit-limit increases with human review.", "",
  "## 6. Risks and mitigations", "Disparate outcomes across groups; human review of every recommendation.",
].join("\n");

const overview = (status = "under_review") => ({
  useCase: { id: UC, name: "Credit-limit-increase assistant", description: "Recommends credit-limit increases with human review.", businessContext: "Improve customer service while keeping lending decisions accountable.", status, euAiActTier: "high", ownerName: "Ada Owner", ownerUserId: "ada", workflowInstanceId: INST, complianceTags: ["eu-ai-act", "nist-ai-rmf"] },
  screening: { tier: "high", reasons: [{ reason: "Access to essential financial services and profiling of natural persons." }, { reason: "Interacts directly with people." }], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "art", version: 2, submittedAt: "2026-10-02T09:00:00Z" },
  stack: { agents: [{ id: AGENT, name: "Credit assistant", provider: "anthropic", model: "claude-opus-5", lifecycleStatus: "active", halted: false, modelCards: [{ id: "mc", intendedUse: "Credit support", signOff: "approved" }], modelCardApproved: true }], vendors: [{ id: "v", name: "Anthropic", category: "model_provider", status: "approved", linkedVia: ["agent provider"] }] },
  risks: [{ id: RISK, title: "Disparate credit recommendation outcomes", category: "bias_fairness", dimension: "bias", status: "mitigating", inherent: { likelihood: "medium", impact: "high" }, residual: { likelihood: "low", impact: "medium" }, controls: [{ controlRef: "eu-ai-act:art-14-human-oversight", title: "Human oversight", linkedAt: "2026-10-02" }] }],
  summary: { risks: 1, liveRisks: 1, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: status === "under_review" ? 1 : 0 },
  approvals: status === "under_review"
    ? [{ id: AP, status: "pending", stageId: "signoff", approverUserId: "avery", requestedAt: "2026-10-02T09:00:05Z", decidedAt: null, decisionReason: null }]
    : status === "needs_info"
      ? [{ id: AP, status: "returned", stageId: "signoff", approverUserId: "avery", requestedAt: "2026-10-02T09:00:05Z", decidedAt: "2026-10-02T11:00:00Z", decisionReason: "Add the DPIA reference." }]
      : [{ id: AP, status: "approved", stageId: "signoff", approverUserId: "avery", requestedAt: "2026-10-02T09:00:05Z", decidedAt: "2026-10-02T11:00:00Z", decisionReason: "Proceed with conditions." }],
  audit: [{ id: 1, at: "2026-10-02T09:00:01Z", userId: "ada", ruleId: "use-case-eu-tier", effect: "allow", reason: "EU AI Act screening: high" }],
});

/** `canMarkMet` is the server's per-viewer answer; `blockingRefused` plays a
 * server that refuses this viewer the before-go-live condition (the proposer's
 * case: someone else must confirm it) */
const conditions = (firstMet: boolean, viewer: Persona = ADMIN_REVIEWER, blockingRefused = false) => [
  { id: C1, approvalId: AP, text: "Run the bias test on the holdout set and attach the results", ownerUserId: "ada", ownerName: "Ada Owner", dueAt: "2026-09-30T00:00:00Z", blocking: true, status: firstMet ? "met" : "open", metAt: firstMet ? "2026-10-03T10:00:00Z" : null, metByName: firstMet ? "Riley Reviewer" : null, note: firstMet ? "Bias test attached to the record." : null, overdue: !firstMet, canMarkMet: !firstMet && viewer.isAdmin && !blockingRefused },
  { id: C2, approvalId: AP, text: "Quarterly drift review with the credit risk team", ownerUserId: "avery", ownerName: "Avery Approver", dueAt: "2027-01-15T00:00:00Z", blocking: false, status: "open", metAt: null, metByName: null, note: null, overdue: false, canMarkMet: viewer.isAdmin || viewer.id === "ada" || viewer.id === "avery" },
];

const intakeApproval = (requester = "ada", approver = "avery") => ({
  id: AP, status: "pending", objectType: "workflow", stageId: "signoff", requestedAt: "2026-10-02T09:00:05Z", userId: requester, approverUserId: approver, instanceId: INST,
  requestedByName: requester === "ada" ? "Ada Owner" : "Riley Reviewer", approverName: approver === "avery" ? "Avery Approver" : "Riley Reviewer",
  objectLabel: "AI use-case intake: Credit-limit-increase assistant", selfReview: requester === approver,
  assignment: { assigneeKind: "user", slaState: "ok", dueAt: "2026-10-06T17:00:00Z" },
});
const deployApproval = (approver: string) => ({
  id: AP_DEPLOY, status: "pending", objectType: "workflow", stageId: "signoff", requestedAt: "2026-10-02T08:00:00Z", userId: "ada", approverUserId: approver, instanceId: "99999999-9999-4999-8999-999999999999",
  requestedByName: "Ada Owner", approverName: "Riley Reviewer", objectLabel: "Deploy the billing service", selfReview: false,
});

interface MockState {
  persona: Persona;
  status: string;
  approvals: unknown[];
  conditionMet: boolean;
  approvedUntil: string | null;
  approvalExpired: boolean;
  blockingRefused: boolean;
  decides: Array<{ id: string; body: unknown }>;
  metPosts: Array<{ path: string; body: unknown }>;
}

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockGateway(page: Page, patch: Partial<MockState> = {}): Promise<MockState> {
  const state: MockState = { persona: ADMIN_REVIEWER, status: "under_review", approvals: [intakeApproval("ada", "riley")], conditionMet: false, approvedUntil: null, approvalExpired: false, blockingRefused: false, decides: [], metPosts: [], ...patch };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    const me = state.persona;
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, via: "session", user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName } });
    if (p === "/v1/approvals") return json(route, { approvals: state.approvals });
    if (p.startsWith("/v1/approvals/") && p.endsWith("/decide") && method === "POST") {
      state.decides.push({ id: p.split("/")[3]!, body: route.request().postDataJSON() });
      return json(route, { ok: true });
    }
    if (p === `/v1/workflows/instances/${INST}`) return json(route, { instance: { id: INST, status: "blocked_on_approval", createdAt: "2026-10-02T09:00:00Z", initiatorUserId: "ada", change: { description: "AI use-case intake: Credit-limit-increase assistant", changeType: "ai-use-case-intake" }, definition: { stages: [{ id: "intake", type: "trigger" }, { id: "questionnaire", type: "artifact_generation", output: "use_case_questionnaire" }, { id: "signoff", type: "human_approval" }] }, state: { currentStageIndex: 2, stageStatuses: {} }, context: {} }, artifacts: [{ id: "art1", output: "use_case_questionnaire", version: 1, content: "# old" }, { id: "art", output: "use_case_questionnaire", version: 2, content: questionnaire }] });
    if (p.startsWith("/v1/workflows/instances/")) return json(route, { error: "not_found" }, 404);
    if (p === "/v1/use-cases") return json(route, me.isAdmin ? { useCases: [{ id: UC, workflowInstanceId: INST }] } : { useCases: [] });
    if (p === `/v1/use-cases/${UC}/overview`) return me.isAdmin ? json(route, overview(state.status)) : json(route, { error: "forbidden" }, 403);
    if (p === `/v1/use-cases/${UC}`) return json(route, { useCase: { id: UC, status: state.status, approvedAt: state.approvedUntil ? "2026-10-02T11:00:00Z" : null, approvedUntil: state.approvedUntil, approvalExpired: state.approvalExpired }, conditions: state.status === "approved" ? conditions(state.conditionMet, me, state.blockingRefused) : [] });
    if (p.startsWith(`/v1/use-cases/${UC}/conditions/`) && p.endsWith("/met") && method === "POST") {
      state.metPosts.push({ path: p, body: route.request().postDataJSON() });
      state.conditionMet = true;
      return json(route, conditions(true, me)[0]);
    }
    if (p === "/v1/users/directory") return json(route, { users: [{ id: "ada", name: "Ada Owner", teams: [] }, { id: "avery", name: "Avery Approver", teams: [] }, { id: "riley", name: "Riley Reviewer", teams: [] }] });
    if (p === `/v1/agents/${AGENT}/card`) return json(route, { agent: { id: AGENT, name: "Credit assistant", provider: "anthropic", model: "claude-opus-5", tier: "standard", modes: ["chat"], enabled: true, lifecycleStatus: "active", halted: false, haltedReason: null, hasSystemPrompt: true }, owner: { id: "ada", name: "Ada Owner", state: "owned" }, purpose: { intendedUses: ["Credit support"], limitations: [], source: "model card" }, dataSources: { declared: [], note: "" }, guardrails: { modes: {}, blocksInput: true, blocksOutput: true, provenance: [] }, oversight: { modelCards: 1, modelCardApproved: true, note: "" } });
    return json(route, {});
  });
  return state;
}

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function expectNoAxeViolations(page: Page, label: string, include?: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe violations on "${label}" in the ${theme} theme`).toEqual([]);
  }
}
async function shots(page: Page, name: string) {
  const dir = process.env.REVIEW_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const theme of THEMES) {
    await setTheme(page, theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(dir, `${name}-${theme}.png`), fullPage: !name.includes("panel") });
  }
}

async function openReview(page: Page) {
  await page.goto("/ui/inbox");
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  await expect(page.getByText(/AI use case sign-off/).first()).toBeVisible();
  await page.getByRole("button", { name: "Review sign-off for Credit-limit-increase assistant" }).click();
  const drawer = page.getByRole("dialog", { name: "Review use case sign-off" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("the use-case record", () => {
  test("header band, lifecycle tracker derived from the record, conditions and Mark met", async ({ page }) => {
    const state = await mockGateway(page, { status: "approved", approvedUntil: "2027-04-02T11:00:00Z" });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("heading", { level: 1, name: "Credit-limit-increase assistant" })).toBeVisible();
    const band = page.getByRole("list", { name: "Record status" });
    await expect(band).toContainText("Approved");
    await expect(band).toContainText("High tier");
    await expect(band).toContainText(/Approval valid until\s*2 Apr 2027/);
    // one open before-go-live condition holds the use case at Approved, short of Monitoring
    const stepper = page.getByRole("list", { name: "Lifecycle" });
    await expect(stepper.locator('[aria-current="step"]')).toContainText("Approved");
    await expect(page.getByText("1 before-go-live condition open")).toBeVisible();
    const tracker = page.locator("section", { has: page.getByText("Lifecycle tracker", { exact: true }) });
    for (const [activity, status] of [["Business context", "Complete"], ["EU AI Act screening", "Complete"], ["Data and AI models", "Complete"], ["Risks and safeguards", "Complete"], ["Sign-off", "Complete"]] as const) {
      await expect(tracker.getByRole("row").filter({ hasText: activity })).toContainText(status);
    }
    await expect(tracker.getByRole("row").filter({ hasText: "Sign-off" })).toContainText("Avery Approver");
    await expect(tracker.getByRole("row").filter({ hasText: "Business context" })).toContainText("Questionnaire version 2 submitted");

    const conds = page.locator("section", { has: page.getByText("Conditions of approval", { exact: true }) });
    const first = conds.getByRole("row").filter({ hasText: "Run the bias test" });
    await expect(first).toContainText("Before go-live");
    await expect(first).toContainText("Overdue");
    await expect(conds.getByRole("row").filter({ hasText: "Quarterly drift review" })).toContainText("After go-live");
    await expectNoAxeViolations(page, "use-case record (approved, conditions open)");
    await shots(page, "after-record-overview");

    // a before-go-live condition is closed with a note saying what was done
    await first.getByRole("button", { name: /^Mark met/ }).click();
    const dialog = page.getByRole("dialog", { name: "Mark condition met" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Run the bias test");
    await dialog.getByRole("button", { name: "Mark met" }).click();
    await expect(dialog.getByText("Say what was done to meet this condition")).toBeVisible();
    await expect(dialog.getByLabel("What was done")).toHaveAttribute("aria-invalid", "true");
    expect(state.metPosts).toEqual([]);
    await expectNoAxeViolations(page, "mark condition met (note required)");
    // Escape closes without sending; reopening starts clean
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(state.metPosts).toEqual([]);
    await first.getByRole("button", { name: /^Mark met/ }).click();
    await expect(dialog.getByLabel("What was done")).toHaveValue("");
    await dialog.getByLabel("What was done").fill("  Bias test attached to the record.  ");
    await dialog.getByRole("button", { name: "Mark met" }).click();
    await expect.poll(() => state.metPosts.length).toBe(1);
    expect(state.metPosts[0]).toEqual({ path: `/v1/use-cases/${UC}/conditions/${C1}/met`, body: { note: "Bias test attached to the record." } });
    await expect(dialog).toHaveCount(0);
    await expect(first).toContainText("Met");
    await expect(stepper.locator('[aria-current="step"]')).toContainText("Monitoring");

    // an activity's action goes to the tab that completes it
    await tracker.getByRole("button", { name: "Open risks" }).click();
    await expect(page.getByRole("tab", { name: "Risks", selected: true })).toBeVisible();
    await page.getByRole("tab", { name: "Approvals" }).click();
    const history = page.getByRole("row").filter({ hasText: "Avery Approver" });
    await expect(history).toContainText("Sign-off");
    await expect(history).toContainText("Approved");
  });

  test("Mark met follows the server's answer for this viewer: no button where it would refuse; an after-go-live one closes without a note", async ({ page }) => {
    // the proposer, here an admin who proposed it: the server says someone else confirms the before-go-live condition
    const state = await mockGateway(page, { persona: PROPOSER, status: "approved", approvedUntil: "2027-04-02T11:00:00Z", blockingRefused: true, approvals: [] });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("heading", { level: 1, name: "Credit-limit-increase assistant" })).toBeVisible();
    const conds = page.locator("section", { has: page.getByText("Conditions of approval", { exact: true }) });
    const blocking = conds.getByRole("row").filter({ hasText: "Run the bias test" });
    await expect(blocking).toContainText("Overdue");
    await expect(blocking.getByRole("button", { name: /^Mark met/ })).toHaveCount(0);
    await expect(conds.getByText(/confirmed by someone other than the person who proposed the use case/)).toBeVisible();
    await expectNoAxeViolations(page, "use-case record (proposer view)");
    const after = conds.getByRole("row").filter({ hasText: "Quarterly drift review" });
    await after.getByRole("button", { name: /^Mark met/ }).click();
    await expect.poll(() => state.metPosts.length).toBe(1);
    expect(state.metPosts[0]).toEqual({ path: `/v1/use-cases/${UC}/conditions/${C2}/met`, body: {} });
    await expect(page.getByRole("dialog", { name: "Mark condition met" })).toHaveCount(0);
  });

  test("a use case sent back reads Needs information; an expired approval asks for re-review", async ({ page }) => {
    await mockGateway(page, { status: "needs_info" });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("list", { name: "Record status" })).toContainText("Needs information");
    await expect(page.getByRole("list", { name: "Lifecycle" }).locator('[aria-current="step"]')).toContainText("Under review");
    const tracker = page.locator("section", { has: page.getByText("Lifecycle tracker", { exact: true }) });
    await expect(tracker.getByRole("row").filter({ hasText: "Business context" })).toContainText("Needs update");
    await expect(tracker.getByRole("row").filter({ hasText: "Sign-off" })).toContainText("Sent back");
    await expect(tracker.getByRole("link", { name: "Update questionnaire" })).toHaveAttribute("href", `/ui/workflows/${INST}`);
    await page.getByRole("tab", { name: "Approvals" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Avery Approver" })).toContainText("Sent back");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockGateway(page, { status: "approved", approvedUntil: "2026-09-01T00:00:00Z", approvalExpired: true, conditionMet: true });
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    await expect(page.getByRole("list", { name: "Record status" })).toContainText("Approval expired 1 Sep 2026");
    await expect(page.getByText(/The approval expired on 1 Sep 2026/)).toBeVisible();
    await expect(page.getByText("Approval expired — re-review required")).toBeVisible();
    await expect(page.getByRole("list", { name: "Lifecycle" }).locator('[aria-current="step"]')).toContainText("Under review");
  });
});

test.describe("the review task", () => {
  const cases = [
    { outcome: "Approve", fill: async () => {}, submit: "Approve", body: { decision: "approved" } },
    {
      outcome: "Approve with conditions",
      fill: async (drawer: ReturnType<Page["getByRole"]>) => {
        const one = drawer.getByRole("group", { name: "Condition 1" });
        await one.getByLabel("Condition", { exact: true }).fill("Run the bias test on the holdout set");
        await one.getByLabel("Owner").selectOption({ label: "Ada Owner" });
        await one.getByLabel("Due date").fill("2026-11-01");
        await drawer.getByRole("button", { name: "+ Add condition" }).click();
        const two = drawer.getByRole("group", { name: "Condition 2" });
        await two.getByLabel("Condition", { exact: true }).fill("Quarterly drift review");
        await two.getByLabel("Due date").fill("2027-01-15");
        await two.getByLabel("Applies").selectOption("after");
        await drawer.getByLabel("Reason (optional)").fill("Proceed once the bias test is attached.");
      },
      submit: "Approve with conditions",
      body: {
        decision: "approved",
        reason: "Proceed once the bias test is attached.",
        conditions: [
          { text: "Run the bias test on the holdout set", ownerUserId: "ada", dueAt: "2026-11-01", blocking: true },
          { text: "Quarterly drift review", dueAt: "2027-01-15", blocking: false },
        ],
      },
    },
    {
      outcome: "Send back for information",
      fill: async (drawer: ReturnType<Page["getByRole"]>) => { await drawer.getByLabel("What information is missing (required)").fill("Attach the DPIA reference."); },
      submit: "Send back",
      body: { decision: "returned", reason: "Attach the DPIA reference." },
    },
    {
      outcome: "Reject",
      fill: async (drawer: ReturnType<Page["getByRole"]>) => { await drawer.getByLabel("Reason (optional)").fill("Outside our risk appetite."); },
      submit: "Reject",
      body: { decision: "denied", reason: "Outside our risk appetite." },
    },
  ];
  for (const c of cases) {
    test(`${c.outcome} posts exactly the decide contract`, async ({ page }) => {
      const state = await mockGateway(page);
      const drawer = await openReview(page);
      // the evidence sits beside the decision
      await expect(drawer.getByText("High tier")).toBeVisible();
      await expect(drawer.getByText("Access to essential financial services and profiling of natural persons.")).toBeVisible();
      await expect(drawer.getByText("medium × high → low × medium")).toBeVisible();
      await expect(drawer.getByText("Human oversight")).toBeVisible();
      await expect(drawer.getByText(/Credit assistant · claude-opus-5/)).toBeVisible();
      await expect(drawer.getByText("6 Oct 2026")).toBeVisible();
      await expect(drawer.getByRole("link", { name: "Credit-limit-increase assistant" })).toHaveAttribute("href", `/ui/admin/governance/use-cases/${UC}`);
      if (c.outcome === "Approve with conditions") await shots(page, "after-review-panel");
      await drawer.getByRole("button", { name: "View questionnaire" }).click();
      await expect(drawer.getByText("Disparate outcomes across groups; human review of every recommendation.", { exact: true })).toBeVisible();
      await drawer.getByRole("radio", { name: c.outcome, exact: true }).check();
      await c.fill(drawer);
      if (c.outcome === "Approve with conditions") await shots(page, "after-review-panel-conditions");
      await drawer.getByRole("button", { name: c.submit, exact: true }).click();
      await expect.poll(() => state.decides.length).toBe(1);
      expect(state.decides[0]).toEqual({ id: AP, body: c.body });
      await expect(drawer).toBeHidden();
    });
  }

  test("validation refuses before anything is sent: send back needs a reason, a condition needs text and a due date", async ({ page }) => {
    const state = await mockGateway(page);
    const drawer = await openReview(page);
    await drawer.getByRole("button", { name: "Submit decision" }).click();
    await expect(drawer.getByText("Choose a decision.")).toBeVisible();

    await drawer.getByRole("radio", { name: "Send back for information", exact: true }).check();
    await drawer.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(drawer.getByText("Say what information is missing — the proposer sees this.")).toBeVisible();
    await expect(drawer.getByLabel("What information is missing (required)")).toBeFocused();

    await drawer.getByRole("radio", { name: "Approve with conditions", exact: true }).check();
    await drawer.getByRole("button", { name: "Approve with conditions", exact: true }).click();
    const one = drawer.getByRole("group", { name: "Condition 1" });
    await expect(one.getByText("Describe the condition.")).toBeVisible();
    await expect(one.getByText("Choose a due date.")).toBeVisible();
    await one.getByLabel("Condition", { exact: true }).fill("Run the bias test");
    await drawer.getByRole("button", { name: "Approve with conditions", exact: true }).click();
    await expect(one.getByText("Describe the condition.")).toBeHidden();
    await expect(one.getByText("Choose a due date.")).toBeVisible();
    await expectNoAxeViolations(page, "review drawer with validation errors", '[role="dialog"]');
    expect(state.decides).toEqual([]);
  });

  test("the proposer cannot decide their own use case; other approval kinds keep approve and deny", async ({ page }) => {
    const state = await mockGateway(page, { persona: PROPOSER, approvals: [intakeApproval("ada", "ada"), deployApproval("ada")] });
    await page.goto("/ui/inbox");
    const deploy = page.locator("div").filter({ hasText: "Deploy the billing service" }).filter({ has: page.getByRole("button", { name: "Approve" }) }).last();
    await expect(deploy.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(deploy.getByRole("button", { name: "Deny" })).toBeVisible();
    const drawer = await (async () => {
      await page.getByRole("button", { name: "Review sign-off for Credit-limit-increase assistant" }).click();
      return page.getByRole("dialog", { name: "Review use case sign-off" });
    })();
    await expect(drawer.getByText(/You proposed this use case, so someone independent of it decides/)).toBeVisible();
    await expect(drawer.getByRole("radio")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Submit decision" })).toHaveCount(0);
    expect(state.decides).toEqual([]);
  });

  test("a reviewer who cannot open the record still sees the questionnaire, and is told where the rest is", async ({ page }) => {
    const state = await mockGateway(page, { persona: AVERY, approvals: [intakeApproval("ada", "avery")] });
    const drawer = await openReview(page);
    await expect(drawer.getByText("Credit-limit-increase assistant")).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Credit-limit-increase assistant" })).toHaveCount(0);
    await expect(drawer.getByText(/Version 2/)).toBeVisible();
    await expect(drawer.getByText(/which its owner and administrators can open/)).toBeVisible();
    await drawer.getByRole("radio", { name: "Approve", exact: true }).check();
    await drawer.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => state.decides.length).toBe(1);
    expect(state.decides[0]!.body).toEqual({ decision: "approved" });
  });

  test("keyboard: focus lands in the drawer, Tab stays inside, Escape returns focus to the trigger; axe-clean in both themes", async ({ page }) => {
    await mockGateway(page);
    await page.goto("/ui/inbox");
    const trigger = page.getByRole("button", { name: "Review sign-off for Credit-limit-increase assistant" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Review use case sign-off" });
    await expect(drawer.getByRole("heading", { name: "Review use case sign-off" })).toBeFocused();
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), `Tab ${i + 1} left the drawer`).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await drawer.getByRole("radio", { name: "Approve with conditions", exact: true }).check();
    await expectNoAxeViolations(page, "review drawer (approve with conditions)", '[role="dialog"]');
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("the Approvals queue and the Review workbench open the same review task", async ({ page }) => {
    await mockGateway(page, { approvals: [intakeApproval("ada", "riley"), deployApproval("riley")] });
    for (const route of ["/ui/admin/approvals", "/ui/admin/review-workbench"]) {
      await page.goto(route);
      await page.getByRole("button", { name: "Review sign-off for Credit-limit-increase assistant" }).click();
      const drawer = page.getByRole("dialog", { name: "Review use case sign-off" });
      await expect(drawer.getByRole("radio")).toHaveCount(4);
      await drawer.getByRole("button", { name: "Cancel" }).click();
      await expect(drawer).toBeHidden();
    }
  });
});
