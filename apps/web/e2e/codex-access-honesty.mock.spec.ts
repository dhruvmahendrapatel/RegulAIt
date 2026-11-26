/**
 * Codex review cards CXR-ACC-003 and CXR-ACC-005, against a mocked API:
 *  003 a failed per-model rate-limit read is an error with Retry (a 403 is "no access", with no Retry) and never a
 *      value such as "Not enforced"; the copy matches the stored default (on);
 *  005 a failed sign-in options read shows a degraded notice with Retry, and the fallback email form still signs in.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Reads {
  limits: number;
  options: number;
  logins: unknown[];
}

async function mockAdmin(page: Page, limits: () => { status: number; body: unknown }): Promise<Reads> {
  const reads: Reads = { limits: 0, options: 0, logins: [] };
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/rules/approvals" || p === "/v1/rules/data-scopes" || p === "/v1/rules/rate-limits") return json(route, { rules: [] });
    if (p === "/v1/rules/model-rate-limits") {
      reads.limits += 1;
      const r = limits();
      return json(route, r.body, r.status);
    }
    return json(route, {});
  });
  return reads;
}

async function mockSignIn(page: Page, options: () => { status: number; body: unknown }): Promise<Reads> {
  const reads: Reads = { limits: 0, options: 0, logins: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { error: "unauthenticated" }, 401);
    if (p === "/auth/sign-in-options") {
      reads.options += 1;
      const r = options();
      return json(route, r.body, r.status);
    }
    if (p === "/auth/login") {
      reads.logins.push(req.postDataJSON());
      return json(route, { error: "invalid_credentials" }, 401);
    }
    return json(route, {});
  });
  return reads;
}

const section = (page: Page) => page.getByTestId("model-rate-limits");

test.describe("CXR-ACC-003: a failed per-model rate-limit read", () => {
  test("a 5xx is an error with Retry, never a value, and Retry reads again", async ({ page }) => {
    let fail = true;
    const reads = await mockAdmin(page, () =>
      fail ? { status: 500, body: { error: "internal" } } : { status: 200, body: { enforcementEnabled: true, rules: [] } },
    );
    await page.goto("/ui/admin/rules");
    await expect(section(page).getByText("Couldn't read the per-model limits or whether they are enforced")).toBeVisible({ timeout: 15_000 });
    await expect(section(page).getByText("Not enforced")).toHaveCount(0);
    await expect(page.getByTestId("model-rate-limits-toggle")).toHaveCount(0);
    const before = reads.limits;
    fail = false;
    await section(page).getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => reads.limits).toBeGreaterThan(before);
    await expect(section(page).getByText("Enforced", { exact: true })).toBeVisible();
    await expect(section(page).getByText("On by default.", { exact: false })).toBeVisible();
  });

  test("a 403 is the access state with no Retry", async ({ page }) => {
    await mockAdmin(page, () => ({ status: 403, body: { error: "forbidden" } }));
    await page.goto("/ui/admin/rules");
    await expect(section(page).getByText("You don't have access to this view")).toBeVisible({ timeout: 15_000 });
    await expect(section(page).getByText("Per-model limits are not available to your account.")).toBeVisible();
    await expect(section(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(section(page).getByText("Not enforced")).toHaveCount(0);
  });

  test("a stored off reads as turned off, against the on default", async ({ page }) => {
    await mockAdmin(page, () => ({ status: 200, body: { enforcementEnabled: false, rules: [] } }));
    await page.goto("/ui/admin/rules");
    await expect(section(page).getByText("Not enforced", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(section(page).getByText("Turned off — the default is on.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("model-rate-limits-toggle")).toHaveText("Turn enforcement on");
  });
});

test.describe("CXR-ACC-005: a failed sign-in options read", () => {
  test("shows a degraded notice with Retry, Retry reads again, and the email form still signs in", async ({ page }) => {
    let fail = true;
    const reads = await mockSignIn(page, () =>
      fail
        ? { status: 503, body: { error: "unavailable", detail: "upstream idp db 10.0.0.5 down" } }
        : { status: 200, body: { broker: null, enterprise: [{ id: "e1", name: "Acme Okta", protocol: "oidc" }], local: { mode: "enabled", emailForm: true }, apiKeyExchange: true } },
    );
    await page.goto("/ui/login");
    const notice = page.getByTestId("sign-in-options-degraded");
    await expect(notice).toContainText("Couldn’t load every way to sign in");
    // nothing from the server's error is echoed on an unauthenticated page
    await expect(notice).not.toContainText("10.0.0.5");
    await expect(notice).not.toContainText("unavailable");

    // the fallback form is usable
    await page.getByLabel("Email or username").fill("ada@example.test");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.poll(() => reads.logins.length).toBe(1);
    expect(reads.logins[0]).toEqual({ email: "ada@example.test", password: "not-the-password" });
    await expect(page.getByRole("alert")).toContainText("Email/username or password is incorrect.");

    const before = reads.options;
    fail = false;
    await notice.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => reads.options).toBeGreaterThan(before);
    await expect(page.getByTestId("sign-in-options-degraded")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Single sign-on" })).toBeVisible();
  });

  test("a readable answer shows no notice", async ({ page }) => {
    await mockSignIn(page, () => ({ status: 200, body: {} }));
    await page.goto("/ui/login");
    await expect(page.getByLabel("Email or username")).toBeVisible();
    await expect(page.getByTestId("sign-in-options-degraded")).toHaveCount(0);
  });
});
