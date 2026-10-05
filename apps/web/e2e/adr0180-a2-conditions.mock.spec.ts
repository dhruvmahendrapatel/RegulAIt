/**
 * ADR-0180 A2 — measurable conditions, from the browser's side against a
 * mocked gateway (the *.mock.spec.ts harness):
 *
 *  - the REVIEW DRAWER lets a reviewer add a measured condition (metric,
 *    operator, threshold, window, minimum samples, cadence, on-breach) with
 *    plain-language help on what each metric measures; validation refuses
 *    before anything is sent; the decide body carries the exact measured shape;
 *  - the RECORD's conditions card shows a measured condition's last value,
 *    state and evidence links, a waived condition with who waived it and why,
 *    and (for an admin) Evaluate now and Waive — the waiver needs a reason;
 *  - a measured condition never offers Mark met;
 *  - axe (WCAG 2.x A/AA) in light and dark on both.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const UC = "11111111-1111-4111-8111-111111111111";
const INST = "44444444-4444-4444-8444-444444444444";
const AP = "55555555-5555-4555-8555-555555555555";
const C_METRIC = "77777777-7777-4777-8777-777777777777";
const C_WAIVED = "88888888-8888-4888-8888-888888888888";
const C_MANUAL = "99999999-9999-4999-8999-999999999999";
const TRACE = "abcdefab-0000-4000-8000-000000000001";

type Persona = { id: string; isAdmin: boolean; displayName: string };
const ADMIN: Persona = { id: "riley", isAdmin: true, displayName: "Riley Reviewer" };

const overview = (status: string) => ({
  useCase: { id: UC, name: "Claims triage assistant", description: "Routes insurance claims to the right handler.", businessContext: "Faster claim handling with human review.", status, euAiActTier: "limited", ownerName: "Ada Owner", ownerUserId: "ada", workflowInstanceId: INST, complianceTags: [] },
  screening: { tier: "limited", reasons: [{ reason: "Interacts directly with people." }], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "art", version: 1, submittedAt: "2026-10-02T09:00:00Z" },
  stack: { agents: [], vendors: [] },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: status === "under_review" ? 1 : 0 },
  approvals: [{ id: AP, status: status === "under_review" ? "pending" : "approved", stageId: "signoff", approverUserId: "riley", requestedAt: "2026-10-02T09:00:05Z", decidedAt: null, decisionReason: null }],
  audit: [],
});

const measuredFields = {
  kind: "metric",
  metric: "error_rate",
  params: {},
  operator: "lt",
  threshold: 5,
  windowDays: 7,
  minSamples: 50,
  cadence: "daily",
  onBreach: "reopen_review",
  spec: "Error rate below 5 % over 7 days (at least 50 samples)",
  waivedAt: null,
  waivedByName: null,
  waiveReason: null,
};

interface MockState {
  status: string;
  metricState: "insufficient" | "pass" | "fail";
  waived: boolean;
  decides: unknown[];
  evaluates: string[];
  waives: Array<{ path: string; body: unknown }>;
}

const conditions = (s: MockState) => [
  {
    id: C_METRIC, approvalId: AP, text: "Error rate below 5 % over 7 days (at least 50 samples)", ownerUserId: null, ownerName: null, dueAt: "2026-10-12T11:00:00Z", blocking: true,
    status: s.waived ? "waived" : s.metricState === "pass" ? "met" : "open", metAt: s.metricState === "pass" || s.waived ? "2026-10-05T10:00:00Z" : null, metByName: null, note: null, overdue: false, canMarkMet: false,
    ...measuredFields,
    lastValue: s.metricState === "pass" ? 1.2 : 0, lastSamples: s.metricState === "insufficient" ? 12 : 240, lastState: s.metricState, lastEvaluatedAt: "2026-10-05T09:00:00Z", consecutiveBreaches: s.metricState === "fail" ? 1 : 0,
    evidence: [{ type: "trace", id: TRACE }, { type: "trace", id: "abcdefab-0000-4000-8000-000000000002" }, { type: "trace", id: "abcdefab-0000-4000-8000-000000000003" }, { type: "trace", id: "abcdefab-0000-4000-8000-000000000004" }],
    ...(s.waived ? { waivedAt: "2026-10-05T10:00:00Z", waivedByName: "Riley Reviewer", waiveReason: "The board accepted the interim error budget." } : {}),
  },
  {
    id: C_WAIVED, approvalId: AP, text: "Spend at most 500 USD over 30 days (at least 1 sample)", ownerUserId: null, ownerName: null, dueAt: "2026-11-01T11:00:00Z", blocking: false,
    status: "waived", metAt: "2026-10-04T10:00:00Z", metByName: null, note: null, overdue: false, canMarkMet: false,
    ...measuredFields, metric: "spend_usd", operator: "lte", threshold: 500, windowDays: 30, minSamples: 1, onBreach: "alert", spec: "Spend at most 500 USD over 30 days (at least 1 sample)",
    lastValue: null, lastSamples: null, lastState: null, lastEvaluatedAt: null, consecutiveBreaches: 0, evidence: [],
    waivedAt: "2026-10-04T10:00:00Z", waivedByName: "Riley Reviewer", waiveReason: "Covered by the project budget gate.",
  },
  { id: C_MANUAL, approvalId: AP, text: "DPIA signed by the DPO", ownerUserId: "ada", ownerName: "Ada Owner", dueAt: "2026-10-30T00:00:00Z", blocking: false, status: "open", metAt: null, metByName: null, note: null, overdue: false, canMarkMet: true, kind: "manual", metric: null, spec: null, evidence: [] },
];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockGateway(page: Page, patch: Partial<MockState> = {}): Promise<MockState> {
  const state: MockState = { status: "approved", metricState: "insufficient", waived: false, decides: [], evaluates: [], waives: [], ...patch };
  const me = ADMIN;
  const intakeApproval = {
    id: AP, status: "pending", objectType: "workflow", stageId: "signoff", requestedAt: "2026-10-02T09:00:05Z", userId: "ada", approverUserId: "riley", instanceId: INST,
    requestedByName: "Ada Owner", approverName: "Riley Reviewer", objectLabel: "AI use-case intake: Claims triage assistant", selfReview: false,
    assignment: { assigneeKind: "user", slaState: "ok", dueAt: "2026-10-06T17:00:00Z" },
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, via: "session", user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: me.isAdmin, user: { id: me.id, email: `${me.id}@example.test`, displayName: me.displayName } });
    if (p === "/v1/approvals") return json(route, { approvals: state.status === "under_review" ? [intakeApproval] : [] });
    if (p.startsWith("/v1/approvals/") && p.endsWith("/decide") && method === "POST") {
      state.decides.push(req.postDataJSON());
      return json(route, { ok: true });
    }
    if (p === `/v1/workflows/instances/${INST}`) return json(route, { instance: { id: INST, status: "blocked_on_approval", createdAt: "2026-10-02T09:00:00Z", initiatorUserId: "ada", change: { description: "AI use-case intake: Claims triage assistant", changeType: "ai-use-case-intake" }, definition: { stages: [{ id: "intake", type: "trigger" }, { id: "questionnaire", type: "artifact_generation", output: "use_case_questionnaire" }, { id: "signoff", type: "human_approval" }] }, state: { currentStageIndex: 2, stageStatuses: {} }, context: {} }, artifacts: [{ id: "art", output: "use_case_questionnaire", version: 1, content: "# AI use-case intake questionnaire" }] });
    if (p === "/v1/use-cases") return json(route, { useCases: [{ id: UC, workflowInstanceId: INST }] });
    if (p === `/v1/use-cases/${UC}/overview`) return json(route, overview(state.status));
    if (p === `/v1/use-cases/${UC}`) return json(route, { useCase: { id: UC, status: state.status, approvedAt: "2026-10-02T11:00:00Z", approvedUntil: "2027-10-02T11:00:00Z", approvalExpired: false }, conditions: state.status === "approved" ? conditions(state) : [] });
    if (p === `/v1/use-cases/${UC}/conditions/${C_METRIC}/evaluate` && method === "POST") {
      state.evaluates.push(p);
      state.metricState = "pass";
      return json(route, { verdict: { conditionId: C_METRIC, state: "pass", status: "met" }, met: true, reopened: false });
    }
    if (p.startsWith(`/v1/use-cases/${UC}/conditions/`) && p.endsWith("/waive") && method === "POST") {
      state.waives.push({ path: p, body: req.postDataJSON() });
      state.waived = true;
      return json(route, { id: C_METRIC, status: "waived" });
    }
    if (p === "/v1/governance/review-policy") return json(route, { roles: [], tiers: {}, riskAcceptorUserIds: [], updatedAt: null, updatedByName: null });
    if (p === "/v1/users/directory") return json(route, { users: [{ id: "ada", name: "Ada Owner", teams: [] }, { id: "riley", name: "Riley Reviewer", teams: [] }] });
    return json(route, {});
  });
  return state;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include?: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0180 A2: measured conditions", () => {
  test("the review drawer adds a measured condition with help, validates it, and posts the exact shape", async ({ page }) => {
    const state = await mockGateway(page, { status: "under_review" });
    await page.goto("/ui/inbox");
    await page.getByRole("button", { name: "Review sign-off for Claims triage assistant" }).click();
    const drawer = page.getByRole("dialog", { name: "Review use case sign-off" });
    await expect(drawer).toBeVisible();
    await drawer.getByText("Approve with conditions", { exact: true }).click();
    await drawer.getByRole("button", { name: "+ Add measured condition" }).click();
    const group = drawer.getByRole("group", { name: "Measured condition 1" });
    await expect(group).toBeVisible();
    // plain-language help on what the metric measures, tied to the control
    const metric = group.getByLabel("Metric", { exact: true });
    await expect(metric).toHaveValue("error_rate");
    await expect(group).toContainText("The share of the use case's finished traces that ended in an error.");
    await metric.selectOption("redteam_asr");
    await expect(group).toContainText("How often red-team attacks succeeded");
    await expect(group).toContainText("One sample is one probe trial.");

    // the manual condition the outcome seeded can go: measured ones are enough
    await drawer.getByRole("button", { name: "Remove condition 1" }).click();

    // validation refuses before anything is sent
    await group.getByLabel("Window (days)").fill("120");
    await drawer.getByRole("button", { name: "Approve with conditions" }).click();
    await expect(group).toContainText("Between 1 and 90 days.");
    expect(state.decides).toEqual([]);

    await group.getByLabel("Window (days)").fill("30");
    await group.getByLabel("Threshold (%)").fill("5");
    await group.getByRole("textbox", { name: "Minimum samples" }).fill("30");
    await group.getByLabel("Checked").selectOption("weekly");
    await group.getByLabel("On a breach").selectOption("reopen_review");
    await expect(group).toContainText("Recorded as: Red-team attack success rate below 5 % over 30 days (at least 30 samples)");
    await expectAxeClean(page, "review drawer with a measured condition", '[role="dialog"]');

    await drawer.getByRole("button", { name: "Approve with conditions" }).click();
    await expect.poll(() => state.decides.length).toBe(1);
    expect(state.decides[0]).toEqual({
      decision: "approved",
      conditions: [
        {
          kind: "metric",
          text: "Red-team attack success rate below 5 % over 30 days (at least 30 samples)",
          blocking: true,
          metric: "redteam_asr",
          params: {},
          operator: "lt",
          threshold: 5,
          windowDays: 30,
          minSamples: 30,
          cadence: "weekly",
          onBreach: "reopen_review",
        },
      ],
    });
  });

  test("the record shows the last value, state, evidence and waivers; an admin evaluates now and waives with a reason", async ({ page }) => {
    const state = await mockGateway(page);
    await page.goto(`/ui/admin/governance/use-cases/${UC}`);
    const card = page.locator("section", { has: page.getByText("Conditions of approval", { exact: true }) });
    const measured = card.getByRole("row").filter({ hasText: "Error rate below 5 %" }).first();
    await expect(measured).toContainText("Too few samples");
    await expect(measured).toContainText("0 % over 12 samples");
    await expect(measured.getByRole("link", { name: /^Trace abcdefab/ }).first()).toHaveAttribute("href", `/ui/admin/traces?trace=${TRACE}`);
    await expect(measured).toContainText("and 1 more");
    // a measured condition is never marked met by hand
    await expect(measured.getByRole("button", { name: /^Mark met/ })).toHaveCount(0);
    const waivedRow = card.getByRole("row").filter({ hasText: "Spend at most 500 USD" });
    await expect(waivedRow).toContainText("Waived");
    await expect(waivedRow).toContainText("by Riley Reviewer");
    await expect(waivedRow).toContainText("Covered by the project budget gate.");
    await expect(waivedRow.getByRole("button", { name: /^Evaluate now/ })).toHaveCount(0);
    await expect(card.getByRole("row").filter({ hasText: "DPIA signed" }).getByRole("button", { name: /^Mark met/ })).toBeVisible();
    await expect(card).toContainText("A waived condition shows at the deploy gate as a warning, never as a pass.");
    await expectAxeClean(page, "use-case record with measured conditions");

    await measured.getByRole("button", { name: /^Evaluate now/ }).click();
    await expect.poll(() => state.evaluates.length).toBe(1);
    await expect(measured).toContainText("Passing");
    await expect(measured).toContainText("on passing evidence");

    await measured.getByRole("button", { name: /^Waive/ }).click();
    const dialog = page.getByRole("dialog", { name: "Waive condition" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Waive condition" }).click();
    await expect(dialog).toContainText("Say why this condition is waived");
    expect(state.waives).toEqual([]);
    await expectAxeClean(page, "waive dialog", '[role="dialog"]');
    await dialog.getByLabel("Why it is waived").fill("The board accepted the interim error budget.");
    await dialog.getByRole("button", { name: "Waive condition" }).click();
    await expect.poll(() => state.waives.length).toBe(1);
    expect(state.waives[0]).toEqual({ path: `/v1/use-cases/${UC}/conditions/${C_METRIC}/waive`, body: { reason: "The board accepted the interim error budget." } });
    await expect(measured).toContainText("The board accepted the interim error budget.");
  });
});
