/**
 * Lane UI-D, D3: Spend by person (ADR-0312 pilot addendum, #848's contract), against a mocked gateway.
 *
 *  - the list reads GET /v1/user-spend-budgets once and never one request per row;
 *  - a person's drawer reads their spend and names the standing in words; imported spend is shown, never added;
 *  - setting a budget validates inline before anything is sent, then PUTs exactly the contract's body;
 *  - removing a budget needs a confirmation and is refused inline when the step-up is refused;
 *  - a failed list read is an error with Retry, never "No spend budgets yet";
 *  - axe (WCAG 2.x A/AA) in light and dark, and no sideways scroll at 390 px.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const ME = { id: "aaaaaaaa-0000-4000-8000-000000000001", isAdmin: true, displayName: "Ada Admin" };
const AVERY = "bbbbbbbb-0000-4000-8000-000000000002";
const DANA = "cccccccc-0000-4000-8000-000000000003";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Calls {
  list: number;
  one: string[];
  puts: Array<{ path: string; body: unknown }>;
  deletes: string[];
}

async function mockGateway(page: Page, opts: { listFails?: boolean; deleteRefused?: boolean } = {}): Promise<Calls> {
  const calls: Calls = { list: 0, one: [], puts: [], deletes: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me")
      return json(route, {
        userId: ME.id, isAdmin: true, via: "session",
        user: { id: ME.id, email: "ada@example.test", displayName: ME.displayName },
        mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false,
      });
    if (p === "/v1/me") return json(route, { userId: ME.id, isAdmin: true, user: { id: ME.id, email: "ada@example.test", displayName: ME.displayName } });
    if (p === "/v1/user-spend-budgets") {
      calls.list += 1;
      if (opts.listFails) return json(route, { error: "internal" }, 500);
      return json(route, {
        limit: 1000,
        budgets: [{
          id: "b1", userId: AVERY, displayName: "Avery Approver", budgetUsd: 500, budgetPeriod: "monthly",
          alertThresholdPct: 80, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-10T09:00:00Z",
        }],
      });
    }
    if (p === `/v1/users/${AVERY}/spend-budget` && m === "GET") {
      calls.one.push(AVERY);
      return json(route, {
        budget: { id: "b1", userId: AVERY, budgetUsd: 500, budgetPeriod: "monthly", alertThresholdPct: 80 },
        window: { period: "2026-11", from: "2026-11-01T00:00:00.000Z" },
        metered: { basis: "metered", usd: 420, pctOfBudget: 84 },
        imported: { basis: "imported", usd: 60, nonUsdLines: 0 },
      });
    }
    if (p.endsWith("/spend-budget") && m === "PUT") {
      calls.puts.push({ path: p, body: req.postDataJSON() });
      return json(route, { budget: { id: "b2", userId: DANA, ...req.postDataJSON() } });
    }
    if (p.endsWith("/spend-budget") && m === "DELETE") {
      calls.deletes.push(p);
      if (opts.deleteRefused) return json(route, { error: "forbidden", detail: "you may not remove this budget" }, 403);
      return route.fulfill({ status: 204 });
    }
    if (p === "/v1/users")
      return json(route, {
        users: [
          { id: ME.id, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null },
          { id: AVERY, email: "avery@example.test", displayName: "Avery Approver", isAdmin: false, disabledAt: null },
          { id: DANA, email: "dana@example.test", displayName: "Dana Developer", isAdmin: false, disabledAt: null },
        ],
      });
    return json(route, {});
  });
  return calls;
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

test.describe("UI-D D3: spend by person", () => {
  test("lists budgets in one read, and a drawer names where spend stands in words", async ({ page }) => {
    const calls = await mockGateway(page);
    await page.goto("/ui/admin/cost/people");
    await expect(page.getByRole("heading", { name: "Spend by person", level: 1 })).toBeVisible();
    await expect(page.getByText("$500 a month, alert at 80%")).toBeVisible();
    expect(calls.list).toBe(1);
    expect(calls.one).toEqual([]); // no per-row read
    await expectAxeClean(page, "spend by person");

    await page.getByRole("button", { name: "View spend for Avery Approver" }).click();
    const drawer = page.getByRole("complementary").or(page.getByRole("dialog")).filter({ hasText: "Spend budget" });
    await expect(drawer).toContainText("Past the alert threshold: alert raised");
    await expect(drawer).toContainText("$420 · 84% of the budget");
    await expect(drawer).toContainText("Imported spend (vendor exports, not added)");
    await expect(drawer).toContainText("$60");
    expect(calls.one).toEqual([AVERY]);
    await expectAxeClean(page, "person spend drawer");
  });

  test("setting a budget checks inline first, then sends exactly the contract's body", async ({ page }) => {
    const calls = await mockGateway(page);
    await page.goto("/ui/admin/cost/people");
    await page.getByRole("button", { name: "Set a budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Set a spend budget" });
    // Avery already has a budget, so only people without one are offered
    const person = dialog.getByLabel("Person");
    await expect(person.locator("option", { hasText: "Avery Approver" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save budget" }).click();
    await expect(dialog).toContainText("Choose a person.");
    await expect(dialog).toContainText("Enter an amount in US dollars.");
    expect(calls.puts).toEqual([]);

    await person.selectOption({ label: "Dana Developer" });
    await dialog.getByLabel("Budget (US dollars)").fill("250");
    await dialog.getByLabel("Alert at (% of the budget)").fill("90");
    await dialog.getByRole("button", { name: "Save budget" }).click();
    await expect(dialog).toBeHidden();
    expect(calls.puts).toEqual([
      { path: `/v1/users/${DANA}/spend-budget`, body: { budgetUsd: 250, budgetPeriod: "monthly", alertThresholdPct: 90 } },
    ]);
  });

  test("removing a budget asks first, and a refusal is shown inline", async ({ page }) => {
    const calls = await mockGateway(page, { deleteRefused: true });
    await page.goto("/ui/admin/cost/people");
    await page.getByRole("button", { name: "View spend for Avery Approver" }).click();
    await page.getByRole("button", { name: "Remove budget" }).click();
    const confirm = page.getByRole("dialog", { name: "Remove the spend budget for Avery Approver?" });
    await expect(confirm).toBeVisible();
    expect(calls.deletes).toEqual([]);
    await confirm.getByRole("button", { name: "Remove budget" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /remove this budget|forbidden/i })).toBeVisible();
    expect(calls.deletes).toEqual([`/v1/users/${AVERY}/spend-budget`]);
  });

  test("a failed list read is an error with Retry, never an empty list", async ({ page }) => {
    await mockGateway(page, { listFails: true });
    await page.goto("/ui/admin/cost/people");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("No spend budgets yet")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("no sideways scroll at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockGateway(page);
    await page.goto("/ui/admin/cost/people");
    await expect(page.getByRole("heading", { name: "Spend by person", level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
