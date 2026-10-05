/**
 * ADR-0181 (agent SC) from the browser's side, every /v1 and /auth call
 * answered by an in-test mock: the Enforcement posture page shows the database
 * hop's TLS posture.
 *
 *  - `required` (the default): a "database TLS" stat reading required, and no
 *    relaxation banner;
 *  - `relaxed` (REGULAIT_DATABASE_SSL=disable, as the local demo and
 *    docker-compose set it): the stat reads relaxed and the page says
 *    "database TLS: relaxed" in words, with what it means;
 *  - axe (WCAG 2.x A/AA) over the relaxed page in BOTH themes.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function posture(dbTls: "required" | "relaxed") {
  const controls = [
    { key: "mcpAdmissionMode", group: "enforcement", current: "enforce", hardened: "enforce", satisfied: true, settable: true, refuses: "connecting to an MCP server whose manifest has not passed admission scanning." },
    { key: "schedulerEnabled", group: "enforcement", current: true, hardened: true, satisfied: true, settable: false, refuses: "nothing directly; it is REGULAIT_SCHEDULER in the process environment." },
    { key: "databaseTls", group: "enforcement", current: dbTls, hardened: "required", satisfied: dbTls === "required", settable: false, refuses: "nothing; it is REGULAIT_DATABASE_SSL in the process environment (default require)." },
  ];
  const unmet = controls.filter((c) => !c.satisfied && !c.settable).map((c) => c.key);
  return {
    hardened: unmet.length === 0,
    summary: {
      enforcementSatisfied: controls.filter((c) => c.satisfied).length,
      enforcementTotal: controls.length,
      optimisationSatisfied: 0,
      optimisationTotal: 0,
      blockedByEnvironment: unmet,
    },
    controls,
    execution: { mode: "normal", reason: null, setAt: null, restricted: false, note: "Executing normally." },
  };
}

async function mockApi(page: Page, dbTls: "required" | "relaxed") {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/org/posture") return json(route, posture(dbTls));
    return json(route, {});
  });
}

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    const settled = Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

test.describe("ADR-0181: database TLS on the Enforcement posture page", () => {
  test("required (the default): the stat reads required and nothing claims a relaxation", async ({ page }) => {
    await mockApi(page, "required");
    await page.goto("/ui/admin/enforcement-posture");
    await expect(page.getByRole("heading", { name: "Enforcement posture", level: 1 })).toBeVisible();
    await expect(page.getByText("database TLS", { exact: true })).toBeVisible();
    await expect(page.getByText("required", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("database TLS: relaxed")).toHaveCount(0);
  });

  test("relaxed (REGULAIT_DATABASE_SSL=disable): the page says 'database TLS: relaxed' and why; axe-clean", async ({ page }) => {
    await mockApi(page, "relaxed");
    await page.goto("/ui/admin/enforcement-posture");
    await expect(page.getByRole("heading", { name: "Enforcement posture", level: 1 })).toBeVisible();
    await expect(page.getByText("database TLS: relaxed")).toBeVisible();
    await expect(page.getByText(/REGULAIT_DATABASE_SSL=disable is set/)).toBeVisible();
    await expect(page.getByText("relaxed", { exact: true }).first()).toBeVisible();
    await expectAxeClean(page, "Enforcement posture (database TLS relaxed)");
  });
});
