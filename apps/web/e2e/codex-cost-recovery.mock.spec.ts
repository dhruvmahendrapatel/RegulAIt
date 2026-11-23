/**
 * Codex review cards CXR-CST-001..005 (owner answers, 2026-11-22), against a mocked API:
 *  001 a failed project cost rollup read is an error with Retry, and a 403 says "not available to you" instead;
 *  002 the overage badge follows the server's `overageActive`, and an earlier period's approval reads as history;
 *  003 a refused alias or domain-rule write keeps what the admin typed;
 *  004 the consolidation "To" day is inclusive: the request's exclusive end is the next day's 00:00 UTC, and the
 *      resolved UTC window is shown beside the inputs; the default To is today;
 *  005 Remove on an alias or a domain rule asks for an audited reason, names the consequence, sends the reason, and
 *      reports what it re-attributed.
 */
import { expect, test, type Page } from "@playwright/test";
import { CONSOLIDATED, ME_ID, json, mockOps } from "./long-pages-ops.fixtures";

// the shared ops fixtures answer every other read; this spec layers its own answers on top (a later route wins)
const PROJECT_ID = "51515151-0000-4000-8000-000000000000";
const PROJECT_NAME = "team-17 project 1";
const ALIAS = { id: "24242424-0000-4000-8000-000000000001", vendor: "*", accountKey: "a.smith@contractor.example", userId: ME_ID, reason: "contractor account", createdAt: "2026-10-01T00:00:00Z" };
const RULE = { id: "25252525-0000-4000-8000-000000000001", vendor: "*", fromDomain: "old.example", toDomain: "example.test", enabled: true, reason: "domain moved", createdAt: "2026-10-01T00:00:00Z" };

const costs = (budget: Record<string, unknown>) => ({
  project: { name: PROJECT_NAME },
  initiative: null,
  measured: { costUsd: 150, events: 12, inputTokens: 100, outputTokens: 50 },
  forecast: { projectedEomUsd: 200, basis: "last-7-days-run-rate projected to end of current month" },
  budget: { spentUsd: 150, budgetUsd: 100, period: "monthly", periodKey: "2026-11", alertThresholdPct: 80, thresholdUsd: 80, thresholdCrossed: false, ...budget },
  byUser: [],
  byTeam: [],
  byAgent: [],
  byConnector: [],
  byMcpTool: [],
  estimatedSavings: [],
});

interface Opts {
  costs?: { status: number; body: unknown };
  writeStatus?: number;
}
interface Capture {
  costsCalls: number;
  consolidated: URL[];
  writes: Array<{ method: string; path: string; body: unknown }>;
}

async function mock(page: Page, opts: Opts = {}): Promise<Capture> {
  await mockOps(page);
  const cap: Capture = { costsCalls: 0, consolidated: [], writes: [] };
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.method() !== "GET") {
      cap.writes.push({ method: req.method(), path: p, body: req.postDataJSON?.() ?? null });
      const status = opts.writeStatus ?? 200;
      if (status !== 200) return json(route, { error: "validation", detail: "refused by the server" }, status);
      if (req.method() === "DELETE") return json(route, { deleted: true, id: p.split("/").pop(), reresolved: { changed: 3, scanned: 42 } });
      return json(route, { reresolved: { changed: 1, scanned: 42 } }, 201);
    }
    if (p === `/v1/projects/${PROJECT_ID}/costs`) {
      cap.costsCalls += 1;
      const c = opts.costs ?? { status: 200, body: costs({ overageApproved: true, overageActive: true }) };
      return json(route, c.body, c.status);
    }
    if (p === "/v1/cost-consolidated") {
      cap.consolidated.push(url);
      return json(route, CONSOLIDATED);
    }
    if (p === "/v1/cost-imports/mappings") return json(route, { aliases: [ALIAS], domainRules: [RULE], posture: "Aliases beat domain rules." });
    return route.fallback();
  });
  return cap;
}

const openRollup = async (page: Page) => {
  await page.goto("/ui/admin/cost");
  await page.getByRole("button", { name: `Open cost rollup for ${PROJECT_NAME}` }).click();
};

test.describe("CXR-CST-001: a failed project cost rollup read", () => {
  test("a 5xx is an error with Retry, and Retry reads again", async ({ page }) => {
    const cap = await mock(page, { costs: { status: 500, body: { error: "internal" } } });
    await openRollup(page);
    const card = page.locator("section").filter({ hasText: PROJECT_NAME }).filter({ hasText: "Download CSV" });
    await expect(card.getByText("Couldn't load this project's cost rollup")).toBeVisible({ timeout: 15_000 });
    const before = cap.costsCalls;
    await card.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => cap.costsCalls).toBeGreaterThan(before);
  });

  test("a 403 says the rollup is not available to this account, with no Retry", async ({ page }) => {
    await mock(page, { costs: { status: 403, body: { error: "forbidden" } } });
    await openRollup(page);
    await expect(page.getByTestId("not-available-to-you")).toContainText("This project's cost rollup is not available to you");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });
});

