/**
 * Batch I-2 rollout C (owner, #453, pattern 4): one empty state instead of many stacked empty cards, against a
 * mocked gateway (the *.mock.spec.ts harness).
 *
 * On Spend & savings, Reports and Data lineage:
 *  - while nothing exists, exactly one empty state shows, with its primary action, and the page's warnings stay;
 *  - a failed read is never shown as empty: it says it failed, with Retry;
 *  - as soon as anything exists, the page renders its sections as before.
 *  - axe (WCAG 2.x A/AA, light and dark) on each empty state, through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000c3`;
const T = "2026-10-20T12:00:00.000Z";
const ME_ID = U(99);
const ME = { userId: ME_ID, isAdmin: true, user: { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" } };

/** an answer with a status, for a read that fails */
const fail = (status: number, body: unknown = { error: "internal" }) => ({ __status: status, body });

/** a table of `METHOD /path` → body (or a fail()); anything else answers `{}` */
async function mockApi(page: Page, routes: Record<string, unknown>) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    const h = routes[`${req.method()} ${p}`];
    if (h === undefined) return json(route, {});
    if (h && typeof h === "object" && "__status" in h) {
      const f = h as { __status: number; body: unknown };
      return json(route, f.body, f.__status);
    }
    return json(route, h);
  });
}

/** "No … yet" / "Nothing … yet" headings in the main region: the page's empty states */
const emptyTitles = (page: Page) => page.locator("main").getByText(/^No .* yet$|^Nothing .* yet$/);

// ---------------------------------------------------------------------------

const EMPTY_SUMMARY = (groupBy: string) => ({
  groupBy,
  userId: ME_ID,
  window: { from: "2026-09-30T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z", defaulted: true },
  groups: [],
  totals: { events: 0, costUsd: 0 },
});
const EMPTY_CONSOLIDATED = {
  window: { from: "2026-09-30T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" },
  groupedBy: "user",
  subjects: [],
  basisStatement: "metered = observed; imported = restated from vendor exports",
  reconciliation: { supersededLinesExcluded: 0, lastReconciledAt: null, note: "" },
  staleness: { vendors: [], note: "" },
  note: "There is deliberately no combined figure.",
};
const SPEND_EMPTY: Record<string, unknown> = {
  "GET /v1/usage-events": { events: [], totals: { events: 0, costUsd: 0 } },
  "GET /v1/usage-events/summary": EMPTY_SUMMARY("agent"),
  "GET /v1/cost-events": { events: [], totals: [] },
  [`GET /v1/users/${ME_ID}/cost-consolidated`]: EMPTY_CONSOLIDATED,
  "GET /v1/projects": { projects: [] },
};

