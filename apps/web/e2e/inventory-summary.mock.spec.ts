/**
 * Agent inventory summary tiles (Inventory mockup, #780 review).
 *
 * Every tile counts only the agents the table is showing and says "on this page". The counts follow the table:
 * a failed read clears them to "—" (never the previous page's numbers) and the next page replaces them.
 * Synthetic data only.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

function agent(id: string, over: { ownership?: "owned" | "unowned" | "orphaned"; status?: "active" | "deprecated" | "retired"; overreach?: boolean; openRisks?: number } = {}) {
  return {
    id, name: `Agent ${id}`, provider: "mock", model: "mock-balanced", tier: 1, enabled: true,
    owner: over.ownership === "unowned" ? null : { id: "ada", name: "Ada Admin", active: over.ownership !== "orphaned" },
    ownership: over.ownership ?? "owned",
    lifecycle: { status: over.status ?? "active", reason: null, changedAt: null },
    alignment: { approvedUseCases: 1, aligned: !over.overreach, overreach: over.overreach ?? false, undershoot: false, gaps: [] },
    credential: { source: "platform", platformCredential: true, byoUserCredentials: 0 },
    modelCard: { cards: 0, liveApproved: false },
    granted: { directUsers: 1, grantingRoles: [], revokedUsers: 0, effectiveHolders: 1 },
    observed: { dispatchesInWindow: 0, costUsdInWindow: 0, lastDispatchAt: null, feedsOut: 0, feedsIn: 0 },
    coverage: { redteamRunsInWindow: 0, everProbed: false, latestAsr: null, evalRunsInWindow: 0, groundednessRunsInWindow: 0 },
    links: { useCases: 1, risks: over.openRisks ?? 0, openRisks: over.openRisks ?? 0 },
  };
}

const PAGE1 = [
  agent("a1"),
  agent("a2", { ownership: "unowned", openRisks: 2 }),
  agent("a3", { ownership: "orphaned", status: "deprecated" }),
  agent("a4", { overreach: true, openRisks: 1 }),
];
const PAGE2 = [agent("b1", { status: "retired" })];

type Reply = { status: number; body: unknown };
async function mockApi(page: Page, reply: (url: URL) => Reply | Promise<Reply>) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/v1/inventory/agents") {
      const r = await reply(url);
      return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    const body = p === "/auth/me" || p === "/v1/me"
      ? { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false }
      : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

const summary = (page: Page) => page.getByTestId("inventory-summary");
const tile = (page: Page, label: string) => summary(page).locator("div").filter({ has: page.getByText(label, { exact: true }) });

async function expectCounts(page: Page, counts: [number | string, number | string, number | string, number | string, number | string]) {
  const labels = ["Agents on this page", "Active on this page", "Unowned or orphaned on this page", "Grant overreach on this page", "Open linked risks on this page"];
  for (let i = 0; i < labels.length; i++) await expect(tile(page, labels[i]!).locator("strong")).toHaveText(String(counts[i]));
}

test.describe("agent inventory summary tiles", () => {
  test("count the agents on this page, under the unchanged heading", async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { agents: PAGE1, window: { days: 90 } } }));
    await page.goto("/ui/admin/inventory");
    await expect(page.getByRole("heading", { level: 1, name: "Agent inventory", exact: true })).toBeVisible();
    await expectCounts(page, [4, 3, 2, 1, 3]);
    await expect(page.getByTestId("inventory-summary-scope")).toContainText("not the whole inventory");
  });

  test("show — before the first page arrives", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await mockApi(page, async () => { await gate; return { status: 200, body: { agents: PAGE1 } }; });
    await page.goto("/ui/admin/inventory");
    await expectCounts(page, ["—", "—", "—", "—", "—"]);
    release();
    await expectCounts(page, [4, 3, 2, 1, 3]);
  });

  test("follow the table to the next page", async ({ page }) => {
    await mockApi(page, (url) => ({
      status: 200,
      body: url.searchParams.get("cursor") === "p2" ? { agents: PAGE2 } : { agents: PAGE1, nextCursor: "p2" },
    }));
    await page.goto("/ui/admin/inventory");
    await expectCounts(page, [4, 3, 2, 1, 3]);
    await page.getByRole("button", { name: "Next" }).click();
    await expectCounts(page, [1, 0, 0, 0, 0]);
  });

  test("clear to — when a read fails, never keeping the previous page's numbers", async ({ page }) => {
    let fail = false;
    await mockApi(page, () => (fail ? { status: 500, body: { error: "internal" } } : { status: 200, body: { agents: PAGE1 } }));
    await page.goto("/ui/admin/inventory");
    await expectCounts(page, [4, 3, 2, 1, 3]);
    fail = true;
    await page.getByRole("button", { name: "Refresh agents" }).click();
    await expectCounts(page, ["—", "—", "—", "—", "—"]);
  });

  test("an empty inventory counts zero", async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { agents: [] } }));
    await page.goto("/ui/admin/inventory");
    await expectCounts(page, [0, 0, 0, 0, 0]);
  });

  test("axe is clean in light and dark", async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: { agents: PAGE1 } }));
    await page.goto("/ui/admin/inventory");
    await expectCounts(page, [4, 3, 2, 1, 3]);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((next) => { document.documentElement.dataset.theme = next; localStorage.setItem("regulait.theme", next); }, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const results = await new AxeBuilder({ page }).include("[data-testid='inventory-summary']").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`), `axe (${theme})`).toEqual([]);
    }
  });

  for (const width of [400, 650, 1100, 1440]) {
    test(`${width} px: no horizontal scroll and every tile on screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, () => ({ status: 200, body: { agents: PAGE1 } }));
      await page.goto("/ui/admin/inventory");
      await expectCounts(page, [4, 3, 2, 1, 3]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const tiles = summary(page).locator(":scope > div");
      for (let i = 0; i < 5; i++) {
        const box = await tiles.nth(i).boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width + 0.5, `tile ${i} inside ${width} px`).toBe(true);
      }
      const shots = process.env.GOV_SHOTS_DIR;
      if (shots) {
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate((next) => { document.documentElement.dataset.theme = next; }, theme);
          await page.screenshot({ path: `${shots}/inventory-summary-${width}-${theme}.png`, fullPage: true });
        }
      }
    });
  }
});
