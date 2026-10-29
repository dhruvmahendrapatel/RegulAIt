/**
 * #453 — an audited Delete for git and PM connections (against a mocked gateway). The destructive action sits outside
 * the row's primary slot, the confirmation names the connection and the consequence, Escape cancels and hands focus
 * back to the row's Delete button, success is a toast, and a refusal the person resolves is shown inline.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const ISO = "2026-10-29T10:00:00.000Z";

type Kind = "git" | "pm";
const PAGES: Record<Kind, { url: string; api: string; name: string; row: Record<string, unknown>; consequence: RegExp }> = {
  git: {
    url: "/ui/admin/git-connections",
    api: "/v1/git/connections",
    name: "live-github",
    row: { id: "g1", name: "live-github", provider: "github", baseUrl: null, createdAt: ISO },
    consequence: /stored token is destroyed/,
  },
  pm: {
    url: "/ui/admin/pm-connections",
    api: "/v1/pm/connections",
    name: "live-jira",
    row: { id: "p1", name: "live-jira", provider: "jira", baseUrl: "https://acme.atlassian.net", project: "DEMO", mapping: null, apiVersion: null, createdAt: ISO },
    consequence: /must be registered again in Jira or Azure DevOps/,
  },
};

/** mocks the gateway; the DELETE answers `reply`, and the list empties once a 2xx DELETE lands */
async function mockApi(page: Page, kind: Kind, reply: { status: number; body: unknown }) {
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "ada@example.test", displayName: "Ada Admin" } };
  const cfg = PAGES[kind];
  const deletes: string[] = [];
  let gone = false;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === cfg.api && req.method() === "GET") return json(route, { connections: gone ? [] : [cfg.row] });
    if (p === `${cfg.api}/${cfg.name}` && req.method() === "DELETE") {
      deletes.push(p);
      if (reply.status < 300) gone = true;
      return json(route, reply.body, reply.status);
    }
    return json(route, {});
  });
  return { deletes };
}

for (const kind of ["git", "pm"] as const) {
  const cfg = PAGES[kind];

  test.describe(`${kind} connections: Delete`, () => {
    test("the confirmation names the connection and the consequence; confirming deletes it and says so", async ({ page }) => {
      const api = await mockApi(page, kind, { status: 200, body: { removed: true } });
      await page.goto(cfg.url);
      const row = page.getByRole("row", { name: new RegExp(cfg.name) });
      await row.getByRole("button", { name: "Delete connection" }).click();
      const dialog = page.getByRole("dialog", { name: new RegExp(`Delete .*connection “${cfg.name}”\\?`) });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(cfg.consequence);
      await expect(dialog).toContainText(/audit log/);
      await dialog.getByRole("button", { name: "Delete connection" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(`connection “${cfg.name}” deleted`)).toBeVisible();
      expect(api.deletes).toEqual([`${cfg.api}/${cfg.name}`]);
      await expect(page.getByRole("row", { name: new RegExp(cfg.name) })).toHaveCount(0);
    });

    test("Escape cancels without deleting and returns focus to the row's Delete button", async ({ page }) => {
      const api = await mockApi(page, kind, { status: 200, body: { removed: true } });
      await page.goto(cfg.url);
      const trigger = page.getByRole("row", { name: new RegExp(cfg.name) }).getByRole("button", { name: "Delete connection" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: new RegExp(cfg.name) });
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused({ timeout: 5_000 });
      expect(api.deletes).toEqual([]);
    });

    test("a refusal the person resolves is shown inline, and the connection stays", async ({ page }) => {
      await mockApi(page, kind, { status: 403, body: { error: "mfa_enrollment_required", credential: "session" } });
      await page.goto(cfg.url);
      await page.getByRole("row", { name: new RegExp(cfg.name) }).getByRole("button", { name: "Delete connection" }).click();
      await page.getByRole("dialog", { name: new RegExp(cfg.name) }).getByRole("button", { name: "Delete connection" }).click();
      await expect(page.getByTestId("refusal-guidance")).toBeVisible();
      await expect(page.getByTestId("refusal-guidance")).toHaveAttribute("data-refusal", "mfa_enrollment_required");
      await expect(page.getByRole("row", { name: new RegExp(cfg.name) })).toHaveCount(1);
    });
  });
}
