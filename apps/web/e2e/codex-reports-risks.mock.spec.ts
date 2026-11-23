/**
 * Codex review cards on the Reports and Risks pages, against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - CXR-REV-002: a definition is ARCHIVED, never deleted. The action opens a confirmation that says its schedules
 *    stop and its N generated runs are kept; Cancel sends nothing, Archive sends the archive request and never DELETE.
 *  - CXR-REV-001: the schedules copy follows `schedulerPresent` instead of always saying nothing fires them.
 *  - CXR-REV-005: workflow figures render in the generated report and in a stored run (one renderer), and a null
 *    median reads "not measured".
 *  - CXR-REV-003: the risk register pages through the list contract and shows where it is ("1–10 of 25").
 *  - CXR-REV-004: a transition reason typed for one risk is not shown on another.
 *
 * Synthetic names and example hosts only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000c6`;
const T = "2026-11-20T12:00:00.000Z";
const ME = { userId: U(99), isAdmin: true, user: { id: U(99), email: "ada@example.test", displayName: "Ada Admin" } };

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
}
type Handler = (req: { method: string; url: URL; body: unknown }) => unknown;

async function mockApi(page: Page, routes: Record<string, Handler | unknown>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method: req.method(), path: p, search: url.searchParams });
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    const h = routes[`${req.method()} ${p}`];
    if (h === undefined) return json(route, {});
    const out = typeof h === "function" ? (h as Handler)({ method: req.method(), url, body }) : h;
    if (out && typeof out === "object" && "status" in (out as Json) && "body" in (out as Json)) {
      const o = out as { status: number; body: unknown };
      return json(route, o.body, o.status);
    }
    return json(route, out);
  });
  return calls;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const DEF = U(1);
const RUN_ID = U(2);
const WORKFLOW_ONLY = {
  definitionName: "Approvals throughput",
  period: { label: "November 2026", start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" },
  disclaimer: "Spend figures are list-price estimates.",
  workflow: { basis: "approvals", approvalsRequested: 4, approvalsDecided: 3, approvalsPending: 1, approvalsApproved: 2, approvalsDenied: 1, medianDecisionMinutes: null },
};
const definition = (over: Json = {}) => ({
  id: DEF,
  name: "Board exec summary",
  kind: "exec_summary",
  scopeKind: "org",
  scopeId: null,
  period: "current_month",
  format: "json",
  entitlementScope: "org",
  description: null,
  status: "active",
  lastGeneratedAt: T,
  runCount: 3,
  schedules: [{ id: U(3), definitionId: DEF, cadence: "monthly", enabled: true, recipientUserIds: null, lastGeneratedAt: null, lastRunId: null }],
  ...over,
});
const run = { id: RUN_ID, definitionId: DEF, scheduleId: null, requestedByUserId: U(99), trigger: "manual", period: "current_month", periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-12-01T00:00:00.000Z", entitlementScope: "org", effectiveProjectIds: null, format: "json", rowCount: 4, generatedAt: T };

function reportsRoutes(schedulerPresent: boolean, archived: { done: boolean }): Record<string, Handler | unknown> {
  return {
    "GET /v1/reports/overview": () => ({ definitions: archived.done ? [] : [definition()], schedulerPresent, note: "" }),
    "GET /v1/reports/runs": { runs: [run] },
    [`GET /v1/reports/runs/${RUN_ID}`]: { run: { ...run, payload: WORKFLOW_ONLY } },
    [`POST /v1/reports/definitions/${DEF}/archive`]: () => {
      archived.done = true;
      return { definition: definition({ status: "archived" }), archived: true, deleted: false, schedulesDisabled: 1, runsKept: 3 };
    },
    [`POST /v1/reports/definitions/${DEF}/generate`]: {
      run: { id: RUN_ID },
      report: WORKFLOW_ONLY,
      scope: { entitlementScope: "org", effectiveProjectIds: null, reason: "admin, org-scoped definition" },
    },
    "GET /v1/teams": { teams: [] },
    "GET /v1/projects": { projects: [] },
    "GET /v1/users": { users: [] },
  };
}

test.describe("CXR: Reports", () => {
  test("archive asks first, says the schedules stop and the runs are kept, and never deletes", async ({ page }) => {
    const calls = await mockApi(page, reportsRoutes(false, { done: false }));
    await page.goto("/ui/admin/reports");
    await page.getByRole("button", { name: "Archive Board exec summary" }).click();
    const dialog = page.getByRole("dialog", { name: "Archive Board exec summary?" });
    await expect(dialog).toContainText("Its 1 schedule is disabled and stops firing.");
    await expect(dialog).toContainText("The 3 generated runs are kept and stay readable in the run history.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);

    await page.getByRole("button", { name: "Archive Board exec summary" }).click();
    await page.getByRole("dialog", { name: "Archive Board exec summary?" }).getByRole("button", { name: "Archive", exact: true }).click();
    await expect.poll(() => calls.filter((c) => c.method === "POST" && c.path === `/v1/reports/definitions/${DEF}/archive`).length).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    await expect(page.getByText("Definition archived: 1 schedule(s) stopped, 3 run(s) kept")).toBeVisible();
  });

  test("with no scheduler the schedules copy says nothing fires them", async ({ page }) => {
    await mockApi(page, reportsRoutes(false, { done: false }));
    await page.goto("/ui/admin/reports");
    await expect(page.getByRole("note").filter({ hasText: "Nothing in this deployment fires these" })).toBeVisible();
    await expect(page.getByText("never — nothing drives this")).toBeVisible();
  });

  test("with the scheduler on the copy says it fires them, and never that nothing does", async ({ page }) => {
    await mockApi(page, reportsRoutes(true, { done: false }));
    await page.goto("/ui/admin/reports");
    await expect(page.getByRole("note").filter({ hasText: "The in-process scheduler fires these" })).toBeVisible();
    await expect(page.getByText(/Nothing in this deployment fires/)).toHaveCount(0);
    await expect(page.getByText("never — nothing drives this")).toHaveCount(0);
    await expect(page.getByText("never yet", { exact: true })).toBeVisible();
  });

  test("workflow figures render in the generated report and in the stored run, a null median as not measured", async ({ page }) => {
    await mockApi(page, reportsRoutes(false, { done: false }));
    await page.goto("/ui/admin/reports");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const card = page.locator("[data-rg-card]").filter({ hasText: "Approvals throughput — November 2026" }).first();
    await expect(card.getByText("Approvals requested")).toBeVisible();
    await expect(card.getByText("3 (2 approved, 1 denied)")).toBeVisible();
    await expect(card.getByText(/not measured/)).toBeVisible();
    await expect(card.getByText("This run's stored report carries no summary figures.")).toHaveCount(0);

    await page.getByRole("button", { name: /Open the .* run from/ }).click();
    const dialog = page.getByRole("dialog", { name: "Report run" });
    await expect(dialog.getByText("Approvals pending")).toBeVisible();
    await expect(dialog.getByText(/not measured/)).toBeVisible();
    await expect(dialog.getByText("This run's stored report carries no summary figures.")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Risks
// ---------------------------------------------------------------------------

const riskRow = (i: number) => ({
  id: U(100 + i),
  title: `Synthetic risk ${String(i).padStart(2, "0")}`,
  description: "A synthetic scenario.",
  category: "tool_misuse",
  ownerUserId: U(99),
  ownerName: "Ada Admin",
  projectId: null,
  agentId: null,
  useCaseId: null,
  status: "open",
  likelihood: "medium",
  impact: "high",
  mitigation: null,
  acceptedByUserId: null,
  acceptedAt: null,
  acceptanceNote: null,
  createdAt: T,
  controls: [],
});
const ALL = Array.from({ length: 25 }, (_, i) => riskRow(i));

function risksRoutes(): Record<string, Handler | unknown> {
  const routes: Record<string, Handler | unknown> = {
    "GET /v1/risks/library": { library: [], disclaimer: "d" },
    "GET /v1/risks/scenarios": { scenarios: [], note: "" },
    "GET /v1/risks": ({ url }: { url: URL }) => {
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const start = url.searchParams.get("cursor") === "c1" ? 10 : url.searchParams.get("cursor") === "c2" ? 20 : 0;
      const items = ALL.slice(start, start + limit);
      const next = start + limit < ALL.length ? (start === 0 ? "c1" : "c2") : null;
      return { items, nextCursor: next, nextOffset: null, total: ALL.length, totalIsEstimate: false, disclaimer: "d" };
    },
    "GET /v1/risk-tolerances": { source: "default", strictDefault: { maxBand: "medium" }, tolerances: [], effective: { categories: {}, tiers: {} }, bands: ["none", "low", "medium", "high", "critical"] },
    "GET /v1/agents": { agents: [] },
    "GET /v1/projects": { projects: [] },
  };
  for (const r of ALL) {
    routes[`GET /v1/risks/${r.id}`] = {
      risk: r,
      declared: { likelihood: r.likelihood, impact: r.impact, status: r.status, mitigation: null, acceptance: null, treatment: null, note: "n" },
      treatments: { enabled: false },
      evidence: { window: { start: T, end: T, days: 90 }, scope: { projectId: null, agentId: null }, entries: [], computedAt: T, note: "live", disclaimer: "d" },
    };
    routes[`GET /v1/risks/${r.id}/acceptances`] = {
      riskId: r.id,
      position: { riskId: r.id, band: "medium", tolerance: { band: "medium", source: "default" }, acceptance: null, aboveTolerance: false, maxAcceptanceMonths: 12, maxExpiresAt: T },
      canAccept: false,
      acceptRefusal: "not_an_acceptor",
      acceptances: [],
    };
  }
  return routes;
}

test.describe("CXR: Risks", () => {
  test("the register pages through the list contract and says where it is", async ({ page }) => {
    const calls = await mockApi(page, risksRoutes());
    await page.goto("/ui/admin/risks");
    await expect(page.getByText("Synthetic risk 00")).toBeVisible();
    await expect(page.getByText("1–10 of 25")).toBeVisible();
    const first = calls.filter((c) => c.path === "/v1/risks").pop()!;
    expect(first.search.get("count")).toBe("exact");
    expect(first.search.get("limit")).toBe("10");
    await expect(page.getByText("Synthetic risk 10")).toHaveCount(0);
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByText("Synthetic risk 10")).toBeVisible();
    await expect(page.getByText("11–20 of 25")).toBeVisible();
    expect(calls.filter((c) => c.path === "/v1/risks").pop()!.search.get("cursor")).toBe("c1");
  });

  test("a transition reason belongs to the risk it was typed for", async ({ page }) => {
    await mockApi(page, risksRoutes());
    await page.goto("/ui/admin/risks");
    await page.getByRole("button", { name: "Details: Synthetic risk 00" }).first().click();
    const reason = page.getByLabel("Transition reason — required and audited");
    await expect(reason).toHaveCount(1);
    await reason.fill("guardrail rollout under way");
    await page.getByRole("button", { name: "Details: Synthetic risk 01" }).first().click();
    await expect(page.getByLabel("Transition reason — required and audited")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Start mitigating" })).toBeDisabled();
    await page.getByRole("button", { name: "Details: Synthetic risk 00" }).first().click();
    await expect(page.getByLabel("Transition reason — required and audited")).toHaveValue("guardrail rollout under way");
  });
});
