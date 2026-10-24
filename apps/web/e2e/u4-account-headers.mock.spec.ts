/**
 * Lane U4, FS-42, against a mocked gateway: the Account tables (sessions, model keys, passkeys) name their actions
 * column for assistive tech with a visually hidden "Actions" header, never an empty <th>. axe (WCAG 2.x A/AA)
 * clean in both themes, minor findings included (empty-table-header is a minor rule).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const at = "2026-10-24T09:00:00Z";

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: "u", isAdmin: false, via: "session", user: { id: "u", email: "dana@example.test", displayName: "Dana Developer" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "u", isAdmin: false, user: { id: "u", email: "dana@example.test", displayName: "Dana Developer" } });
    if (p === "/auth/sessions")
      return json(route, {
        sessions: [
          { id: "s1", createdAt: at, expiresAt: at, lastSeenAt: at, ip: "192.0.2.1", lastSeenIp: null, origin: "password", deviceLabel: "Firefox on Linux", current: true },
          { id: "s2", createdAt: at, expiresAt: at, lastSeenAt: at, ip: "192.0.2.2", lastSeenIp: null, origin: "password", deviceLabel: "Safari on macOS", current: false },
        ],
      });
    if (p === "/v1/users/u/model-credentials") return json(route, { credentials: [{ id: "k1", provider: "openai", baseUrl: null, createdAt: at }] });
    if (p === "/v1/interception/settings") return json(route, { settings: { keyCustodyEnforced: false } });
    if (p === "/v1/auth/passkeys") return json(route, { passkeys: [{ id: "p1", label: "Laptop key", createdAt: at, lastUsedAt: null, backedUp: false }], rpConfigured: true });
    return json(route, {});
  });
}

test("FS-42: every Account table names its actions column", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/account");
  for (const row of ["Safari on macOS", "Laptop key"]) {
    const table = page.getByRole("table").filter({ has: page.getByRole("row").filter({ hasText: row }) });
    await expect(table.locator("thead th").filter({ hasText: /^Actions$/ })).toHaveCount(1);
  }
  const keys = page.getByRole("table").filter({ has: page.getByText("provider default") });
  await expect(keys.locator("thead th").filter({ hasText: /^Actions$/ })).toHaveCount(1);
  // the header is for assistive tech only: it takes no visible space
  const box = await page.locator("thead th span", { hasText: /^Actions$/ }).first().boundingBox();
  expect(box!.width).toBeLessThanOrEqual(1);

  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((next) => (document.documentElement.dataset.theme = next), theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).withRules(["empty-table-header"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`), `empty-table-header (${theme})`).toEqual([]);
  }
});
