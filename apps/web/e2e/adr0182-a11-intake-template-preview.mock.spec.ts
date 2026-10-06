/**
 * ADR-0182 (ADR-0175 batch D4) A11 — the template gallery's "Preview impact"
 * step, against a mocked gateway. An `ai-use-case-intake/*` variant decides
 * who signs off every new use case, so the UI creates one only from its
 * preview:
 *
 *  - Create on an intake variant runs the preview and opens the step; nothing
 *    is created until the admin accepts the changed outcomes with a reason;
 *    cancelling creates nothing (the preview cannot be skipped in the UI);
 *  - the create carries the preview's run id and the acceptance;
 *  - a template of any other name is created directly, with no preview;
 *  - axe (WCAG 2.x A/AA) in light and dark on the page and the step.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const AVERY = "12121212-1212-4212-8212-121212121212";
const RUN = "34343434-3434-4434-8434-343434343434";
const outcome = {
  tier: "minimal",
  reasons: [],
  frameworks: ["nist-ai-rmf", "iso-42001"],
  requiredRoles: [],
  requiredTests: ["owasp:llm:01 maxAsr<=0% within 30d"],
  suggestedControls: [],
  approverRouting: "single approver: requesting_user",
};
const run = {
  id: RUN,
  trigger: "preview",
  subject: "intake_template",
  candidateDigest: "a".repeat(64),
  baselineDigest: "b".repeat(64),
  cases: 17,
  changed: 1,
  entries: [
    {
      caseId: "minimal-internal-search",
      label: "Minimal: internal document search over proprietary data",
      source: "shipped",
      changed: ["approverRouting"],
      before: outcome,
      after: { ...outcome, approverRouting: `single approver: ${AVERY}` },
      reasonsDiff: [],
    },
  ],
  createdAt: "2026-10-06T09:00:00Z",
  createdByName: "Ada Admin",
  expiresAt: "2026-10-06T10:00:00Z",
};
const intakeDefinition = {
  workflow: "ai-use-case-intake",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "questionnaire", type: "artifact_generation", output: "use_case_questionnaire" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
  ],
};
const gallery = {
  entries: [
    {
      galleryId: "standard-change",
      title: "Standard change",
      description: "Intake, forced plan, requirements artifact, human sign-off.",
      source: "built_in",
      definition: { workflow: "standard-change", stages: intakeDefinition.stages.filter((s) => s.id !== "questionnaire") },
      stageAnnotations: [],
    },
    {
      galleryId: "ai-use-case-intake",
      title: "AI use-case intake",
      description: "The pre-build front door for AI use cases.",
      source: "built_in",
      definition: intakeDefinition,
      stageAnnotations: [],
    },
  ],
  profiles: [],
};

interface Captured {
  previews: unknown[];
  creates: Array<{ url: string; body: Record<string, unknown> }>;
}

async function mockApi(page: Page): Promise<Captured> {
  const cap: Captured = { previews: [], creates: [] };
  const me = { userId: "u", isAdmin: true, user: { id: "u", email: "ada@example.test", displayName: "Ada Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users") return json(route, { users: [{ id: AVERY, email: "avery@example.test", displayName: "Avery Approver", isAdmin: false }] });
    if (p === "/v1/workflows/template-gallery") return json(route, gallery);
    if (p === "/v1/governance/decision-regression/preview" && method === "POST") {
      cap.previews.push(req.postDataJSON());
      return json(route, run, 201);
    }
    if (p.startsWith("/v1/workflows/template-gallery/") && method === "POST") {
      const body = req.postDataJSON() as Record<string, unknown>;
      cap.creates.push({ url: p, body });
      return json(route, { id: "56565656-5656-4656-8656-565656565656", name: body.name, definition: intakeDefinition, galleryId: p.split("/")[4] }, 201);
    }
    if (p === "/v1/workflows/templates") return json(route, { templates: [] });
    if (p === "/v1/workflows/assignment-rules") return json(route, { rules: [] });
    if (p === "/v1/git/connections") return json(route, { connections: [] });
    if (p === "/v1/compliance/profiles") return json(route, { profiles: [] });
    return json(route, {});
  });
  return cap;
}

async function expectAxeClean(page: Page, label: string, include?: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const galleryCard = (page: Page) => page.locator("section[data-rg-card]").filter({ hasText: "Template gallery" }).first();

test.describe("ADR-0182 A11: an intake variant from the gallery is previewed first", () => {
  test("Create opens the preview; cancelling creates nothing; accepting creates with the run id", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/workflow-templates");
    const card = galleryCard(page);
    await expect(card.getByText("AI use-case intake", { exact: true })).toBeVisible();
    await expectAxeClean(page, "workflow templates");
    await card.getByLabel("Approver for sign-off stages (optional)").selectOption(AVERY);
    await card.getByLabel("Template name for AI use-case intake").fill("ai-use-case-intake/governance-owner");
    await card.getByRole("button", { name: "Create" }).nth(1).click();

    // the step opens with the preview of exactly this body; nothing is created yet
    const step = page.getByRole("dialog", { name: "Preview impact: the intake template" });
    await expect(step.getByRole("status").filter({ hasText: "1 of 17 golden cases changes" })).toBeVisible();
    await expect(step.getByRole("listitem", { name: /Changed case: Minimal: internal document search/ })).toContainText("Sign-off routing");
    expect(cap.previews).toEqual([
      { subject: "intake_template", candidate: { galleryId: "ai-use-case-intake", name: "ai-use-case-intake/governance-owner", approverUserId: AVERY } },
    ]);
    expect(cap.creates).toEqual([]);
    await expect(step.getByRole("button", { name: "Create template" })).toBeDisabled();
    await expectAxeClean(page, "intake template preview impact", '[role="dialog"]');

    // cancelling: still nothing created, and the next Create previews again
    await step.getByRole("button", { name: "Cancel" }).click();
    await expect(step).toHaveCount(0);
    expect(cap.creates).toEqual([]);
    await card.getByRole("button", { name: "Create" }).nth(1).click();
    await expect.poll(() => cap.previews.length).toBe(2);

    // accept with a reason, then create
    await step.getByRole("checkbox", { name: /I have reviewed these changed outcomes/ }).check();
    await step.getByLabel("Why these outcomes should change").fill("Every new sign-off goes to the governance owner.");
    await step.getByRole("button", { name: "Create template" }).click();
    await expect.poll(() => cap.creates.length).toBe(1);
    expect(cap.creates[0]).toEqual({
      url: "/v1/workflows/template-gallery/ai-use-case-intake/create",
      body: {
        name: "ai-use-case-intake/governance-owner",
        approverUserId: AVERY,
        regressionRunId: RUN,
        acceptChangedOutcomes: true,
        acceptReason: "Every new sign-off goes to the governance owner.",
      },
    });
    await expect(step).toHaveCount(0);
  });

  test("a template of any other name is created directly, with no preview", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/workflow-templates");
    const card = galleryCard(page);
    await card.getByLabel("Template name for Standard change").fill("api-change");
    await card.getByRole("button", { name: "Create" }).first().click();
    await expect.poll(() => cap.creates.length).toBe(1);
    expect(cap.creates[0]).toEqual({ url: "/v1/workflows/template-gallery/standard-change/create", body: { name: "api-change" } });
    expect(cap.previews).toEqual([]);
    await expect(page.getByRole("dialog", { name: /Preview impact/ })).toHaveCount(0);
  });
});
