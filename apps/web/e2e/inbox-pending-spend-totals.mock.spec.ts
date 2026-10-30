/**
 * Two data bugs, against a mocked gateway:
 *  - the Inbox, the Review workbench and the nav badge read the pending queue from the server
 *    (`status=pending&order=asc`), oldest first, and say so when it holds more than one page
 *    ("Showing the oldest 100 of 342 pending · narrow with filters"); "Recently decided" is its own query;
 *    nothing reads the unfiltered, newest-first queue any more;
 *  - Spend by agent and by connector come from the server's windowed aggregate, labelled with the window,
 *    and "Recent invocations" says it is the newest 50.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ME = "00000000-0000-4000-8000-0000000000aa";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const CONNECTOR = "00000000-0000-4000-8000-0000000000c1";
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const pendingRow = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status: "pending",
  objectType: "project",
  stageId: "__project_budget__",
  // oldest first: row 1 waited longest
  requestedAt: minutesAgo(10_000 - n),
  userId: "someone",
  approverUserId: "someone-else",
  objectLabel: `Budget overage ${n}`,
  requestedByName: "Budget monitor",
  approverName: "Morgan Reyes",
});
const PENDING = Array.from({ length: 100 }, (_, i) => pendingRow(i + 1));
const DECIDED = [
  { ...pendingRow(900), id: "00000000-0000-4000-8000-000000000900", status: "approved", objectLabel: "Decided overage", decidedByName: "Avery Admin", decidedAt: minutesAgo(5) },
];

type Extra = (p: string, url: URL, route: Route) => Promise<void> | null;
async function mockApi(page: Page, extra: Extra = () => null, pending: unknown = { approvals: PENDING, total: 342, hasMore: true, limit: 100 }) {
  const seen: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    seen.push(p + url.search);
    if (p === "/auth/me") return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: ME, isAdmin: true, user: { id: ME, email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === "/v1/approvals") {
      const status = url.searchParams.get("status");
      if (status === "pending") return json(route, pending);
      if (status) return json(route, { approvals: DECIDED, total: 1, hasMore: false, limit: 100 });
      // the unfiltered newest-first page: the bug's source, which no screen here should read
      return json(route, { approvals: DECIDED, total: 343, hasMore: true, limit: 100 });
    }
    if (p === "/v1/annotations/inbox") return json(route, { items: [] });
    // the consolidated card is not under test here; an empty window keeps it quiet
    if (p === `/v1/users/${ME}/cost-consolidated`) {
      return json(route, { window: { from: "2026-09-30T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" }, groupedBy: "user", subjects: [], basisStatement: "", reconciliation: { supersededLinesExcluded: 0, lastReconciledAt: null, note: "" }, staleness: { vendors: [], note: "" }, note: "" });
    }
    const handled = extra(p, url, route);
    if (handled) return handled;
    return json(route, {});
  });
  return seen;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const unfiltered = (seen: string[]) => seen.filter((s) => s === "/v1/approvals" || s.startsWith("/v1/approvals?") && !s.includes("status="));

test.describe("the pending queue keeps every pending approval", () => {
  test("the Inbox lists the oldest page first, says how many more wait, and keeps Recently decided apart", async ({ page }) => {
    const seen = await mockApi(page);
    await page.goto("/ui/inbox");
    await expect(page.getByTestId("inbox-cap-note")).toHaveText("Showing the oldest 100 of 342 pending · narrow with filters");
    const rows = page.locator("[data-inbox-row]");
    await expect(rows).toHaveCount(100);
    // oldest first
    await expect(rows.first()).toContainText("Budget overage 1");
    await expect(rows.last()).toContainText("Budget overage 100");
    // the decided card comes from its own query, never from the pending page
    await expect(page.getByText("Recently decided")).toBeVisible();
    expect(seen).toContain("/v1/approvals?status=pending&order=asc");
    expect(seen).toContain("/v1/approvals?status=approved,denied,returned,consumed,superseded");
    expect(unfiltered(seen)).toEqual([]);
    // the nav badge counts the server's total, not the page
    await expect(page.getByRole("link", { name: /Inbox, 99\+ pending approvals/ })).toBeVisible();
    await expectAxeClean(page, "inbox with a capped queue");
  });

  test("the Inbox shows no cap note when the page is the whole queue", async ({ page }) => {
    await mockApi(page, () => null, { approvals: PENDING.slice(0, 3), total: 3, hasMore: false, limit: 100 });
    await page.goto("/ui/inbox");
    await expect(page.locator("[data-inbox-row]")).toHaveCount(3);
    await expect(page.getByTestId("inbox-cap-note")).toHaveCount(0);
  });

  test("the Review workbench triages the same server-filtered queue, oldest first", async ({ page }) => {
    const seen = await mockApi(page);
    await page.goto("/ui/admin/review-workbench");
    await expect(page.getByRole("heading", { name: "Review workbench" })).toBeVisible();
    await expect(page.getByTestId("workbench-cap-note")).toHaveText("Showing the oldest 100 of 342 pending · narrow with filters");
    await expect(page.getByLabel(`select ${PENDING[0]!.id}`)).toBeVisible();
    expect(seen).toContain("/v1/approvals?status=pending&order=asc");
    expect(unfiltered(seen)).toEqual([]);
  });
});

test.describe("Spend totals cover the whole window", () => {
  const usageEvent = { at: minutesAgo(1), objectType: "agent", agentId: AGENT, model: "mock-balanced", inputTokens: 10, outputTokens: 20, costUsd: 0.01, projectId: null };
  const summary = (groupBy: "agent" | "connector") => ({
    groupBy,
    userId: ME,
    window: { from: "2026-09-30T12:00:00.000Z", to: "2026-10-30T12:00:00.000Z", defaulted: true },
    groups:
      groupBy === "agent"
        ? [{ agentId: AGENT, costUsd: 42.5, events: 3_120 }]
        : [{ connectorId: CONNECTOR, name: "Search API", operation: "search", costUsd: 1.25, events: 640 }],
    totals: groupBy === "agent" ? { events: 3_120, costUsd: 42.5 } : { events: 640, costUsd: 1.25 },
  });

  test("by-agent and by-connector come from the server's aggregate, labelled with the window", async ({ page }) => {
    const seen = await mockApi(page, (p, url, route) => {
      if (p === "/v1/usage-events") return json(route, { events: [usageEvent], totals: { events: 3_760, costUsd: 43.75 } });
      if (p === "/v1/usage-events/summary") return json(route, summary(url.searchParams.get("groupBy") as "agent" | "connector"));
      if (p === "/v1/cost-events") return json(route, { events: [], totals: [] });
      if (p === `/v1/users/${ME}/agents`) return json(route, { agents: [{ agentId: AGENT, name: "Claude assistant" }] });
      if (p === `/v1/users/${ME}/connectors`) return json(route, { connectors: [] });
      return null;
    });
    await page.goto("/ui/spend");
    const byAgent = page.locator("[data-rg-card]").filter({ hasText: "Spend by agent · last 30 days" });
    await expect(byAgent).toBeVisible();
    // the server's sum over every event, not a sum over the one row the ledger page returned
    await expect(byAgent).toContainText("Claude assistant");
    await expect(byAgent).toContainText("$42.5");
    await expect(page.getByTestId("spend-by-agent-window")).toHaveText(/Every metered call from 2026-09-30 to 2026-10-30, summed by the server · 3,?120 calls/);
    const byConnector = page.locator("[data-rg-card]").filter({ hasText: "Spend by connector · last 30 days" });
    await expect(byConnector).toContainText("Search API · search");
    await expect(byConnector).toContainText("$1.25");
    await expect(page.getByText("Recent invocations · newest 50")).toBeVisible();
    await expect(page.getByTestId("spend-recent-note")).toContainText("The newest 50 agent calls only");
    // self-scoped, as the ledger read is
    expect(seen).toContain(`/v1/usage-events/summary?groupBy=agent&userId=${ME}`);
    expect(seen).toContain(`/v1/usage-events/summary?groupBy=connector&userId=${ME}`);
    await expectAxeClean(page, "spend with server totals");
  });

  test("a failed aggregate is said in its card, never shown as no spend", async ({ page }) => {
    await mockApi(page, (p, _url, route) => {
      if (p === "/v1/usage-events") return json(route, { events: [usageEvent], totals: { events: 1, costUsd: 0.01 } });
      if (p === "/v1/usage-events/summary") return json(route, { error: "internal" }, 500);
      if (p === "/v1/cost-events") return json(route, { events: [], totals: [] });
      return null;
    });
    await page.goto("/ui/spend");
    const byAgent = page.locator("[data-rg-card]").filter({ hasText: "Spend by agent" });
    await expect(byAgent.getByRole("button", { name: /Retry/ })).toBeVisible();
    await expect(byAgent.getByText("No metered agent calls")).toHaveCount(0);
  });
});
