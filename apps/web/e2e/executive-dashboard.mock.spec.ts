/**
 * Executive dashboard on /admin/posture (owner decision on #777, 2026-11-09; approved #453 mockup).
 *
 * Covers the five-tile headline row (use cases, approved, in review, open risks, evidence coverage),
 * the agent-ownership chip, truthful zero counts, the display-only "use cases by status" bars,
 * Refresh next to Print in the header, the loading/error/Retry gate, axe in both themes and
 * layouts at 390, 1024 and 1440 px with no horizontal scroll. Synthetic data only.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const ME = { userId: "exec-admin", isAdmin: true, via: "session", user: { id: "exec-admin", email: "admin@example.test", displayName: "Exec Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };

function postureDoc(over: { useCases?: Partial<Record<"proposed" | "underReview" | "approved" | "rejected" | "retired", number>>; agents?: { owned: number; unowned: number; orphaned: number } } = {}) {
  const uc = { proposed: 2, underReview: 3, approved: 4, rejected: 1, retired: 0, ...over.useCases };
  const ag = over.agents ?? { owned: 5, unowned: 1, orphaned: 1 };
  return {
    generatedAt: new Date().toISOString(),
    window: { days: 30 },
    packs: { active: [{ packId: "p1", framework: "EU AI Act", version: 1, title: "EU AI Act", totals: { controls: 10, satisfied: 6, attested: 1, attestationRequired: 2, unaddressed: 3 }, evidencedPct: 70, statement: "" }], note: "" },
    risks: { open: 2, mitigating: 1, accepted: 1, closed: 3, total: 7, attestationOnly: 0 },
    redteam: { measured: false, runsInWindow: 0, latest: null, trend: [], note: "No red-team run in the window" },
    evals: { runsInWindow: 0, groundedness: { runsInWindow: 0, latest: null } },
    spend: { period: { label: "this month" }, totalCostUsd: 12.5, events: 40, unattributedCostUsd: 0, budgets: [], overBudgetProjects: 0, dailyTrend: [], estimate: true, disclaimer: "List-price estimate." },
    governance: { denials: 0, piiBlocks: 0, approvalsPending: 6, approvalsDecidedInWindow: 9 },
    auditChain: { anchors: 0, latestAnchorAt: null, sink: null, disclosure: "No anchor yet." },
    agentOwnership: { total: ag.owned + ag.unowned + ag.orphaned, ...ag, lifecycle: { active: ag.owned + ag.unowned + ag.orphaned, deprecated: 0, retired: 0 }, note: "Ownership note shown on the agent ownership card." },
    certificationCampaigns: { total: 0, open: 0, completed: 0, expiredIncomplete: 0, note: "" },
    sod: { rules: 0, enabled: 0, currentViolations: 0, note: "" },
    accessRecommendations: { rulesVersion: 1, windowDays: 30, byRule: [], totalFindings: 0, totalNotAssessable: 0, note: "" },
    useCases: { ...uc, total: uc.proposed + uc.underReview + uc.approved + uc.rejected + uc.retired },
    note: "",
  };
}

async function mockApi(page: Page, first: { status: number; body: unknown }) {
  let reply = first;
  let postureReads = 0;
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/v1") && !path.startsWith("/auth")) return route.continue();
    if (path === "/v1/reports/posture") {
      postureReads++;
      return route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
    }
    const body = path === "/auth/me" || path === "/v1/me" ? ME : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { set: (next: { status: number; body: unknown }) => { reply = next; }, reads: () => postureReads };
}

const headlines = (page: Page) => page.getByRole("group", { name: "Headline figures" });

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate((next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

test.describe("executive dashboard on /admin/posture", () => {
  test("the five-tile headline row reads the posture report", async ({ page }) => {
    await mockApi(page, { status: 200, body: postureDoc() });
    await page.goto("/ui/admin/posture");
    await expect(page.getByRole("heading", { level: 1, name: "Posture" })).toBeVisible();
    const row = headlines(page);
    await expect(row.locator(":scope > *")).toHaveCount(5);
    const tiles = row.locator(":scope > *");
    await expect(tiles.nth(0)).toContainText("10");
    await expect(tiles.nth(0)).toContainText("registered AI use cases");
    await expect(tiles.nth(1)).toContainText("4");
    await expect(tiles.nth(1)).toContainText("approved use cases");
    await expect(tiles.nth(2)).toContainText("5");
    await expect(tiles.nth(2)).toContainText("use cases in review");
    await expect(tiles.nth(3)).toContainText("3");
    await expect(tiles.nth(3)).toContainText("open + mitigating risks");
    await expect(tiles.nth(4)).toContainText("70%");
    await expect(tiles.nth(0).getByRole("link", { name: "use-case registry →" })).toHaveAttribute("href", /\/admin\/use-cases$/);
    await expect(tiles.nth(2).getByRole("link", { name: "intake reviews →" })).toHaveAttribute("href", /\/admin\/governance\/intake$/);
    await expect(page.getByTestId("posture-scope")).toContainText("Whole organisation · last 30 days · generated");
    // the agent tile keeps its counts; the long ownership note is left to the agent-ownership card
    const agentTile = page.getByText("registered AI agents", { exact: true }).locator("xpath=ancestor::*[contains(@class, 'card')][1]");
    await agentTile.getByRole("button", { name: /registered AI agents/ }).click();
    await expect(page.getByText("5 owned, 1 unowned and 1 orphaned.")).toBeVisible();
    await expect(page.getByText("5 owned, 1 unowned and 1 orphaned. Ownership note")).toHaveCount(0);
  });

  test("ownership chip shows only when an agent is unowned or orphaned", async ({ page }) => {
    const gw = await mockApi(page, { status: 200, body: postureDoc() });
    await page.goto("/ui/admin/posture");
    await expect(page.getByText("Ownership attention needed")).toBeVisible();
    gw.set({ status: 200, body: postureDoc({ agents: { owned: 3, unowned: 0, orphaned: 0 } }) });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("Ownership attention needed")).toHaveCount(0);
    expect(gw.reads()).toBe(2);
  });

  test("zero use cases are shown as a truthful zero with no status bars", async ({ page }) => {
    await mockApi(page, { status: 200, body: postureDoc({ useCases: { proposed: 0, underReview: 0, approved: 0, rejected: 0, retired: 0 } }) });
    await page.goto("/ui/admin/posture");
    const tiles = headlines(page).locator(":scope > *");
    await expect(tiles.nth(0)).toContainText("0");
    await expect(tiles.nth(1)).toContainText("0");
    await expect(page.getByText("None recorded — no AI use case has been proposed")).toBeVisible();
    await expect(page.getByRole("list", { name: "Use cases by status" })).toHaveCount(0);
  });

  test("use cases by status shows each count as text and its bar width", async ({ page }) => {
    await mockApi(page, { status: 200, body: postureDoc() });
    await page.goto("/ui/admin/posture");
    const bars = page.getByRole("list", { name: "Use cases by status" });
    await expect(bars.getByRole("listitem")).toHaveCount(5);
    const approved = bars.getByRole("listitem").filter({ hasText: "Approved" });
    await expect(approved).toContainText("4");
    await expect(approved.locator("[data-stage='approved']")).toHaveAttribute("style", /width: 40%/);
    await expect(bars.getByRole("listitem").filter({ hasText: "Retired" }).locator("[data-stage='retired']")).toHaveAttribute("style", /width: 0%/);
  });

  test("Refresh and Print share the header; a failed read offers Retry", async ({ page }) => {
    const gw = await mockApi(page, { status: 500, body: { error: "internal" } });
    await page.goto("/ui/admin/posture");
    // the page header row: the title row (h1) and the actions are siblings
    const header = page.getByRole("heading", { level: 1, name: "Posture" }).locator("xpath=../..");
    await expect(header.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(header.getByRole("button", { name: "Print one-pager" })).toBeVisible();
    // the error state (after the client's one automatic retry) offers Retry and no figures
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible({ timeout: 20_000 });
    await expect(headlines(page)).toHaveCount(0);
    gw.set({ status: 200, body: postureDoc() });
    await retry.click();
    await expect(headlines(page)).toBeVisible();
  });

  test("axe is clean in light and dark", async ({ page }) => {
    await mockApi(page, { status: 200, body: postureDoc() });
    await page.goto("/ui/admin/posture");
    await expect(headlines(page)).toBeVisible();
    for (const theme of THEMES) {
      await setTheme(page, theme);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(", ")}`), `axe (${theme})`).toEqual([]);
    }
  });

  for (const width of [390, 1024, 1440]) {
    test(`${width} px: no horizontal scroll and every tile on screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, { status: 200, body: postureDoc() });
      await page.goto("/ui/admin/posture");
      await expect(headlines(page)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const tiles = headlines(page).locator(":scope > *");
      for (let i = 0; i < 5; i++) {
        const box = await tiles.nth(i).boundingBox();
        expect(box && box.x >= 0 && box.x + box.width <= width + 0.5, `tile ${i} inside ${width} px`).toBe(true);
      }
      const shots = process.env.GOV_SHOTS_DIR;
      if (shots) {
        for (const theme of THEMES) {
          await setTheme(page, theme);
          await page.screenshot({ path: `${shots}/executive-dashboard-${width}-${theme}.png`, fullPage: true });
        }
      }
    });
  }
});
