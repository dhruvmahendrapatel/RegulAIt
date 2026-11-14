/**
 * Inbox summary tiles (My actions mockup, #779 review).
 *
 * The five counts come from the pending queue the page already loads (server-filtered to the caller), never
 * an organisation-wide total. Due counts use this device's clock (the approvals list has no server overdue
 * flag), say so on the tile, and recompute each minute. When the queue is capped, every tile says "(shown)"
 * and the scope line says the counts are a subset. Synthetic data only.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const ME = "u";
const T0 = Date.parse("2026-11-14T12:00:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();
const INTAKE = "AI use-case intake: ";

const base = { status: "pending", requestedAt: at(-120), userId: "jordan", approverUserId: ME, requestedByName: "Jordan Owner", approverName: "Avery Approver" };
const QUEUE = [
  { ...base, id: "I1", objectType: "workflow", stageId: "signoff", instanceId: "W1", useCaseId: "uc1", objectLabel: `${INTAKE}Credit-limit assistant`, assignment: { dueAt: at(-60) } }, // past due
  { ...base, id: "T1", objectType: "mcp_tool", stageId: "__tool__", objectLabel: "Send the weekly summary", assignment: { dueAt: at(30) } }, // due soon, past due after 30 min
  { ...base, id: "B1", objectType: "project", stageId: "__project_budget__", objectLabel: "team-17 support: monthly budget 112% used", assignment: { dueAt: at(3 * 24 * 60) } }, // due soon
  { ...base, id: "B2", objectType: "project", stageId: "__project_budget__", objectLabel: "team-18 support: monthly budget 105% used", assignment: { dueAt: null } }, // no due date
  { ...base, id: "G1", objectType: "governance_remediation", stageId: "__remediation__link_control", objectLabel: "Link the oversight control" }, // no assignment
];

async function mockApi(page: Page, opts: { approvals?: unknown; status?: number } = {}) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let status = 200;
    let body: unknown = {};
    if (p === "/auth/me") body = { userId: ME, isAdmin: false, via: "session", user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
    else if (p === "/v1/me") body = { userId: ME, isAdmin: false, user: { id: ME, email: "avery@example.test", displayName: "Avery Approver" } };
    else if (p === "/v1/approvals") {
      const pending = new URL(route.request().url()).searchParams.get("status") === "pending";
      status = pending ? opts.status ?? 200 : 200;
      body = pending ? (status === 200 ? opts.approvals ?? { approvals: QUEUE } : { error: "internal" }) : { approvals: [] };
    } else if (p === "/v1/annotations/inbox") body = { items: [] };
    else if (p === "/v1/users/directory" || p === "/v1/users") body = { users: [] };
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

const tile = (page: Page, label: string) => page.getByTestId("inbox-summary").locator("div").filter({ has: page.getByText(label, { exact: true }) });

test.describe("Inbox summary tiles", () => {
  test("counts the loaded queue; due counts follow this device's clock and recompute each minute", async ({ page }) => {
    await page.clock.install({ time: T0 });
    await mockApi(page);
    await page.goto("/ui/inbox");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox", exact: true })).toBeVisible();
    await expect(tile(page, "Pending")).toContainText("5");
    await expect(tile(page, "Use-case sign-offs")).toContainText("1");
    await expect(tile(page, "Governed tool decisions")).toContainText("1");
    await expect(tile(page, "Due within 7 days")).toContainText("2");
    await expect(tile(page, "Past due")).toContainText("1");
    await expect(tile(page, "Past due")).toContainText("by this device's clock");
    await expect(page.getByTestId("inbox-summary-scope")).toContainText("not organisation-wide totals");
    // 31 minutes later the tool call's due time has passed, with no reload
    await page.clock.fastForward("31:00");
    await expect(tile(page, "Past due")).toContainText("2");
    await expect(tile(page, "Due within 7 days")).toContainText("1");
  });

  test("a capped queue puts the scope on every tile and says the counts are a subset", async ({ page }) => {
    await page.clock.install({ time: T0 });
    await mockApi(page, { approvals: { approvals: QUEUE, hasMore: true } });
    await page.goto("/ui/inbox");
    await expect(page.getByTestId("inbox-cap-note")).toBeVisible();
    for (const label of ["Pending (shown)", "Use-case sign-offs (shown)", "Governed tool decisions (shown)", "Due within 7 days (shown)", "Past due (shown)"]) {
      await expect(page.getByTestId("inbox-summary").getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByTestId("inbox-summary-scope")).toContainText("cover the 5 items shown, a subset of your queue");
  });

  test("an empty queue shows truthful zeros", async ({ page }) => {
    await mockApi(page, { approvals: { approvals: [] } });
    await page.goto("/ui/inbox");
    await expect(tile(page, "Pending")).toContainText("0");
    await expect(tile(page, "Past due")).toContainText("0");
  });

  test("a failed queue read shows the error, not zeros", async ({ page }) => {
    await mockApi(page, { status: 500 });
    await page.goto("/ui/inbox");
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("inbox-summary")).toHaveCount(0);
  });

  test("axe is clean in light and dark", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/inbox");
    await expect(page.getByTestId("inbox-summary")).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((next) => { document.documentElement.dataset.theme = next; localStorage.setItem("regulait.theme", next); }, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const results = await new AxeBuilder({ page }).include("[data-testid='inbox-summary']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`), `axe (${theme})`).toEqual([]);
    }
  });

  for (const width of [400, 650, 1100, 1440]) {
    test(`${width} px: no horizontal scroll and every tile on screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page);
      await page.goto("/ui/inbox");
      const tiles = page.getByTestId("inbox-summary").locator(":scope > div");
      await expect(tiles).toHaveCount(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      for (let i = 0; i < 5; i++) {
        const box = await tiles.nth(i).boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width + 0.5, `tile ${i} inside ${width} px`).toBe(true);
      }
      const shots = process.env.GOV_SHOTS_DIR;
      if (shots) {
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate((next) => { document.documentElement.dataset.theme = next; }, theme);
          await page.screenshot({ path: `${shots}/inbox-summary-${width}-${theme}.png`, fullPage: true });
        }
      }
    });
  }
});
