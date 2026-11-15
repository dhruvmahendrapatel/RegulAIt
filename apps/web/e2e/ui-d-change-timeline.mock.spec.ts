/**
 * Lane UI-D, D4: the governed change on a workflow's detail page, against a
 * mocked gateway (the *.mock.spec.ts harness).
 *
 *  - the seven-step chain (work item, plan, sign-off, agent build, pull request,
 *    checks, merge approval) reads each step's state from the template's own
 *    stages, in words, and a step the template lacks is never "Done";
 *  - a failed links read says it could not tell, never "No work item linked";
 *  - a 404 from the links route is "not visible to you", and a rolled-back change never shows Checks done;
 *  - the history lists every recorded event in the server's order, with who acted;
 *  - axe (WCAG 2.x A/AA) in light and dark, and no sideways scroll at 390 px.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const INST = "44444444-4444-4444-8444-444444444444";
const ME = { id: "ada", isAdmin: true, displayName: "Ada Admin" };

const STAGES = [
  { id: "intake", type: "trigger" },
  { id: "plan", type: "planning" },
  { id: "requirements", type: "artifact_generation", output: "requirements" },
  { id: "plan_signoff", type: "human_approval" },
  { id: "agent_build", type: "automated_build" },
  { id: "open_pr", type: "git_operation" },
  { id: "ci", type: "automated_check" },
  { id: "merge_approval", type: "human_approval" },
];

const EVENTS = [
  // oldest first, as the server returns them
  { id: "e1", at: "2026-11-15T09:00:00Z", actorUserId: "ada", event: { kind: "start" } },
  { id: "e2", at: "2026-11-15T09:30:00Z", actorUserId: "ada", event: { kind: "artifact_submitted", stageId: "requirements" } },
  { id: "e3", at: "2026-11-15T10:05:00Z", actorUserId: "avery", event: { kind: "approval_granted", stageId: "plan_signoff" } },
  { id: "e4", at: "2026-11-15T10:06:00Z", actorUserId: null, event: { kind: "execute_stage", stageId: "agent_build" } },
];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

type Opts = { linksStatus?: number; stages?: typeof STAGES; instance?: Record<string, unknown> };
async function mockGateway(page: Page, opts: Opts = {}) {
  const stages = opts.stages ?? STAGES;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me")
      return json(route, {
        userId: ME.id, isAdmin: ME.isAdmin, via: "session",
        user: { id: ME.id, email: `${ME.id}@example.test`, displayName: ME.displayName },
        mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false,
      });
    if (p === "/v1/me") return json(route, { userId: ME.id, isAdmin: ME.isAdmin, user: { id: ME.id, email: `${ME.id}@example.test`, displayName: ME.displayName } });
    if (p === `/v1/workflows/instances/${INST}`)
      return json(route, {
        instance: {
          id: INST, status: "awaiting_execution", createdAt: "2026-11-15T09:00:00Z", initiatorUserId: "ada",
          change: { description: "Add retry to the invoice export", changeType: "code-change", environment: "dev" },
          definition: { stages },
          state: { currentStageIndex: 4, stageStatuses: { 0: "completed", 1: "completed", 2: "completed", 3: "completed", 4: "active" } },
          context: {},
          ...opts.instance,
        },
        events: EVENTS,
        artifacts: [],
        pendingApprovals: [],
      });
    if (p === "/v1/pm/links") {
      if (opts.linksStatus) return json(route, { error: opts.linksStatus === 404 ? "not_found" : "upstream_unavailable" }, opts.linksStatus);
      return json(route, {
        links: [{
          id: "l1", connectionId: "c1", connectionName: "boards", objectType: "workflow_instance", objectId: INST, nodeId: null,
          externalId: "1234", externalUrl: "https://boards.example.test/1234", lastSyncedAt: "2026-11-15T09:01:00Z", drift: false,
        }],
      });
    }
    if (p === "/v1/decisions") return json(route, { decisions: [] });
    return json(route, {});
  });
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("UI-D D4: the governed change", () => {
  test("the chain names each step's state in words, from the template", async ({ page }) => {
    await mockGateway(page);
    await page.goto(`/ui/workflows/${INST}`);
    const steps = page.getByRole("list", { name: "Governed change steps" }).getByRole("listitem");
    await expect(steps).toHaveCount(7);
    await expect(steps.nth(0)).toContainText("Work item");
    await expect(steps.nth(0)).toContainText("1 linked work item");
    await expect(steps.nth(1)).toContainText("Done");
    await expect(steps.nth(2)).toContainText("Plan sign-off");
    await expect(steps.nth(2)).toContainText("Done");
    await expect(steps.nth(3)).toContainText("Agent build");
    await expect(steps.nth(3)).toContainText("In progress");
    await expect(steps.nth(3)).toHaveAttribute("aria-current", "step");
    await expect(steps.nth(6)).toContainText("Not started");
    await expectAxeClean(page, "workflow detail with the governed change");
  });

  test("a step the template lacks says so, and is never done", async ({ page }) => {
    await mockGateway(page, { stages: STAGES.filter((s) => s.type !== "automated_check") });
    await page.goto(`/ui/workflows/${INST}`);
    const checks = page.getByRole("list", { name: "Governed change steps" }).getByRole("listitem").filter({ hasText: "Checks" });
    await expect(checks).toContainText("Not in this template");
    await expect(checks).not.toContainText("Done");
  });

  test("a failed links read is not shown as no work item", async ({ page }) => {
    await mockGateway(page, { linksStatus: 503 });
    await page.goto(`/ui/workflows/${INST}`);
    const item = page.getByRole("list", { name: "Governed change steps" }).getByRole("listitem").first();
    await expect(item).toContainText("Could not read the linked work items");
    await expect(item).toContainText("Unknown");
    await expect(item).not.toContainText("No work item linked");
    await expect(item.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("a reader the links route does not admit is told the items are not visible, not that the read failed", async ({ page }) => {
    await mockGateway(page, { linksStatus: 404 });
    await page.goto(`/ui/workflows/${INST}`);
    const item = page.getByRole("list", { name: "Governed change steps" }).getByRole("listitem").first();
    await expect(item).toContainText("The linked work items are not visible to you");
    await expect(item).not.toContainText("Could not read");
  });

  test("a rolled-back change never shows Checks as done, though the kernel completed the stage", async ({ page }) => {
    await mockGateway(page, {
      instance: {
        status: "rolled_back",
        state: { currentStageIndex: 7, stageStatuses: Object.fromEntries(STAGES.map((_, i) => [i, "completed"])) },
        context: { "checks:ci": [{ check: "smoke", status: "failed" }] },
      },
    });
    await page.goto(`/ui/workflows/${INST}`);
    const checks = page.getByRole("list", { name: "Governed change steps" }).getByRole("listitem").filter({ hasText: "Checks" });
    await expect(checks).toContainText("Needs attention");
    await expect(checks).toContainText("1 check failed");
    await expect(checks).not.toContainText("Done");
  });

  test("the history lists every event, and who acted", async ({ page }) => {
    await mockGateway(page);
    await page.goto(`/ui/workflows/${INST}`);
    const history = page.locator("ol").filter({ hasText: "Workflow started" });
    const rows = history.getByRole("listitem");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("Workflow started");
    await expect(rows.nth(1)).toContainText("Artifact submitted at requirements");
    await expect(rows.nth(2)).toContainText("Sign-off granted at plan sign-off");
    await expect(rows.nth(3)).toContainText("Stage agent build started running");
    await expect(rows.nth(3)).toContainText("System");
    await expect(rows.nth(0)).toContainText("Ada Admin");
  });

  test("no sideways scroll at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockGateway(page);
    await page.goto(`/ui/workflows/${INST}`);
    await expect(page.getByRole("list", { name: "Governed change steps" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
