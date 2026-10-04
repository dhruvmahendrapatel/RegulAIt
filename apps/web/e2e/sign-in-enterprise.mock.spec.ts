/**
 * ADR-0174 — the sign-in page, from the browser's side against a mocked
 * gateway (the *.mock.spec.ts harness: every /v1 and /auth call is answered
 * in-test).
 *
 *  - it shows exactly what GET /auth/sign-in-options enables: one "Continue
 *    with …" per broker IdP (with its logo), "Single sign-on" for enterprise
 *    IdPs, and the email form — and nothing when an option is off;
 *  - a broker button carries the IdP hint to the gateway's /login route;
 *  - the email form keeps its labels and still posts to /auth/login;
 *  - break-glass mode tucks the form behind an administrator disclosure;
 *  - an unreadable options answer degrades to the email form;
 *  - the account-link step (?link=pending) proves the account;
 *  - security review: a SAML sign-in held at the TOTP step (?mfa=pending)
 *    asks for the code and posts it WITHOUT a token (the gateway reads its
 *    HttpOnly cookie); in break-glass mode with the API-key exchange closed,
 *    the key form lives only inside the administrator disclosure;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const BROKER_ID = "0b6f1c3e-1111-4111-8111-111111111111";
const FULL = {
  broker: { providerId: BROKER_ID, name: "keycloak", idps: ["microsoft", "google", "github"] },
  enterprise: [
    { id: "22222222-2222-4222-8222-222222222222", name: "Acme Okta", protocol: "oidc" },
    { id: "33333333-3333-4333-8333-333333333333", name: "Acme ADFS", protocol: "saml" },
  ],
  local: { mode: "enabled", emailForm: true },
  apiKeyExchange: true,
};

interface Mock {
  options: unknown;
  loginBodies: unknown[];
  linkBodies: unknown[];
  mfaBodies: unknown[];
}

async function mockApi(page: Page, options: unknown): Promise<Mock> {
  const m: Mock = { options, loginBodies: [], linkBodies: [], mfaBodies: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    // the federated start routes are full-page navigations to the gateway
    if (p.startsWith("/auth/oidc/") || p.startsWith("/auth/saml/")) {
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>idp</title><p>redirected</p>" });
    }
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { error: "unauthenticated" }, 401);
    if (p === "/auth/sign-in-options") return json(route, m.options);
    if (p === "/auth/login") {
      m.loginBodies.push(req.postDataJSON());
      return json(route, { error: "invalid_credentials", detail: "email or password is incorrect" }, 401);
    }
    if (p === "/auth/link/pending") {
      return json(route, { pending: true, provider: "keycloak", protocol: "oidc", email: "ada@example.test", expiresAt: "2026-10-04T12:00:00Z" });
    }
    if (p === "/auth/mfa/verify") {
      m.mfaBodies.push(req.postDataJSON());
      return json(route, { error: "invalid_code" }, 401);
    }
    if (p === "/auth/link/confirm") {
      m.linkBodies.push(req.postDataJSON());
      return json(route, { error: "invalid_credentials", detail: "password or code is incorrect" }, 401);
    }
    return json(route, {});
  });
  return m;
}

const THEMES = ["light", "dark"] as const;
async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
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

const providerLink = (page: Page, name: string) => page.getByRole("link", { name, exact: true });

test.describe("ADR-0174: the sign-in page", () => {
  test("shows the broker buttons with logos, single sign-on and the email form — axe-clean in both themes", async ({ page }) => {
    await mockApi(page, FULL);
    await page.goto("/ui/login");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    for (const name of ["Continue with Microsoft", "Continue with Google", "Continue with GitHub"]) {
      const link = providerLink(page, name);
      await expect(link).toBeVisible();
      // the logo is decorative inside a named control: present, alt=""
      await expect(link.locator("img")).toHaveAttribute("alt", "");
    }
    // enterprise providers sit behind ONE disclosure
    const sso = page.getByRole("button", { name: "Single sign-on" });
    await expect(sso).toHaveAttribute("aria-expanded", "false");
    await expect(providerLink(page, "Continue with Acme Okta")).toBeHidden();
    await expect(page.getByRole("heading", { name: "Sign in with email" })).toBeVisible();
    await expect(page.getByLabel("Email or username")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expectAxeClean(page, "sign-in, collapsed");

    await sso.click();
    await expect(sso).toHaveAttribute("aria-expanded", "true");
    await expect(providerLink(page, "Continue with Acme Okta")).toHaveAttribute("href", "/auth/oidc/22222222-2222-4222-8222-222222222222/start?returnTo=/app");
    await expect(providerLink(page, "Continue with Acme ADFS")).toHaveAttribute("href", "/auth/saml/33333333-3333-4333-8333-333333333333/start?returnTo=/app");
    await expectAxeClean(page, "sign-in, single sign-on open");
  });

  test("a broker button hands the gateway the IdP hint", async ({ page }) => {
    await mockApi(page, FULL);
    await page.goto("/ui/login");
    await providerLink(page, "Continue with GitHub").click();
    await expect(page).toHaveURL(`/auth/oidc/${BROKER_ID}/login?idp=github&returnTo=/app`);
  });

  test("the email form keeps its labels and posts to /auth/login (uniform error on 401)", async ({ page }) => {
    const m = await mockApi(page, FULL);
    await page.goto("/ui/login");
    await page.getByLabel("Email").fill("ada@example.test");
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Email/username or password is incorrect.");
    expect(m.loginBodies).toEqual([{ email: "ada@example.test", password: "not-the-password" }]);
  });

  test("only what is enabled: no broker, no SSO → just the email form, no divider", async ({ page }) => {
    await mockApi(page, { broker: null, enterprise: [], local: { mode: "enabled", emailForm: true }, apiKeyExchange: true });
    await page.goto("/ui/login");
    await expect(page.getByLabel("Email or username")).toBeVisible();
    await expect(page.getByRole("link", { name: /Continue with/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Single sign-on" })).toHaveCount(0);
    await expect(page.getByText("or", { exact: true })).toHaveCount(0);
  });

  test("a broker offering only Microsoft shows only Microsoft", async ({ page }) => {
    await mockApi(page, { ...FULL, broker: { ...FULL.broker, idps: ["microsoft"] }, enterprise: [] });
    await page.goto("/ui/login");
    await expect(providerLink(page, "Continue with Microsoft")).toBeVisible();
    await expect(page.getByRole("link", { name: /Continue with/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Single sign-on" })).toHaveCount(0);
  });

  test("break-glass mode: the email form is an administrator disclosure", async ({ page }) => {
    await mockApi(page, { ...FULL, local: { mode: "break_glass_only", emailForm: false } });
    await page.goto("/ui/login");
    await expect(page.getByLabel("Email or username")).toBeHidden();
    await page.getByText("Administrator sign-in (break-glass)").click();
    await expect(page.getByLabel("Email or username")).toBeVisible();
    await expectAxeClean(page, "sign-in, break-glass open");
  });

  test("break-glass with the API-key exchange closed: the key form is only inside the administrator disclosure", async ({ page }) => {
    await mockApi(page, { ...FULL, local: { mode: "break_glass_only", emailForm: false }, apiKeyExchange: false });
    await page.goto("/ui/login");
    await expect(page.getByText("Sign in with an API key instead")).toHaveCount(0);
    await page.getByText("Administrator sign-in (break-glass)").click();
    await page.getByText("Break-glass administrator API key").click();
    await expect(page.getByLabel("API key")).toBeVisible();
    await expectAxeClean(page, "sign-in, break-glass key");
  });

  test("a SAML sign-in held at the TOTP step asks for the code and posts it without a token", async ({ page }) => {
    const m = await mockApi(page, FULL);
    await page.goto("/ui/login?mfa=pending");
    await expect(page.getByRole("heading", { level: 1, name: "Two-step verification" })).toBeVisible();
    await expect(page.getByText("Your organization requires a second factor.", { exact: false })).toBeVisible();
    await expectAxeClean(page, "saml totp step-up");
    await page.getByLabel("Authenticator code").fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("alert")).toContainText("That code wasn't accepted");
    expect(m.mfaBodies).toEqual([{ code: "123456" }]);
    await page.getByRole("button", { name: "Back to sign-in" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });

  test("sso_only: no email form at all, the federated buttons remain", async ({ page }) => {
    await mockApi(page, { ...FULL, local: { mode: "sso_only", emailForm: false } });
    await page.goto("/ui/login");
    await expect(providerLink(page, "Continue with Microsoft")).toBeVisible();
    await expect(page.getByLabel("Email or username")).toHaveCount(0);
  });

  test("an unreadable options answer degrades to the email form", async ({ page }) => {
    await mockApi(page, {});
    await page.goto("/ui/login");
    await expect(page.getByLabel("Email or username")).toBeVisible();
    await expect(page.getByRole("link", { name: /Continue with/ })).toHaveCount(0);
  });

  test("the account-link step proves the account and is axe-clean", async ({ page }) => {
    const m = await mockApi(page, FULL);
    await page.goto("/ui/login?link=pending");
    await expect(page.getByRole("heading", { level: 1, name: "Link your account" })).toBeVisible();
    await expect(page.getByText("ada@example.test")).toBeVisible();
    await expectAxeClean(page, "account link");
    await page.getByLabel("Your regulAIt password").fill("my-password");
    await page.getByLabel("Authenticator code (if you use one)").fill("123456");
    await page.getByRole("button", { name: "Link and continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("Password or code is incorrect.");
    expect(m.linkBodies).toEqual([{ password: "my-password", code: "123456" }]);
  });
});
