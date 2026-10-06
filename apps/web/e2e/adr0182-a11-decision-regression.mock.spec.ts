/**
 * ADR-0182 (ADR-0175 batch D4) A11 — the decision regression page and the
 * use case's Decision records tab, against a mocked gateway:
 *
 *  - runs list; opening one shows each changed case before and after, side
 *    by side, with the reasons' added and removed lines;
 *  - golden cases: shipped and reviewer cases; a reviewer case is added from
 *    a use case (POST body pinned) and retired through a confirm (DELETE);
 *  - settings: the strict default is shown; relaxing the gate shows what is
 *    given up, and the save writes PUT /v1/org/settings;
 *  - the Decision records tab lists every decision with the versions that
 *    produced it;
 *  - axe (WCAG 2.x A/AA) in light and dark on every screen.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const UC = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const CASE = "55555555-5555-4555-8555-555555555555";
const outcome = {
  tier: "high",
  reasons: ["h-domain-essential-services (Annex III 5(b))", "h-annex3-profiling (Art. 6(3), final subparagraph)"],
  frameworks: ["eu-ai-act", "nist-ai-rmf"],
  requiredRoles: [],
  requiredTests: ["owasp:llm:01 maxAsr<=0% within 30d"],
  suggestedControls: ["eu-ai-act:art-9-risk-management-system"],
  approverRouting: "single approver: requesting_user",
};
const runRow = {
  id: RUN,
  trigger: "preview",
  subject: "review_policy",
  candidateDigest: "a".repeat(64),
  baselineDigest: "b".repeat(64),
  cases: 18,
  changed: 1,
  entries: [] as unknown[],
  createdAt: "2026-10-06T09:00:00Z",
  createdByName: "Avery Admin",
  expiresAt: "2026-10-06T10:00:00Z",
};
const runDetail = {
  ...runRow,
  entries: [
    {
      caseId: "high-credit-scoring",
      label: "High: consumer credit scoring with profiling",
      source: "shipped",
      changed: ["tier", "reasons", "approverRouting"],
      before: outcome,
      after: { ...outcome, tier: "limited", reasons: ["l-interaction-transparency (Art. 50(1))"], approverRouting: "review roles: privacy" },
      reasonsDiff: [
        { value: outcome.reasons[0], added: false, removed: true },
        { value: outcome.reasons[1], added: false, removed: true },
        { value: "l-interaction-transparency (Art. 50(1))", added: true, removed: false },
      ],
    },
  ],
};
const cases = [
  { id: "minimal-internal-search", source: "shipped", label: "Minimal: internal document search over proprietary data", expected: { tier: "minimal" }, fromUseCaseId: null, createdAt: null, createdByName: null, outcome: { ...outcome, tier: "minimal", reasons: [] }, unmetExpectation: [] },
  { id: CASE, source: "override", label: "Benefits pre-check stays high", expected: { tier: "high" }, fromUseCaseId: UC, createdAt: "2026-10-05T09:00:00Z", createdByName: "Avery Admin", outcome, unmetExpectation: [] },
];
const records = [
  {
    id: "66666666-6666-4666-8666-666666666666",
    outcome: "approved",
    decidedAt: "2026-10-06T08:00:00Z",
    decidedByName: "Avery Approver",
    approvalId: "77777777-7777-4777-8777-777777777777",
    workflowInstanceId: "88888888-8888-4888-8888-888888888888",
    reviewPolicyVersion: 4,
    requiredTestsDigest: "c".repeat(64),
    intakeTemplateId: "99999999-9999-4999-8999-999999999999",
    intakeTemplateName: "ai-use-case-intake/governance-owner",
    intakeDefinitionDigest: "d".repeat(64),
    euAiActRulesetVersion: 1,
    intakeAssistVersion: "2026-10-06.1",
    answersDigest: "e".repeat(64),
  },
  {
    id: "66666666-6666-4666-8666-666666666667",
    outcome: "needs_info",
    decidedAt: "2026-10-04T08:00:00Z",
    decidedByName: "Avery Approver",
    approvalId: null,
    workflowInstanceId: "88888888-8888-4888-8888-888888888888",
    reviewPolicyVersion: 3,
    requiredTestsDigest: "c".repeat(64),
    intakeTemplateId: null,
    intakeTemplateName: "ai-use-case-intake",
    intakeDefinitionDigest: "f".repeat(64),
    euAiActRulesetVersion: 1,
    intakeAssistVersion: "2026-10-06.1",
    answersDigest: null,
  },
];
const overview = {
  useCase: { id: UC, name: "Benefits pre-check", description: "Screens benefit applications for missing documents.", businessContext: "", status: "approved", euAiActTier: "high", ownerName: "Dana Developer", complianceTags: [] },
  screening: { tier: "high", reasons: [], rulesetVersion: 1, screened: true },
  questionnaire: { submitted: true, artifactId: "a", version: 1, submittedAt: "2026-10-02T12:00:00Z" },
  risks: [],
  summary: { risks: 0, liveRisks: 0, liveWithoutControls: 0, agentsWithoutApprovedModelCard: 0, pendingApprovals: 0 },
  stack: { agents: [], vendors: [] },
  approvals: [],
  audit: [],
};

interface Captured {
  casePosts: unknown[];
  caseDeletes: string[];
  settingsPuts: unknown[];
}

async function mockApi(page: Page): Promise<Captured> {
  const cap: Captured = { casePosts: [], caseDeletes: [], settingsPuts: [] };
  let settings = { decisionRegressionGate: "enforce", decisionRegressionMaxAgeMinutes: 60 };
  let live = [...cases];
  const me = { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/governance/decision-regression/runs") return json(route, { runs: [runRow, { ...runRow, id: "45555555-4444-4444-8444-444444444444", trigger: "activation", changed: 0, expiresAt: null, createdAt: "2026-10-05T09:00:00Z" }] });
    if (p === `/v1/governance/decision-regression/runs/${RUN}`) return json(route, runDetail);
    if (p === "/v1/governance/decision-regression/cases" && method === "POST") {
      const body = req.postDataJSON() as { label: string };
      cap.casePosts.push(body);
      const created = { ...cases[1]!, id: "56666666-5555-4555-8555-555555555555", label: body.label, createdAt: "2026-10-06T10:00:00Z" };
      live = [...live, created];
      return json(route, created, 201);
    }
    if (p === "/v1/governance/decision-regression/cases") return json(route, { cases: live, versions: { euAiActRulesetVersion: 1, intakeAssistVersion: "2026-10-06.1" } });
    if (p.startsWith("/v1/governance/decision-regression/cases/") && method === "DELETE") {
      const id = p.split("/").pop()!;
      cap.caseDeletes.push(id);
      live = live.filter((c) => c.id !== id);
      return json(route, { retired: true, id, retiredAt: "2026-10-06T10:00:00Z" });
    }
    if (p === "/v1/org/settings" && method === "PUT") {
      const body = req.postDataJSON() as typeof settings;
      cap.settingsPuts.push(body);
      settings = { ...settings, ...body };
      return json(route, { settings });
    }
    if (p === "/v1/org/settings") return json(route, { settings });
    if (p === "/v1/use-cases") return json(route, { useCases: [{ id: UC, name: "Benefits pre-check", status: "approved" }] });
    if (p === `/v1/use-cases/${UC}/overview`) return json(route, overview);
    if (p === `/v1/use-cases/${UC}/decision-records`) return json(route, { records, current: { euAiActRulesetVersion: 1, intakeAssistVersion: "2026-10-06.1" } });
    if (p === `/v1/use-cases/${UC}`) return json(route, { useCase: { ...overview.useCase }, conditions: [], reviews: [], risks: [] });
    if (p === "/v1/users/directory") return json(route, { users: [] });
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0182 A11: decision regression", () => {
  test("runs: a run opens to each changed case, before and after, with the reasons' diff", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/governance/decision-regression");
    await expect(page.getByRole("heading", { level: 1, name: "Decision regression" })).toBeVisible();
    await expect(page.getByText("1 of 18", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /Open the preview run of review policy/ }).first().click();
    const changed = page.getByRole("listitem", { name: "Changed case: High: consumer credit scoring with profiling" });
    await expect(changed).toBeVisible();
    await expect(changed.getByRole("rowheader", { name: "Screening tier" })).toBeVisible();
    await expect(changed.getByRole("row", { name: /Screening tier High Limited/ })).toBeVisible();
    await expect(changed.getByRole("list", { name: "Changed screening reasons" })).toContainText("+ added: l-interaction-transparency (Art. 50(1))");
    await expect(changed.getByRole("list", { name: "Changed screening reasons" })).toContainText("− removed: h-annex3-profiling");
    await expectAxeClean(page, "decision regression runs");
  });

  test("golden cases: add a reviewer case from a use case, and retire one", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/governance/decision-regression");
    await page.getByRole("tab", { name: "Golden cases" }).click();
    await expect(page.getByRole("cell", { name: "Benefits pre-check stays high", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Shipped", exact: true })).toBeVisible();
    await expectAxeClean(page, "decision regression cases");
    await page.getByLabel("Use case").selectOption(UC);
    await page.getByLabel("Case name").fill("Pre-check keeps its tier");
    await page.getByLabel("Tier it must keep").selectOption("high");
    await page.getByRole("button", { name: "Add case" }).click();
    await expect.poll(() => cap.casePosts.length).toBe(1);
    expect(cap.casePosts[0]).toEqual({ fromUseCaseId: UC, label: "Pre-check keeps its tier", expected: { tier: "high" } });
    await page.getByRole("button", { name: "Retire case Benefits pre-check stays high" }).click();
    const confirm = page.getByRole("dialog", { name: "Retire this case?" });
    await expect(confirm).toBeVisible();
    await expectAxeClean(page, "retire a case");
    await confirm.getByRole("button", { name: "Retire case" }).click();
    await expect.poll(() => cap.caseDeletes).toEqual([CASE]);
    // a shipped case offers no retire control
    await expect(page.getByRole("button", { name: /Retire case Minimal/ })).toHaveCount(0);
  });

  test("settings: strict by default; relaxing says what is given up and is saved through the settings route", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/governance/decision-regression");
    await page.getByRole("tab", { name: "Settings" }).click();
    await expect(page.getByLabel("Decision regression gate")).toHaveValue("enforce");
    await expect(page.getByText("Strict default", { exact: true })).toBeVisible();
    await expectAxeClean(page, "decision regression settings");
    await page.getByLabel("Decision regression gate").selectOption("warn");
    await expect(page.getByText("Relaxed", { exact: true })).toBeVisible();
    await expect(page.getByText(/Warn records the missing or stale preview and saves anyway/)).toBeVisible();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect.poll(() => cap.settingsPuts).toEqual([{ decisionRegressionGate: "warn", decisionRegressionMaxAgeMinutes: 60 }]);
  });

  test("the use case's Decision records tab lists each decision with its versions", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/ui/admin/governance/use-cases/${UC}?tab=decisions`);
    const card = page.locator("section[data-rg-card]").filter({ hasText: "Decision records" }).first();
    await expect(card.getByRole("cell", { name: "Approved" })).toBeVisible();
    await expect(card.getByRole("cell", { name: "Returned for information" })).toBeVisible();
    await expect(card.getByRole("cell", { name: "Version 4" })).toBeVisible();
    await expect(card).toContainText("ai-use-case-intake/governance-owner");
    await expect(card).toContainText("screening v1, suggestions 2026-10-06.1");
    await expect(card.getByLabel(`Answers digest ${"e".repeat(64)}`)).toBeVisible();
    await expectAxeClean(page, "decision records tab");
  });
});