test.describe("I-2 rollout C: Spend & savings", () => {
  test("nothing spent or saved: one empty state, Open Chat first, the savings caveat kept in its (i)", async ({ page }) => {
    await mockApi(page, SPEND_EMPTY);
    await page.goto("/ui/spend");
    await expect(page.getByRole("heading", { name: "Spend & savings", level: 1 })).toBeVisible();
    await expect(page.getByText("Nothing spent or saved yet", { exact: true })).toBeVisible();
    await expect(emptyTitles(page)).toHaveCount(1);
    const card = page.locator("[data-rg-card]").filter({ hasText: "Get started" });
    await expect(card.getByRole("button").first()).toHaveAccessibleName(/estimated and measured savings|Open Chat/);
    await expect(card.getByRole("link").filter({ hasText: "Open Chat" })).toHaveAttribute("href", /\/chat$/);
    // the stacked empty cards are gone while nothing exists
    await expect(page.getByText(/^Spend by agent/)).toHaveCount(0);
    await expect(page.getByText(/^Recent invocations/)).toHaveCount(0);
    // the header's own actions and qualifiers stay
    await expect(page.getByRole("button", { name: "Download CSV" })).toBeVisible();
    await expect(page.getByText("your own numbers only")).toBeVisible();
    await card.getByRole("button", { name: /estimated and measured savings/ }).click();
    await expect(page.getByRole("note")).toContainText("never added together");
    await page.keyboard.press("Escape");
    await expectAxeClean(page, "Spend & savings, nothing yet");
  });

  test("a failed breakdown with an empty ledger is said in its card, never the empty state", async ({ page }) => {
    await mockApi(page, { ...SPEND_EMPTY, "GET /v1/usage-events/summary": fail(500) });
    await page.goto("/ui/spend");
    const byAgent = page.locator("[data-rg-card]").filter({ hasText: "Spend by agent" });
    await expect(byAgent.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("Nothing spent or saved yet")).toHaveCount(0);
  });

  test("a failed consolidated read is said in its card and stays there, never the empty state", async ({ page }) => {
    await mockApi(page, { ...SPEND_EMPTY, [`GET /v1/users/${ME_ID}/cost-consolidated`]: fail(500) });
    await page.goto("/ui/spend");
    const card = page.getByTestId("my-cost-consolidated");
    await expect(card.getByRole("button", { name: "Retry" })).toBeVisible();
    await page.waitForTimeout(2500);
    await expect(card.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("Nothing spent or saved yet")).toHaveCount(0);
  });

  test("a failed ledger read shows the error with Retry, never the empty state", async ({ page }) => {
    await mockApi(page, { ...SPEND_EMPTY, "GET /v1/usage-events": fail(500) });
    await page.goto("/ui/spend");
    await expect(page.getByRole("alert").getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("Nothing spent or saved yet")).toHaveCount(0);
  });

  test("one imported bill line is something: the page renders its sections as before", async ({ page }) => {
    await mockApi(page, {
      ...SPEND_EMPTY,
      [`GET /v1/users/${ME_ID}/cost-consolidated`]: {
        ...EMPTY_CONSOLIDATED,
        subjects: [
          {
            subjectKind: "user",
            subjectId: ME_ID,
            label: "ada@example.test",
            attributed: true,
            metered: { usd: 0, events: 0, unpricedEvents: 0 },
            imported: { usd: 19, lines: 1, byVendor: [{ vendor: "assistant-suite", currency: "USD", amount: 19, lines: 1 }], usdNote: null },
            coverage: "imported_only",
          },
        ],
      },
    });
    await page.goto("/ui/spend");
    await expect(page.getByTestId("my-cost-consolidated").getByRole("cell", { name: "$19", exact: true })).toBeVisible();
    await expect(page.getByText(/^Spend by agent/)).toBeVisible();
    await expect(page.getByText("Nothing spent or saved yet")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------

const REPORTS_EMPTY: Record<string, unknown> = {
  "GET /v1/reports/overview": { definitions: [], schedulerPresent: false, note: "" },
  "GET /v1/reports/runs": { runs: [] },
  "GET /v1/teams": { teams: [] },
  "GET /v1/projects": { projects: [] },
  "GET /v1/users": { users: [] },
};

test.describe("I-2 rollout C: Reports", () => {
  test("nothing defined or run: one empty state under the create form, the scheduler warning kept", async ({ page }) => {
    await mockApi(page, REPORTS_EMPTY);
    await page.goto("/ui/admin/reports");
    await expect(page.getByRole("heading", { name: "Executive & compliance reports", level: 1 })).toBeVisible();
    await expect(page.getByText("No reports yet", { exact: true })).toBeVisible();
    await expect(emptyTitles(page)).toHaveCount(1);
    // the primary action, the create form, comes first
    await expect(page.getByRole("button", { name: "Create definition" })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "Nothing in this deployment fires schedules" })).toBeVisible();
    // the schedules and run-history cards wait until something exists
    await expect(page.getByText("Run history", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add schedule" })).toHaveCount(0);
    await page.getByRole("button", { name: /schedules/ }).click();
    await expect(page.getByText(/A schedule is a definition of a cadence/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expectAxeClean(page, "Reports, nothing yet");
  });

  test("a failed run-history read is said in its card, never the empty state", async ({ page }) => {
    await mockApi(page, { ...REPORTS_EMPTY, "GET /v1/reports/runs": fail(500) });
    await page.goto("/ui/admin/reports");
    const history = page.locator("[data-rg-card]").filter({ hasText: "Run history" });
    await expect(history.getByRole("button", { name: "Retry" })).toBeVisible();
    // and it stays: the card's own refetch never flips the page back to loading
    await page.waitForTimeout(2500);
    await expect(history.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("No reports yet")).toHaveCount(0);
  });

  test("a failed overview read shows the error with Retry, never the empty state", async ({ page }) => {
    await mockApi(page, { ...REPORTS_EMPTY, "GET /v1/reports/overview": fail(500) });
    await page.goto("/ui/admin/reports");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("No reports yet")).toHaveCount(0);
  });

  test("one run from a deleted definition is something: the page renders its sections as before", async ({ page }) => {
    await mockApi(page, {
      ...REPORTS_EMPTY,
      "GET /v1/reports/runs": {
        runs: [{ id: U(1), definitionId: U(2), generatedAt: T, trigger: "manual", periodStart: T, periodEnd: T, effectiveProjectIds: null, rowCount: 3 }],
      },
    });
    await page.goto("/ui/admin/reports");
    await expect(page.getByText("Run history", { exact: true })).toBeVisible();
    await expect(page.getByText("deleted definition")).toBeVisible();
    await expect(page.getByText("No report definitions yet", { exact: true })).toBeVisible();
    await expect(page.getByText("No reports yet")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------

const LINEAGE_EMPTY: Record<string, unknown> = {
  "GET /v1/lineage/overview": { nodesByKind: [], edgesByKind: [], byProject: [], contentLevelLineageEnabled: false, note: "n", captureNote: "Metadata only." },
  "GET /v1/lineage/nodes": { nodes: [], note: "n" },
  "GET /v1/projects": { projects: [] },
};

test.describe("I-2 rollout C: Data lineage", () => {
  test("nothing recorded: one empty state, the coverage warnings kept, the run lookup still there", async ({ page }) => {
    await mockApi(page, LINEAGE_EMPTY);
    await page.goto("/ui/admin/lineage");
    await expect(page.getByRole("heading", { name: "Data lineage", level: 1 })).toBeVisible();
    await expect(page.getByText("No lineage recorded yet", { exact: true })).toBeVisible();
    await expect(emptyTitles(page)).toHaveCount(1);
    await expect(page.getByRole("link").filter({ hasText: "Open projects" })).toHaveAttribute("href", /\/projects$/);
    await expect(page.getByText("Limited coverage", { exact: true })).toBeVisible();
    await expect(page.getByText("Content-level lineage: off")).toBeVisible();
    await expect(page.getByRole("form", { name: "Look up a run's lineage" })).toBeVisible();
    // the empty trace form and the empty census wait until something is recorded
    await expect(page.getByText("No traversal yet")).toHaveCount(0);
    await expect(page.getByText("Graph census", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /what is captured, and what is not/ }).click();
    await expect(page.getByRole("note")).toContainText("Metadata only.");
    await page.keyboard.press("Escape");
    await expectAxeClean(page, "Data lineage, nothing yet");
  });

  test("a failed node read is never the empty state", async ({ page }) => {
    await mockApi(page, { ...LINEAGE_EMPTY, "GET /v1/lineage/nodes": fail(500) });
    await page.goto("/ui/admin/lineage");
    await expect(page.getByText("Graph census", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Trace", exact: true })).toBeVisible();
    // the page as it is: the census answers for itself, and no single empty state stands in for the failed read
    await expect(page.getByText("Get started", { exact: true })).toHaveCount(0);
  });

  test("a failed census read shows the error with Retry, never the empty state", async ({ page }) => {
    await mockApi(page, { ...LINEAGE_EMPTY, "GET /v1/lineage/overview": fail(500) });
    await page.goto("/ui/admin/lineage");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("No lineage recorded yet")).toHaveCount(0);
  });

  test("one recorded node is something: the page renders its sections as before", async ({ page }) => {
    await mockApi(page, {
      ...LINEAGE_EMPTY,
      "GET /v1/lineage/overview": {
        nodesByKind: [{ kind: "run", n: 1 }],
        edgesByKind: [],
        byProject: [{ projectId: U(3), name: "Atlas", n: 1 }],
        contentLevelLineageEnabled: false,
        note: "n",
        captureNote: "Metadata only.",
      },
    });
    await page.goto("/ui/admin/lineage");
    await expect(page.getByText("Graph census", { exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Atlas" })).toBeVisible();
    await expect(page.getByText("No traversal yet", { exact: true })).toBeVisible();
    await expect(page.getByText("Get started", { exact: true })).toHaveCount(0);
  });
});