test.describe("CXR-CST-002: the overage badge follows what the server enforces", () => {
  test("an approval in force reads as approved", async ({ page }) => {
    await mock(page);
    await openRollup(page);
    await expect(page.getByText("overage approved", { exact: true })).toBeVisible();
    await expect(page.getByTestId("overage-history")).toHaveCount(0);
  });

  test("an earlier period's approval is history on the cost dashboard, and the project is over budget", async ({ page }) => {
    await mock(page, { costs: { status: 200, body: costs({ overageApproved: true, overageApprovedPeriod: "2026-10", overageActive: false }) } });
    await openRollup(page);
    await expect(page.getByText("over budget", { exact: true })).toBeVisible();
    await expect(page.getByText("overage approved", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("overage-history")).toContainText("An overage was approved for 2026-10; it does not cover this period");
  });

  test("the same on the project's own page", async ({ page }) => {
    await mock(page, { costs: { status: 200, body: costs({ overageApproved: true, overageApprovedPeriod: "2026-10", overageActive: false }) } });
    await page.goto(`/ui/projects/${PROJECT_ID}`);
    await expect(page.getByText("over budget", { exact: true })).toBeVisible();
    await expect(page.getByText("overage approved", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("overage-history")).toContainText("for 2026-10");
  });
});

test.describe("CXR-CST-003: a refused mapping write keeps the drafts", () => {
  test("alias and domain rule: the typed account, domains and reasons survive a 400", async ({ page }) => {
    const cap = await mock(page, { writeStatus: 400 });
    await page.goto("/ui/admin/cost-consolidation?tab=mapping");
    await page.getByTestId("al-account").fill("b.jones@contractor.example");
    await page.getByTestId("al-user").selectOption(ME_ID);
    await page.getByTestId("al-reason").fill("confirmed with IT");
    await page.getByTestId("al-save").click();
    await expect.poll(() => cap.writes.length).toBe(1);
    await expect(page.getByTestId("al-account")).toHaveValue("b.jones@contractor.example");
    await expect(page.getByTestId("al-reason")).toHaveValue("confirmed with IT");

    await page.getByTestId("dr-from").fill("legacy.example");
    await page.getByTestId("dr-to").fill("example.test");
    await page.getByTestId("dr-reason").fill("the vendor bills the legacy domain");
    await page.getByTestId("dr-save").click();
    await expect.poll(() => cap.writes.length).toBe(2);
    await expect(page.getByTestId("dr-from")).toHaveValue("legacy.example");
    await expect(page.getByTestId("dr-to")).toHaveValue("example.test");
    await expect(page.getByTestId("dr-reason")).toHaveValue("the vendor bills the legacy domain");
  });

  test("a successful alias write still clears them", async ({ page }) => {
    const cap = await mock(page);
    await page.goto("/ui/admin/cost-consolidation?tab=mapping");
    await page.getByTestId("al-account").fill("b.jones@contractor.example");
    await page.getByTestId("al-user").selectOption(ME_ID);
    await page.getByTestId("al-reason").fill("confirmed with IT");
    await page.getByTestId("al-save").click();
    await expect.poll(() => cap.writes.length).toBe(1);
    await expect(page.getByTestId("al-account")).toHaveValue("");
    await expect(page.getByTestId("al-reason")).toHaveValue("");
  });
});

test.describe("CXR-CST-004: the To day is inclusive", () => {
  test("default To is today; the request ends at the next day's 00:00 UTC; the UTC window is shown", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-11-22T15:00:00Z"));
    const cap = await mock(page);
    await page.goto("/ui/admin/cost-consolidation?tab=consolidated");
    await expect(page.getByTestId("cc-to")).toHaveValue("2026-11-22");
    await expect.poll(() => cap.consolidated.length).toBeGreaterThan(0);
    const first = cap.consolidated.at(-1)!;
    expect(first.searchParams.get("to")).toBe("2026-11-23T00:00:00.000Z");
    expect(first.searchParams.get("from")).toBe("2026-10-23T00:00:00.000Z");
    await expect(page.getByTestId("cc-window")).toContainText("2026-10-23 00:00 to 2026-11-22 23:59:59");

    await page.getByTestId("cc-to").fill("2026-11-10");
    await expect.poll(() => cap.consolidated.at(-1)!.searchParams.get("to")).toBe("2026-11-11T00:00:00.000Z");
    await expect(page.getByTestId("cc-window")).toContainText("to 2026-11-10 23:59:59");
  });
});

test.describe("CXR-CST-005: removing an alias or a domain rule takes an audited reason", () => {
  test("Remove opens the reason dialog, sends the reason, and reports the re-attribution", async ({ page }) => {
    const cap = await mock(page);
    await page.goto("/ui/admin/cost-consolidation?tab=mapping");
    await page.getByRole("button", { name: `Remove the alias for ${ALIAS.accountKey}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Remove the alias for ${ALIAS.accountKey}?`);
    await expect(dialog.getByTestId("rm-consequence")).toContainText("re-attributes stored lines that matched this rule");
    // no reason: refused in the dialog, nothing sent
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).toContainText("A reason is required");
    expect(cap.writes).toHaveLength(0);
    await dialog.getByRole("textbox").fill("contract ended");
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(() => cap.writes.length).toBe(1);
    expect(cap.writes[0]).toEqual({ method: "DELETE", path: `/v1/cost-imports/mappings/${ALIAS.id}`, body: { reason: "contract ended" } });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByTestId("rm-impact")).toContainText("3 of 42 stored line(s) re-attributed");

    await page.getByRole("button", { name: `Remove the domain rule ${RULE.fromDomain} to ${RULE.toDomain}` }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("domain retired");
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(() => cap.writes.length).toBe(2);
    expect(cap.writes[1]).toEqual({ method: "DELETE", path: `/v1/cost-imports/domain-rules/${RULE.id}`, body: { reason: "domain retired" } });
  });

  test("a refused removal keeps the dialog and its reason", async ({ page }) => {
    const cap = await mock(page, { writeStatus: 400 });
    await page.goto("/ui/admin/cost-consolidation?tab=mapping");
    await page.getByRole("button", { name: `Remove the alias for ${ALIAS.accountKey}` }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("contract ended");
    await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(() => cap.writes.length).toBe(1);
    await expect(page.getByRole("dialog").getByRole("textbox")).toHaveValue("contract ended");
    await expect(page.getByTestId("rm-impact")).toHaveCount(0);
  });
});
