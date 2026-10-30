/**
 * P3 (#453 c6527514889) on the identity-and-access long pages: each growing list is a five-row preview with its count,
 * and what needs attention, in the heading; "View all" opens the list's own page with the shared list control; the
 * breadcrumb goes back; every warning the page carried is still visible without a click (a hidden settings tab
 * counts what it holds); axe is clean on the overview and on the list page.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./long-pages-identity.fixtures";

async function expectAxeClean(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
    }, theme);
    const results = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const SPLITS = [
  {
    name: "Workload identities",
    path: "/ui/admin/workload-identities",
    heading: "Identities · 27 identities · 2 suspended · 1 revoked",
    viewAll: "View all identities",
    page: "/ui/admin/workload-identities/identities",
    pageTitle: "Identities",
    endpoint: "/v1/workload-identities",
    listId: "workload-identities",
    total: 27,
    back: "Workload identities",
    warnings: ["External child delegation unavailable", "Settings · 1 to review"],
  },
  {
    name: "SSO",
    path: "/ui/admin/sso",
    heading: "Account-link requests · 12 pending",
    viewAll: "View all pending",
    page: "/ui/admin/sso/link-requests",
    pageTitle: "Account-link requests",
    endpoint: "/v1/auth/link-requests",
    listId: "link-requests",
    total: 12,
    back: "SSO & sessions",
    warnings: ["SAML providers · 1 to review", "expired", "not asserted"],
  },
  {
    name: "Agents",
    path: "/ui/admin/agents",
    heading: "Catalog · 31 agents · 6 disabled",
    viewAll: "View all agents",
    page: "/ui/admin/agents/catalog",
    pageTitle: "Agent catalog",
    endpoint: "/v1/agents",
    listId: "agents",
    total: 31,
    back: "Agents",
    warnings: ["Stewardship · 31 agents · 1 orphaned · 1 review overdue", "Orphaned", "Review overdue"],
  },
  {
    name: "ChatOps",
    path: "/ui/admin/chatops",
    heading: "Chat ↔ regulAIt identity links · 31 identity links · 13 admin-asserted",
    viewAll: "View all identity links",
    page: "/ui/admin/chatops/identity-links",
    pageTitle: "Chat ↔ regulAIt identity links",
    endpoint: "/v1/chatops/identity-links",
    listId: "chat-identity-links",
    total: 31,
    back: "ChatOps approvals",
    warnings: ["Not re-authenticated", "Unverified identity", "admin_asserted"],
  },
  {
    name: "Licensing",
    path: "/ui/admin/licensing",
    heading: "Verification trail · 45 verifications · 12 refused",
    viewAll: "View all verifications",
    page: "/ui/admin/licensing/verifications",
    pageTitle: "Verification trail",
    endpoint: "/v1/licenses/verifications",
    listId: "licence-verifications",
    total: 45,
    back: "Licensing & seats",
    warnings: ["REFUSED"],
  },
] as const;

for (const P of SPLITS) {
  test.describe(`${P.name}: the preview and the list's own page`, () => {
    test("the preview counts, the warnings stay visible, View all opens the full list, and the breadcrumb goes back", async ({ page }) => {
      const cap = await mockApi(page);
      await page.goto(P.path);
      const preview = page.locator(`[data-preview="${P.endpoint}"]`);
      await expect(page.getByText(P.heading, { exact: true })).toBeVisible();
      await expect(preview.locator("tbody tr")).toHaveCount(5);
      // the warnings the long page carried are still on the overview, without a click
      for (const w of P.warnings) await expect(page.getByText(w, { exact: true }).first()).toBeVisible();
      await expectAxeClean(page, `${P.name} overview`);

      await page.getByRole("link", { name: P.viewAll, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${P.page}$`));
      await expect(page.getByRole("heading", { name: P.pageTitle, level: 1 })).toBeVisible();
      const list = page.locator(`[data-list="${P.listId}"]`);
      const lists = () => cap.lists.filter((u) => u.pathname === P.endpoint);
      await expect(list.getByTestId("list-status")).toHaveText(`1–10 of ${P.total}`);
      await list.getByRole("button", { name: "Next", exact: true }).click();
      await expect(list.getByTestId("list-status")).toHaveText(`11–${Math.min(20, P.total)} of ${P.total}`);
      await list.getByLabel("Rows per page").selectOption("50");
      await expect(list.getByTestId("list-status")).toHaveText(`1–${P.total} of ${P.total}`);
      // a header click asks the server for the sort
      const sortable = list.locator('thead th[class*="thSortable"] button[class*="thSortBtn"]').nth(1);
      const before = lists().length;
      await sortable.click();
      await expect.poll(() => lists().length).toBeGreaterThan(before);
      expect(lists().at(-1)!.searchParams.get("dir")).toBe("asc");
      expect(lists().at(-1)!.searchParams.get("limit")).toBe("50");
      await list.getByRole("button", { name: "Download Excel" }).click();
      await expect.poll(() => cap.exports.length).toBe(1);
      expect(cap.exports[0]!.pathname).toBe(`${P.endpoint}/export.xlsx`);
      await expectAxeClean(page, `${P.name} full list`);

      await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: P.back }).click();
      await expect(page).toHaveURL(new RegExp(`${P.path}$`));
      await expect(page.getByText(P.heading, { exact: true })).toBeVisible();
    });
  });
}

test("Agents: stewardship is a preview with its own page; a deep link lands on the agent in the full catalog", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/agents");
  await expect(page.getByText("Stewardship · 31 agents · 1 orphaned · 1 review overdue", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View all agents' stewardship" }).click();
  await expect(page).toHaveURL(/\/ui\/admin\/agents\/stewardship$/);
  await expect(page.getByRole("heading", { name: "Agent stewardship", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: "Stewardship filter" })).toBeVisible();
  await expectAxeClean(page, "agent stewardship");
  await page.goto("/ui/admin/agents#agent-44444444-0000-4000-8000-000000000004");
  await expect(page).toHaveURL(/\/ui\/admin\/agents\/catalog#agent-/);
  await expect(page.getByText("Showing the linked agent only.")).toBeVisible();
  await expect(page.locator('[data-list="agents"] tbody tr')).toHaveCount(1);
});

test("Workload identities: grant proposals preview on request and open their own page; the full list's Manage comes back", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/workload-identities/identities");
  await page.locator('[data-list="workload-identities"]').getByRole("link", { name: /^Manage spiffe:\/\/example.test\/regulait\/agent\/credit-limit-00$/ }).click();
  await expect(page).toHaveURL(/\/ui\/admin\/workload-identities\?identity=/);
  await expect(page.getByRole("button", { name: "Manage spiffe://example.test/regulait/agent/credit-limit-00" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "spiffe://example.test/regulait/agent/credit-limit-00" })).toBeVisible();
  // proposals are read only on request (the read is audited), then previewed: five rows, the count and what no steward holds
  await page.getByRole("button", { name: "Propose grants from observed use" }).click();
  await expect(page.getByRole("heading", { name: "Proposed grants from observed use · 7 proposals · 2 not held by a steward" })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("link", { name: "View all proposals and accept" }).click();
  await expect(page).toHaveURL(/\/ui\/admin\/workload-identities\/[^/]+\/proposals$/);
  await expect(page.getByRole("heading", { name: "Grant proposals", level: 1 })).toBeVisible();
  await expect(page.getByRole("checkbox")).not.toHaveCount(0);
  await expect(page.getByRole("button", { name: /Accept proposals/ })).toBeVisible();
  await expectAxeClean(page, "grant proposals page");
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Workload identities" }).click();
  await expect(page.getByRole("heading", { name: "spiffe://example.test/regulait/agent/credit-limit-00" })).toBeVisible();
});

test("the settings tabs: a hidden tab says what it holds that needs review, and opening it shows it", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/sso");
  await page.getByRole("tab", { name: "SAML providers · 1 to review" }).click();
  await expect(page.getByText("any", { exact: true }).first()).toBeVisible();
  await page.goto("/ui/admin/workload-identities");
  await page.getByRole("tab", { name: "Settings · 1 to review" }).click();
  await expect(page.getByText("relaxed (audited)").first()).toBeVisible();
  await expectAxeClean(page, "identity settings tab");
});
