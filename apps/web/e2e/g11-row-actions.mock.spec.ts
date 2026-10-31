/**
 * G11 — lifecycle acts reachable from their list (against a mocked gateway). Each list row offers the act only where the
 * gateway would accept it, the row's button names the row, and it opens the SAME confirmation the deep surface uses:
 *
 *  - AI registry: Retire asks for the audited reason (the preview drawer's form) and posts it;
 *  - AI incidents: Close opens the incident page's dialog on the incident's own detail (root cause, lessons learned);
 *  - Executors (Engines page): Revoke asks for the executor's name to be typed, like the executor's detail;
 *  - Workflows: Abort is confirmed, for an instance that is not terminal.
 *
 * Each act also has a Cancel test (nothing is posted, focus is back on the row's button) and a refusal test (the
 * gateway's 409 or 403 is shown inline, not only as a toast).
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ISO = "2026-10-20T10:00:00.000Z";
const ME = "u-ada";

const useCase = (over: Record<string, unknown>) => ({
  description: "Suggests a credit-limit change for a reviewer to accept or refuse.",
  businessContext: "Retail lending",
  ownerUserId: "u-jordan",
  ownerName: "Jordan Owner",
  intendedAgentIds: [],
  dataSensitivity: "confidential",
  complianceTags: [],
  projectId: null,
  workflowInstanceId: null,
  euAiActTier: "high",
  decidedAt: ISO,
  retiredReason: null,
  createdAt: ISO,
  approvedUntil: "2027-04-20T10:00:00.000Z",
  openConditions: 0,
  ...over,
});
const USE_CASES = [
  useCase({ id: "uc-1", name: "Credit-limit-increase assistant", status: "approved" }),
  useCase({ id: "uc-2", name: "Statement summary helper", status: "retired", retiredReason: "Superseded", euAiActTier: "minimal" }),
];

const incident = (over: Record<string, unknown>) => ({
  severity: "medium",
  serious: false,
  seriousCriteria: [],
  detectionSource: "manual",
  awareAt: ISO,
  ownerUserId: ME,
  ownerName: "Ada Admin",
  useCaseId: "uc-1",
  useCaseName: "Credit-limit-increase assistant",
  createdAt: ISO,
  closedAt: null,
  clocks: { total: 0, open: 0, overdue: 0, nextDue: null },
  actions: { open: 0, overdue: 0 },
  ...over,
});
const INCIDENTS = [
  incident({ id: "inc-1", ref: "INC-00017", title: "Limit suggested above policy", status: "resolved" }),
  incident({ id: "inc-2", ref: "INC-00009", title: "Wrong customer segment", status: "closed", closedAt: ISO, ownerName: "Morgan Reyes", ownerUserId: "u-morgan" }),
];
const incidentDetail = {
  incident: {
    id: "inc-1",
    ref: "INC-00017",
    title: "Limit suggested above policy",
    summary: "The assistant suggested a limit above the team-17 policy ceiling.",
    severity: "medium",
    status: "resolved",
    detectionSource: "manual",
    sourceRef: null,
    occurredAt: null,
    awareAt: ISO,
    ownerUserId: ME,
    ownerName: "Ada Admin",
    useCaseId: "uc-1",
    serious: false,
    seriousCriteria: [],
    phiIndividuals: null,
    rootCause: null,
    lessonsLearned: null,
    closedAt: null,
    closedByName: null,
    createdByName: "Avery Approver",
    createdAt: ISO,
  },
  useCase: { id: "uc-1", name: "Credit-limit-increase assistant", euAiActTier: "high", euAiActRole: "deployer" },
  links: [],
  actions: [],
  notifications: [],
  events: [],
  evidenceHold: { setting: true, binds: false, paragraph: "Article 73(6)", quote: "" },
  gate: { mode: "enforce", holds: null },
  permissions: { canEdit: true, canClose: true, closeNeedsAdmin: false, isAdmin: true },
  disclaimer: "",
};

const executor = (over: Record<string, unknown>) => ({
  classesDeclared: ["user_space_kernel"],
  quarantineCode: null,
  runtimeVersion: "runsc release-20260901.0",
  declaredClass: null,
  lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
  openOffers: 0,
  attestationStrength: "software_attested",
  attestations: [],
  backend: "gvisor",
  ...over,
});
const EXECUTORS = [
  executor({ executorId: "e1", name: "team-17-sandbox", status: "active" }),
  executor({ executorId: "e2", name: "team-17-retired", status: "revoked" }),
];

const INSTANCES = [
  { id: "wf-1", status: "blocked_on_approval", createdAt: ISO, change: { description: "Raise the review threshold for team-17", changeType: "feature" } },
  { id: "wf-2", status: "completed", createdAt: ISO, change: { description: "Add rate limiting to the public API", changeType: "feature" } },
];

interface MockOpts {
  /** POST path → the refusal the gateway sends for it */
  refuse?: Record<string, { status: number; body: Record<string, unknown> }>;
  /** the incident detail the row's Close reads */
  incident?: typeof incidentDetail;
  /** hold the incident detail until this resolves (the dialog's busy state) */
  holdDetail?: Promise<void>;
}

