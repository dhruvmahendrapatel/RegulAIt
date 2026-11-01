/**
 * Batch I-2 rollout A (owner, #453): the approved Tabs and Control-matrix patterns on two more pages, against a
 * mocked gateway (the *.mock.spec.ts harness).
 *
 *  - Review workbench (tabs): the queue's status row stays above the tabs, so a breach shows on every tab; each tab
 *    names its tabpanel; a half-typed policy survives a tab switch (the panels stay mounted); a pending queue that
 *    fails to load reads as an error with Retry, never as "nothing breached".
 *  - Execution control (control matrix): one table of what is stopped (Control · State · Source · Fix · While on, it
 *    refuses), with the lift on each row; each tab label names what is stopped inside it, and a clear tab shows only
 *    its name.
 *  - axe (WCAG 2.x A/AA, light and dark) on each, through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000a3`;
const T = "2026-10-20T12:00:00.000Z";
const ME = { userId: U(99), isAdmin: true, user: { id: U(99), email: "ada@example.test", displayName: "Ada Admin" } };

/** a table of `METHOD /path` (or `METHOD /path?query`) → body, or a status and body; anything else answers `{}` */
async function mockApi(page: Page, routes: Record<string, unknown>) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    const h = routes[`${req.method()} ${p}${url.search}`] ?? routes[`${req.method()} ${p}`];
    if (h === undefined) return json(route, {});
    if (h && typeof h === "object" && "status" in h && "body" in h) {
      const r = h as { status: number; body: unknown };
      return json(route, r.body, r.status);
    }
    return json(route, h);
  });
}

// ---------------------------------------------------------------------------

const pending = (n: number, slaState: "ok" | "warning" | "breached") => ({
  id: U(n),
  status: "pending",
  objectType: "workflow",
  objectLabel: `Workflow stage sign-off ${n}`,
  stageId: null,
  requestedAt: T,
  userId: U(1),
  approverUserId: U(2),
  approverName: "Avery Approver",
  assignment: { assigneeKind: "team", assigneeId: U(30), claimedByUserId: null, claimable: true, slaState, dueAt: T, escalationAssigneeKind: null },
});
const WORKBENCH = {
  "GET /v1/approvals/sla-policies": {
    policies: [{ id: U(10), name: "Standard", warnAfterMinutes: 60, breachAfterMinutes: 240, escalateAction: "add_assignee", escalateToKind: "user", escalateToId: U(2), enabled: true }],
    note: "Breach is evaluated when the queue is read.",
  },
  "GET /v1/approvals/assignment-rules": { rules: [], note: "Routing decides whose queue, not who may act." },
  "GET /v1/approvals/workload": {
    workload: [{ kind: "team", id: U(30), name: "Risk reviewers", open: 3, dueSoon: 1, breached: 1 }],
    note: "Open approvals per queue.",
  },
  "GET /v1/approvals?status=pending&order=asc": { approvals: [pending(1, "breached"), pending(2, "warning"), pending(3, "ok")], total: 3, hasMore: false, limit: 100 },
  "GET /v1/users": { users: [{ id: U(2), email: "avery@example.test", displayName: "Avery Approver" }] },
  "GET /v1/teams": { teams: [{ id: U(30), name: "Risk reviewers" }] },
  "GET /v1/projects": { projects: [] },
};

