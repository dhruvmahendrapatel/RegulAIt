/**
 * P3 (#453 c6527514889) on the Account page, against a mocked gateway: the two lists that grow (devices and sessions,
 * passkeys) are five-row previews with the full count in the title and the same actions; "View all" opens each list's
 * own page with every row; the breadcrumb goes back; a failed read is an error with Retry, never "No live sessions";
 * axe (WCAG 2.x A/AA) is clean on the page and on each list page, in light and dark.
 *
 * The Organisation settings page has no list that grows (every card is a fixed form), so nothing on it moved.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const T0 = Date.parse("2026-10-01T09:00:00Z");
const at = (i: number) => new Date(T0 - i * 3_600_000).toISOString();
const DEVICES = ["Browser on a work laptop", "Browser on a home desktop", "Browser on a phone", "Browser on a tablet", "Browser on a shared kiosk", "Browser on a test machine"];

/** 12 live sessions, the first is this device */
const SESSIONS = Array.from({ length: 12 }, (_, i) => ({
  id: `s${i}`,
  createdAt: at(i + 1),
  expiresAt: "2026-10-08T09:00:00Z",
  lastSeenAt: at(i),
  ip: `192.0.2.${i + 10}`,
  lastSeenIp: null,
  origin: "password",
  deviceLabel: `${DEVICES[i % DEVICES.length]} ${i + 1}`,
  current: i === 0,
}));
/** 8 passkeys */
const PASSKEYS = Array.from({ length: 8 }, (_, i) => ({ id: `pk-${i}`, label: `Passkey ${i + 1}`, createdAt: at(i * 24), lastUsedAt: i % 2 ? null : at(i), backedUp: i % 3 === 0 }));

const ME = { userId: "u-dana", isAdmin: false, user: { id: "u-dana", email: "dana@example.test", displayName: "Dana Developer" } };

async function mockApi(page: Page, opts: { sessionsFail?: boolean } = {}) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (p === "/auth/sessions") return opts.sessionsFail ? json(route, { error: "internal" }, 500) : json(route, { sessions: SESSIONS });
    if (p === "/v1/auth/passkeys") return json(route, { passkeys: PASSKEYS, rpConfigured: true });
    if (p === "/v1/users/u-dana/model-credentials") return json(route, { credentials: [] });
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "off", exempt: null, noticeDays: 14 });
    return json(route, {});
  });
}

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
    name: "Devices & sessions",
    endpoint: "/auth/sessions",
    count: "12 live",
    viewAll: "View all sessions",
    page: "/ui/account/sessions",
    pageTitle: "Devices & sessions",
    total: 12,
    // the actions the long page carried are still on the preview
    actions: ["Sign out other devices"],
  },
  {
    name: "Passkeys",
    endpoint: "/v1/auth/passkeys",
    count: "8 active",
    viewAll: "View all passkeys",
    page: "/ui/account/passkeys",
    pageTitle: "Passkeys",
    total: 8,
    actions: ["Add a passkey"],
  },
] as const;

for (const P of SPLITS) {
  test(`Account › ${P.name}: the preview counts, keeps its actions, View all opens every row, and the breadcrumb goes back`, async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/account");
    const preview = page.locator(`[data-preview="${P.endpoint}"]`);
    await expect(preview.locator("tbody tr")).toHaveCount(5);
    await expect(page.getByText(P.count, { exact: true })).toBeVisible();
    for (const a of P.actions) await expect(page.getByRole("button", { name: a, exact: true })).toBeVisible();
    await expectAxeClean(page, `Account (${P.name} preview)`);

    await page.getByRole("link", { name: P.viewAll, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${P.page}$`));
    await expect(page.getByRole("heading", { name: P.pageTitle, level: 1 })).toBeVisible();
    await expect(page.locator("main tbody tr")).toHaveCount(P.total);
    await expect(page.getByText(P.count, { exact: true })).toBeVisible();
    for (const a of P.actions) await expect(page.getByRole("button", { name: a, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: P.viewAll, exact: true })).toHaveCount(0);
    await expectAxeClean(page, `${P.name} full list`);

    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Account" }).click();
    await expect(page).toHaveURL(/\/ui\/account$/);
    await expect(page.locator(`[data-preview="${P.endpoint}"] tbody tr`)).toHaveCount(5);
  });
}

test("Account › Devices & sessions: every row's Sign out is on the full page, and only for other devices", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/account/sessions");
  await expect(page.locator("main tbody tr")).toHaveCount(12);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(11);
  await expect(page.getByText("this device", { exact: true })).toBeVisible();
});

test("Account › Devices & sessions: a failed read is an error with Retry, never an empty list", async ({ page }) => {
  await mockApi(page, { sessionsFail: true });
  await page.goto("/ui/account");
  const preview = page.locator('[data-preview="/auth/sessions"]');
  await expect(preview.getByRole("button", { name: /Retry/ })).toBeVisible();
  await expect(preview.getByText("No live sessions")).toHaveCount(0);
});