/** the gateway, with every write captured */
async function mockApi(page: Page, opts: MockOpts = {}) {
  const writes: Array<{ path: string; body: unknown }> = [];
  const me = { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (req.method() === "POST") {
      writes.push({ path: p, body: req.postDataJSON() });
      const refusal = opts.refuse?.[p];
      return refusal ? json(route, refusal.body, refusal.status) : json(route, { status: "ok" });
    }
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/use-cases") return json(route, { useCases: USE_CASES });
    if (p === "/v1/incidents") return json(route, { incidents: INCIDENTS, scope: "all", disclaimer: "" });
    if (p === "/v1/incidents/inc-1") {
      await opts.holdDetail;
      return json(route, opts.incident ?? incidentDetail);
    }
    if (p === "/v1/executors") return json(route, { executors: EXECUTORS });
    if (p === "/v1/execution-profiles") return json(route, { profiles: [], reference: "restricted" });
    if (p === "/v1/execution-placements") return json(route, { placements: [], refusalsWithoutPlacement: [], attestationStrength: "software_attested" });
    if (p === "/v1/engines") return json(route, { engines: [] });
    if (p === "/v1/workflows/instances") return json(route, { instances: INSTANCES, changeTypes: ["feature"], routes: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    return json(route, {});
  });
  return { writes };
}

test.describe("G11 row actions", () => {
  test("AI registry: Retire asks for the audited reason and posts it; a retired use case offers none", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/admin/use-cases");
    await expect(page.getByRole("button", { name: "Retire Statement summary helper" })).toHaveCount(0);
    await page.getByRole("button", { name: "Retire Credit-limit-increase assistant" }).click();
    const dialog = page.getByRole("dialog", { name: "Retire Credit-limit-increase assistant?" });
    await expect(dialog).toBeVisible();
    // the row's click does not also open the preview drawer
    await expect(page.locator("#uc-preview-title")).toHaveCount(0);
    const confirm = dialog.getByRole("button", { name: "Retire use case" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Reason for retiring (recorded in the audit log)").fill("Superseded by a narrower use case");
    await confirm.click();
    await expect(dialog).toBeHidden();
    expect(api.writes).toEqual([{ path: "/v1/use-cases/uc-1/retire", body: { reason: "Superseded by a narrower use case" } }]);
  });

  test("AI incidents: Close opens the incident page's dialog and posts the root cause and lessons; a closed incident offers none", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/incidents");
    await page.getByLabel("Status").selectOption("all");
    await expect(page.getByRole("row", { name: /INC-00009/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Close INC-00009/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Close INC-00017 Limit suggested above policy" }).click();
    const dialog = page.getByRole("dialog", { name: "Close INC-00017" });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Close incident" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Root cause").fill("The policy ceiling for team-17 was not loaded.");
    await dialog.getByLabel("Lessons learned").fill("Check the ceiling on every release.");
    await confirm.click();
    await expect(dialog).toBeHidden();
    expect(api.writes).toEqual([
      { path: "/v1/incidents/inc-1/close", body: { rootCause: "The policy ceiling for team-17 was not loaded.", lessonsLearned: "Check the ceiling on every release." } },
    ]);
  });

  test("Executors: Revoke asks for the name to be typed and posts the revoke; a revoked executor offers none", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/admin/engines?tab=isolation"); // P3: executors are on the Isolation tab
    await expect(page.getByRole("button", { name: "Manage executor team-17-retired" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke executor team-17-retired" })).toHaveCount(0);
    await page.getByRole("button", { name: "Revoke executor team-17-sandbox" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke team-17-sandbox?" });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Revoke permanently" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("Type team-17-sandbox to confirm").fill("team-17-sandbox");
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("team-17-sandbox revoked")).toBeVisible();
    expect(api.writes).toEqual([{ path: "/v1/executors/e1/revoke", body: {} }]);
  });

  test("Workflows: Abort is confirmed and posts the abort; a completed workflow offers none", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/workflows");
    await expect(page.getByRole("link", { name: /Add rate limiting to the public API/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abort Add rate limiting to the public API" })).toHaveCount(0);
    await page.getByRole("button", { name: "Abort Raise the review threshold for team-17" }).click();
    const dialog = page.getByRole("dialog", { name: "Abort Raise the review threshold for team-17?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Aborting is final");
    // the row's click does not also navigate to the workflow
    await expect(page).toHaveURL(/\/ui\/workflows$/);
    await dialog.getByRole("button", { name: "Abort workflow" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Workflow aborted")).toBeVisible();
    expect(api.writes).toEqual([{ path: "/v1/workflows/instances/wf-1/abort", body: {} }]);
  });

  test("AI registry: Cancel on Retire posts nothing and returns focus to the row's button", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/admin/use-cases");
    const row = page.getByRole("button", { name: "Retire Credit-limit-increase assistant" });
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Retire Credit-limit-increase assistant?" });
    await dialog.getByLabel("Reason for retiring (recorded in the audit log)").fill("Not needed");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeFocused();
    expect(api.writes).toEqual([]);
  });

  test("AI registry: a refused Retire is shown inside the dialog, which stays open", async ({ page }) => {
    const api = await mockApi(page, { refuse: { "/v1/use-cases/uc-1/retire": { status: 409, body: { error: "use_case_already_retired" } } } });
    await page.goto("/ui/admin/use-cases");
    await page.getByRole("button", { name: "Retire Credit-limit-increase assistant" }).click();
    const dialog = page.getByRole("dialog", { name: "Retire Credit-limit-increase assistant?" });
    await dialog.getByLabel("Reason for retiring (recorded in the audit log)").fill("Superseded by a narrower use case");
    await dialog.getByRole("button", { name: "Retire use case" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(api.writes).toHaveLength(1);
  });

  test("AI incidents: Close answers the click with a busy dialog while the incident is read", async ({ page }) => {
    let release = () => {};
    const holdDetail = new Promise<void>((r) => (release = r));
    await mockApi(page, { holdDetail });
    await page.goto("/ui/incidents");
    await page.getByRole("button", { name: "Close INC-00017 Limit suggested above policy" }).click();
    const busy = page.getByRole("dialog", { name: "Close incident" });
    await expect(busy.getByText("Loading the incident…")).toBeVisible();
    await expect(busy.getByRole("status", { name: "Loading" })).toBeVisible();
    release();
    await expect(page.getByRole("dialog", { name: "Close INC-00017" })).toBeVisible();
  });

  test("AI incidents: Cancel on Close posts nothing and returns focus to the row's button", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/incidents");
    const row = page.getByRole("button", { name: "Close INC-00017 Limit suggested above policy" });
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Close INC-00017" });
    await dialog.getByLabel("Root cause").fill("Not yet known");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeFocused();
    expect(api.writes).toEqual([]);
  });

  test("AI incidents: a refused Close is shown inside the dialog, which stays open", async ({ page }) => {
    const api = await mockApi(page, { refuse: { "/v1/incidents/inc-1/close": { status: 403, body: { error: "forbidden" } } } });
    await page.goto("/ui/incidents");
    await page.getByRole("button", { name: "Close INC-00017 Limit suggested above policy" }).click();
    const dialog = page.getByRole("dialog", { name: "Close INC-00017" });
    await dialog.getByLabel("Root cause").fill("The policy ceiling for team-17 was not loaded.");
    await dialog.getByLabel("Lessons learned").fill("Check the ceiling on every release.");
    await dialog.getByRole("button", { name: "Close incident" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(api.writes).toHaveLength(1);
  });

  test("AI incidents: an open notification clock and an open corrective action block Close from the row", async ({ page }) => {
    const blocked = {
      ...incidentDetail,
      notifications: [{ id: "n-1", status: "pending" }],
      actions: [{ id: "a-1", status: "open" }],
    } as unknown as typeof incidentDetail;
    const api = await mockApi(page, { incident: blocked });
    await page.goto("/ui/incidents");
    await page.getByRole("button", { name: "Close INC-00017 Limit suggested above policy" }).click();
    const dialog = page.getByRole("dialog", { name: "Close INC-00017" });
    await expect(dialog.getByText("1 notification clock is not final")).toBeVisible();
    await expect(dialog.getByText("1 corrective action is still open")).toBeVisible();
    await dialog.getByLabel("Root cause").fill("The policy ceiling for team-17 was not loaded.");
    await dialog.getByLabel("Lessons learned").fill("Check the ceiling on every release.");
    await expect(dialog.getByRole("button", { name: "Close incident" })).toBeDisabled();
    expect(api.writes).toEqual([]);
  });

  test("Executors: Cancel on Revoke posts nothing and returns focus to the row's button", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/admin/engines?tab=isolation"); // P3: executors are on the Isolation tab
    const row = page.getByRole("button", { name: "Revoke executor team-17-sandbox" });
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Revoke team-17-sandbox?" });
    await dialog.getByLabel("Type team-17-sandbox to confirm").fill("team-17-sandbox");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeFocused();
    expect(api.writes).toEqual([]);
  });

  test("Executors: a refused Revoke is shown inline on the executors card", async ({ page }) => {
    const api = await mockApi(page, { refuse: { "/v1/executors/e1/revoke": { status: 409, body: { error: "executor_already_revoked" } } } });
    await page.goto("/ui/admin/engines?tab=isolation"); // P3: executors are on the Isolation tab
    await page.getByRole("button", { name: "Revoke executor team-17-sandbox" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke team-17-sandbox?" });
    await dialog.getByLabel("Type team-17-sandbox to confirm").fill("team-17-sandbox");
    await dialog.getByRole("button", { name: "Revoke permanently" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "This executor is already revoked." })).toBeVisible();
    expect(api.writes).toHaveLength(1);
  });

  test("Workflows: Cancel on Abort posts nothing and returns focus to the row's button", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/ui/workflows");
    const row = page.getByRole("button", { name: "Abort Raise the review threshold for team-17" });
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Abort Raise the review threshold for team-17?" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeFocused();
    expect(api.writes).toEqual([]);
  });

  test("Workflows: a refused Abort is shown inside the dialog, which stays open until the call settles", async ({ page }) => {
    const api = await mockApi(page, { refuse: { "/v1/workflows/instances/wf-1/abort": { status: 409, body: { error: "instance_terminal" } } } });
    await page.goto("/ui/workflows");
    await page.getByRole("button", { name: "Abort Raise the review threshold for team-17" }).click();
    const dialog = page.getByRole("dialog", { name: "Abort Raise the review threshold for team-17?" });
    await dialog.getByRole("button", { name: "Abort workflow" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog).toBeVisible();
    await expect(page.getByText("Workflow aborted")).toHaveCount(0);
    expect(api.writes).toHaveLength(1);
  });
});