test.describe("I-2 rollout A: Review workbench keeps its queue status above the tabs", () => {
  test("the status row shows on every tab, each tab names its panel, and a draft survives a switch", async ({ page }) => {
    await mockApi(page, WORKBENCH);
    await page.goto("/ui/admin/review-workbench");
    await expect(page.getByRole("heading", { name: "Review workbench", level: 1 })).toBeVisible();
    const tablist = page.getByRole("tablist", { name: "Review workbench" });
    const names = ["Triage", "Workload", "SLA policies", "Routing rules"];
    await expect(tablist.getByRole("tab")).toHaveText(names);
    const status = page.getByRole("group", { name: "Review queue status" });

    // Triage opens first: the work itself
    await expect(tablist.getByRole("tab", { name: "Triage" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel(`select ${U(1)}`)).toBeVisible();

    for (const name of names) {
      const tab = tablist.getByRole("tab", { name, exact: true });
      await tab.click();
      // the tab and its panel name each other
      const panelId = await tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = page.locator(`#${panelId}`);
      await expect(panel).toHaveAttribute("role", "tabpanel");
      await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id"))!);
      await expect(panel).toBeVisible();
      await expect(page.getByRole("tabpanel")).toHaveCount(1);
      // the breach and the sweep are visible whichever tab is open
      await expect(status.getByText("SLA breached: 1")).toBeVisible();
      await expect(status.getByText("Due soon: 1")).toBeVisible();
      await expect(status.getByText("Pending: 3")).toBeVisible();
      await expect(status.getByRole("button", { name: "Run SLA sweep" })).toBeVisible();
    }

    // the step-up and refusal copy moved, it did not go
    await tablist.getByRole("tab", { name: "Routing rules" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("A rule with no conditions is refused.");

    // panels stay mounted: a half-typed policy is still there after a trip to another tab
    await tablist.getByRole("tab", { name: "SLA policies" }).click();
    await page.getByRole("tabpanel").getByLabel("Name").fill("Out-of-hours escalation");
    await tablist.getByRole("tab", { name: "Triage" }).click();
    await tablist.getByRole("tab", { name: "SLA policies" }).click();
    await expect(page.getByRole("tabpanel").getByLabel("Name")).toHaveValue("Out-of-hours escalation");

    // the tablist moves by keyboard
    await tablist.getByRole("tab", { name: "SLA policies" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tablist.getByRole("tab", { name: "Routing rules" })).toHaveAttribute("aria-selected", "true");
    await expect(tablist.getByRole("tab", { name: "Routing rules" })).toBeFocused();

    await tablist.getByRole("tab", { name: "Triage" }).click();
    await expectAxeClean(page, "Review workbench, Triage tab");
  });

  test("a pending queue that fails to load is an error with Retry, never 'nothing breached'", async ({ page }) => {
    await mockApi(page, { ...WORKBENCH, "GET /v1/approvals?status=pending&order=asc": { status: 503, body: { error: "unavailable" } } });
    await page.goto("/ui/admin/review-workbench");
    const status = page.getByRole("group", { name: "Review queue status" });
    await expect(status.getByRole("alert")).toContainText("Couldn't load the pending queue");
    await expect(status.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(status.getByText(/SLA breached/)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------

const execution = (stopped: boolean) => ({
  mode: stopped ? "halted" : "normal",
  meaning: stopped ? "Every governed call is refused." : "Every governed call is decided by the ordinary rules.",
  reason: stopped ? "incident drill" : null,
  setAt: stopped ? T : null,
  setByUserId: stopped ? U(99) : null,
  haltedAgents: stopped ? [{ id: U(40), name: "claims-triage-agent", haltedAt: T, reason: "returning injected content" }] : [],
  haltedTools: stopped ? [{ serverId: U(50), name: "write_file", haltedAt: T, reason: "vendor advisory VA-2026-11" }] : [],
  summary: stopped ? "Execution is halted" : "Nothing is stopped.",
  note: "Reading, discovery and the approvals queue keep running.",
  scheduledSweepsNote: "Governance sweeps keep running.",
});
const EXEC_LISTS = {
  "GET /v1/agents": { agents: [{ id: U(40), name: "claims-triage-agent" }] },
  "GET /v1/servers": { servers: [{ id: U(50), name: "repo-tools" }] },
  "GET /v1/users": { users: [{ id: U(2), email: "avery@example.test", displayName: "Avery Approver" }] },
  "GET /v1/demo/beats": { beats: [] },
};

test.describe("I-2 rollout A: Execution control shows what is stopped as one control matrix", () => {
  test("every stop is a row with its source and its lift; tab labels name what is stopped inside them", async ({ page }) => {
    await mockApi(page, { ...EXEC_LISTS, "GET /v1/execution": execution(true) });
    await page.goto("/ui/admin/execution");
    await expect(page.getByRole("heading", { name: "Execution control", level: 1 })).toBeVisible();
    // the stop is still the headline
    await expect(page.getByText("Execution is halted")).toBeVisible();
    await expect(page.getByRole("group", { name: "Right now" })).toContainText("Deployment: halted");

    const matrix = page.locator("table", { has: page.getByRole("cell", { name: "Fix", exact: true }) });
    await expect(matrix.getByRole("row").first().getByRole("cell")).toHaveText(["Control", "State", "Source", "Fix", "While on, it refuses"]);
    const deployment = matrix.getByRole("row", { name: /Deployment-wide mode/ });
    await expect(deployment).toContainText("Reason given: incident drill");
    await expect(deployment.getByRole("button", { name: "Resume" })).toBeEnabled();
    const agent = matrix.getByRole("row", { name: /claims-triage-agent/ });
    await expect(agent).toContainText("Halted agents");
    await expect(agent).toContainText("returning injected content");
    const tool = matrix.getByRole("row", { name: /write_file/ });
    await expect(tool).toContainText("Halted tools");
    await expect(tool).toContainText("Server: repo-tools");

    // the lift on the row opens the same reason box as before
    await tool.getByRole("button", { name: "Lift" }).click();
    await expect(page.getByRole("dialog", { name: "Lift the halt on write_file" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    const tablist = page.getByRole("tablist", { name: "Execution controls" });
    await expect(tablist.getByRole("tab")).toHaveText(["Deployment-wide · halted", "One agent or tool · 2 halted"]);
    // the dial is open by default, so Halt everything is one click from the top
    await expect(page.getByRole("tabpanel").getByRole("row", { name: /Halt everything/ })).toBeVisible();
    await tablist.getByRole("tab", { name: /^One agent or tool/ }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", "execution-tab-one");
    await expect(panel.getByRole("button", { name: "Halt tool" })).toBeDisabled();
    await expectAxeClean(page, "Execution control, halted");
  });

  test("with nothing stopped the matrix says so and the tab labels show only their names", async ({ page }) => {
    await mockApi(page, { ...EXEC_LISTS, "GET /v1/execution": execution(false) });
    await page.goto("/ui/admin/execution");
    await expect(page.getByText("Nothing is stopped", { exact: true })).toBeVisible();
    const matrix = page.locator("table", { has: page.getByRole("cell", { name: "Fix", exact: true }) });
    await expect(matrix.getByRole("row")).toHaveCount(2); // the header and the dial
    await expect(matrix.getByRole("row", { name: /Deployment-wide mode/ })).toContainText("Nothing to do");
    await expect(page.getByRole("tablist", { name: "Execution controls" }).getByRole("tab")).toHaveText(["Deployment-wide", "One agent or tool"]);
  });
});
