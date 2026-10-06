/**
 * ADR-0183 batch 2.3 — refusals a person can resolve themselves say what to do
 * next and link to where they do it (`api/refusals.ts`, `ui/RefusalNotice.tsx`).
 * Every /v1 and /auth call is answered by an in-test mock:
 *
 *  - 403 `mfa_enrollment_required` on an API key (the sign-in page's key
 *    exchange): the key's owner must set up two-step verification; link to the
 *    Account page's two-step section;
 *  - 409 `mfa_enrollment_required` when an admin issues a key to someone who has
 *    not enrolled: no key issued, they must enrol first; same link;
 *  - `ai-literacy-not-current` on a governed call outside the acknowledgement
 *    interstitial (the model portal's Run, with nothing for the interstitial to
 *    ask): acknowledge the AI policy on the Account page; link to that section.
 *
 * Each also asserts the generic wording ("Mfa enrollment required", the API
 * route, "HTTP 403") no longer reaches the screen, and runs axe (WCAG 2.x A/AA)
 * in light and dark with the notice showing.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ADMIN = { id: "ada", email: "ada@example.test", displayName: "Ada Admin" };
const RILEY = {
  id: "riley", email: "riley@example.test", displayName: "Riley Reviewer", isAdmin: true, disabledAt: null,
  createdAt: "2026-10-01T00:00:00Z", totpEnabled: false, hasPassword: true, mustChangePassword: false,
};
const AGENT = "aaaaaaaa-0000-4000-8000-000000000003";

/** the gateway's own bodies (apps/gateway/src/auth.ts, app.ts, policy-kernel) */
const KEY_MFA_403 = {
  error: "mfa_enrollment_required",
  credential: "api_key",
  detail:
    "this organization requires TOTP MFA for this account, and an API key does not satisfy it: the key's owner must " +
    "sign in and enroll TOTP (POST /auth/totp/enroll) before the key works. An admin may relax mfaRequired (audited).",
};
const KEY_ISSUE_409 = {
  error: "mfa_enrollment_required",
  detail:
    "this user must enroll TOTP before an API key can be issued to them: the organization requires MFA for this " +
    "account, and a key would otherwise bypass it. An admin may relax mfaRequired (audited).",
};
const LITERACY_403 = {
  decision: {
    effect: "deny",
    ruleId: "ai-literacy-not-current",
    reason: "Calling demo-mock: Ada Admin is not current on 'Acceptable use of AI' v2 (acceptable-use)",
  },
};

const signedIn = (route: Route) =>
  json(route, { userId: ADMIN.id, isAdmin: true, via: "session", user: ADMIN, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });

async function mockApi(page: Page, answer: (route: Route, p: string, method: string) => Promise<void> | null) {
  const calls: string[] = [];
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    calls.push(`${method} ${p}`);
    const handled = answer(route, p, method);
    if (handled) return handled;
    // nothing for the acknowledgement interstitial to ask: these refusals are met OUTSIDE it
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    return json(route, {});
  });
  return calls;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(async (next) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("regulait.theme", next);
    await Promise.race([
      Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }, theme);
}

