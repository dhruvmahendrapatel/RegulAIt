/**
 * Lane U4 (FS-44, FS-45, shell-home-account-03 Home part), against a mocked gateway:
 *  - Home's pending figures count from the server-filtered queue (/v1/approvals?status=pending&order=asc), not from the
 *    full list, which the gateway caps at 100 rows;
 *  - each pending row is a real link to the inbox, reachable from the keyboard (FS-44);
 *  - an unexpected setup-status body never prints "undefined" (FS-45);
 *  - axe (WCAG 2.x A/AA) clean in both themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const approval = (n: number, status = "pending") => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status,
  objectType: "workflow_stage",
  objectLabel: `Sign-off ${n}`,
  requestedByName: "Dana Developer",
  requestedAt: "2026-10-24T09:00:00Z",
});

// the capped full list holds one pending row; the filtered queue holds the real three
const fullList = [approval(1), approval(2, "approved"), approval(3, "denied")];
const pendingQueue = [approval(1), approval(4), approval(5)];

async function mockApi(page: Page, setupStatus: unknown, isAdmin = true) {
  const seen: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    seen.push(p + url.search);
    if (p === "/auth/me") return json(route, { userId: "u", isAdmin, via: "session", user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "u", isAdmin, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === "/v1/approvals") return json(route, { approvals: url.searchParams.get("status") === "pending" ? pendingQueue : fullList });
    if (p === "/v1/setup/status") return json(route, setupStatus);
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

test.describe("lane U4: Home pending approvals", () => {
  test("an admin's pending figures come from the filtered queue", async ({ page }) => {
    const seen = await mockApi(page, { complete: false, doneCount: 2, totalCount: 5, steps: [{ id: "a", title: "Connect a model", done: false }] });
    await page.goto("/ui/");
    const stat = page.getByText("decisions waiting on a human", { exact: true }).locator("..");
    await expect(stat).toHaveText(/^3\s*decisions waiting on a human$/);
    await expect(page.getByTestId("suite-tile-approvals-audit")).toContainText("3waiting on a human");
    await expect(page.getByTestId("suite-tile-settings")).toContainText("2/5setup steps done");
    // the server-filtered queue, oldest first: the same read the Inbox and the nav badge share
    expect(seen).toContain("/v1/approvals?status=pending&order=asc");
    await expectAxeClean(page, "home (admin)");
  });

  test("a member's pending rows are links to the inbox, reachable from the keyboard", async ({ page }) => {
    await mockApi(page, {}, false);
    await page.goto("/ui/");
    const card = page.locator("[data-rg-card]").filter({ hasText: "Waiting on you" });
    await expect(card.getByText("pending decisions")).toBeVisible();
    await expect(card.getByText("3", { exact: true })).toBeVisible();
    const rows = card.getByRole("link", { name: /requested by Dana Developer/ });
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute("href", "/ui/inbox");
    await expectAxeClean(page, "home (member)");
    await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
    await rows.first().focus();
    await expect(rows.first()).toBeFocused();
    await rows.first().press("Enter");
    await expect(page).toHaveURL(/\/ui\/inbox$/);
  });

  test("an unexpected setup-status body never prints undefined", async ({ page }) => {
    await mockApi(page, {});
    await page.goto("/ui/");
    await expect(page.getByText("0 of 0 setup steps done")).toBeVisible();
    await expect(page.getByTestId("suite-tile-settings")).not.toContainText("setup steps done");
    await expect(page.getByText(/undefined/)).toHaveCount(0);
  });
});