async function axeBothThemes(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`), `axe on ${label} (${theme})`).toEqual([]);
  }
  await setTheme(page, "light");
}

/** none of the generic, API-facing wording reaches the page */
async function expectNoGenericWording(page: Page) {
  const body = page.locator("body");
  await expect(body).not.toContainText("Mfa enrollment required");
  await expect(body).not.toContainText("/auth/totp/enroll");
  await expect(body).not.toContainText("HTTP 403");
  await expect(body).not.toContainText("Ai literacy not current");
}

test.describe("ADR-0183 2.3: refusals say what to do next, with the link", () => {
  test("403 mfa_enrollment_required on an API key: the owner must set up two-step verification", async ({ page }) => {
    await mockApi(page, (route, p) => {
      if (p === "/auth/me") return json(route, { error: "unauthenticated" }, 401);
      if (p === "/auth/sign-in-options") {
        return json(route, { broker: null, enterprise: [], local: { mode: "enabled", emailForm: true }, apiKeyExchange: true });
      }
      if (p === "/auth/login-with-key") return json(route, KEY_MFA_403, 403);
      return null;
    });
    await page.goto("/ui/login");
    await page.getByText("Sign in with an API key instead").click();
    await page.getByLabel("API key").fill("rgl_synthetic_test_key");
    await page.getByRole("button", { name: "Exchange key for a session" }).click();
    const notice = page.getByTestId("refusal-guidance");
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText("This API key can't be used yet: your organization requires two-step verification for its owner");
    await expect(notice).toContainText("Sign in with your password and set up an authenticator app on the Account page");
    await expect(notice.getByRole("link", { name: "Set up two-step verification" })).toHaveAttribute("href", "/ui/account?section=mfa");
    await expectNoGenericWording(page);
    await axeBothThemes(page, "sign-in, key refused for MFA");
  });

  test("409 mfa_enrollment_required on key issue: no key, the person must enrol first", async ({ page }) => {
    const calls = await mockApi(page, (route, p, method) => {
      if (p === "/auth/me") return signedIn(route);
      if (p === "/v1/me") return json(route, { userId: ADMIN.id, isAdmin: true, user: ADMIN });
      if (p === "/v1/users" && method === "GET") return json(route, { users: [{ ...ADMIN, isAdmin: true, disabledAt: null, createdAt: "2026-09-01T00:00:00Z", totpEnabled: true, hasPassword: true, mustChangePassword: false }, RILEY] });
      if (p === `/v1/users/${RILEY.id}/keys` && method === "POST") return json(route, KEY_ISSUE_409, 409);
      return null;
    });
    await page.goto("/ui/admin/users");
    await page.getByRole("cell", { name: "Riley Reviewer", exact: true }).click();
    await page.getByRole("button", { name: "Issue API key" }).click();
    const notice = page.getByTestId("refusal-guidance");
    await expect(notice).toContainText("No key was issued: your organization requires two-step verification for this person");
    await expect(notice).toContainText("Ask them to sign in and set up an authenticator app on their Account page, then issue the key again.");
    await expect(notice.getByRole("link", { name: "Where two-step verification is set up" })).toHaveAttribute("href", "/ui/account?section=mfa");
    expect(calls).toContain(`POST /v1/users/${RILEY.id}/keys`);
    // no secret was revealed
    await expect(page.getByText("API key for riley@example.test")).toHaveCount(0);
    await expectNoGenericWording(page);
    await axeBothThemes(page, "users, key issue refused for MFA");
  });

  test("ai-literacy-not-current outside the interstitial: acknowledge the AI policy on Account", async ({ page }) => {
    await mockApi(page, (route, p, method) => {
      if (p === "/auth/me") return signedIn(route);
      if (p === "/v1/me") return json(route, { userId: ADMIN.id, isAdmin: false, user: ADMIN });
      if (p === "/v1/agents" && method === "GET") {
        return json(route, { agents: [{ id: AGENT, name: "demo-mock", provider: "mock", model: "mock-balanced", tier: 0, enabled: true, costPerMTokIn: 1, costPerMTokOut: 2, systemPrompt: null, lifecycleStatus: "active", lifecycleReason: null, haltedAt: null, haltedReason: null, customProviderId: null }] });
      }
      if (p === `/v1/users/${ADMIN.id}/agents`) {
        return json(route, { agents: [{ agentId: AGENT, name: "demo-mock", provider: "mock", model: "mock-balanced", tier: 0, enabled: true, revoked: false, source: "direct", roles: [] }], defaultAgentId: null });
      }
      if (p === "/v1/model-providers/status") return json(route, { providers: { mock: { configured: true } } });
      if (p === `/v1/agents/${AGENT}/invoke` && method === "POST") return json(route, LITERACY_403, 403);
      return null;
    });
    await page.goto(`/ui/models?model=${AGENT}`);
    // the interstitial has nothing to ask, so the page is reached
    await expect(page.getByRole("group", { name: "Selected model" })).toContainText("demo-mock");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const result = page.getByTestId("run-result");
    await expect(result).toContainText("Refused by governance");
    // the server's reason (which policy) stays; the next step is added under it
    await expect(result).toContainText("is not current on 'Acceptable use of AI' v2");
    const notice = result.getByTestId("refusal-guidance");
    await expect(notice).toContainText("You haven't acknowledged the current version of an AI policy that applies to you");
    await expect(notice).toContainText("Read and acknowledge it on your Account page, then try again.");
    await expect(notice.getByRole("link", { name: "Open the AI policies on your Account page" })).toHaveAttribute("href", "/ui/account?section=ai-policies");
    await expectNoGenericWording(page);
    await axeBothThemes(page, "models, literacy refusal");
  });
});
