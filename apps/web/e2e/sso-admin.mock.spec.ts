/**
 * ADR-0174 security review — the SSO admin page (/ui/admin/sso) against a
 * mocked gateway (the *.mock.spec.ts harness):
 *
 *  - the OIDC form sends `brokerEnforcesMfa` when "Broker enforces MFA" is set
 *    (finding 4 — the bundled Keycloak's single code/passkey amr);
 *  - the SAML form sends `mfaAuthnContexts` (finding 1);
 *  - an account-link request shows its approvals ("0 of 2" for an admin
 *    account), and a first approval says another administrator must approve
 *    (finding 12) rather than "approved";
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const REQ_ID = "44444444-4444-4444-8444-444444444444";
const settings = {
  passwordMinLength: 12,
  passwordRequireClasses: 3,
  sessionLifetimeHours: 12,
  sessionIdleMinutes: 60,
  mfaRequired: "off",
  ssoOnly: false,
  loginLockoutThreshold: 5,
  loginLockoutWindowMinutes: 15,
  loginLockoutMinutes: 15,
  localSignIn: "enabled",
  breakGlassUserIds: [],
};

interface Captured {
  oidc: unknown[];
  saml: unknown[];
  approvals: string[];
}

async function mockApi(page: Page): Promise<Captured> {
  const cap: Captured = { oidc: [], saml: [], approvals: [] };
  const me = { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/auth/oidc-providers" && method === "GET") return json(route, { providers: [] });
    if (p === "/v1/auth/oidc-providers" && method === "POST") {
      cap.oidc.push(req.postDataJSON());
      return json(route, { id: "new" }, 201);
    }
    if (p === "/v1/auth/saml-providers" && method === "GET") return json(route, { providers: [] });
    if (p === "/v1/auth/saml-providers" && method === "POST") {
      cap.saml.push(req.postDataJSON());
      return json(route, { id: "new" }, 201);
    }
    if (p === "/v1/org/settings") return json(route, { settings });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/roles") return json(route, { roles: [] });
    if (p === "/v1/auth/link-requests") {
      return json(route, {
        requests: [
          {
            id: REQ_ID, userId: "t", userEmail: "root@example.test", userDisplayName: "Root Admin",
            provider: "keycloak", protocol: "oidc", subject: "s-1", email: "root@example.test", idpMfa: true,
            status: "pending", approvals: 0, requiredApprovals: 2, expired: false,
            createdAt: "2026-10-04T10:00:00Z", expiresAt: "2026-10-11T10:00:00Z", decidedAt: null,
          },
        ],
      });
    }
    if (p === `/v1/auth/link-requests/${REQ_ID}/approve`) {
      cap.approvals.push(REQ_ID);
      return json(route, { ok: true, status: "pending", approvals: 1, requiredApprovals: 2 });
    }
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0174 security review: the SSO admin page", () => {
  test("the OIDC form sends brokerEnforcesMfa; the SAML form sends mfaAuthnContexts", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/sso");
    const oidc = page.locator("section[data-rg-card]").filter({ hasText: "Single sign-on — OIDC providers" }).first();
    await expect(oidc).toBeVisible();
    await oidc.getByLabel("Name", { exact: true }).fill("keycloak");
    await oidc.getByLabel("Issuer URL").fill("https://id.example.test/realms/regulait");
    await oidc.getByLabel("Client id").fill("regulait-gateway");
    await oidc.getByLabel("Client secret").fill("synthetic-client-secret");
    await oidc.getByLabel("Broker enforces MFA").selectOption("true");
    await oidc.getByRole("button", { name: "Add provider" }).click();
    await expect.poll(() => cap.oidc.length).toBe(1);
    expect(cap.oidc[0]).toMatchObject({ name: "keycloak", brokerEnforcesMfa: true });

    const saml = page.locator("section[data-rg-card]").filter({ hasText: "Single sign-on — SAML 2.0 providers" }).first();
    await saml.getByLabel("Name", { exact: true }).fill("adfs");
    await saml.getByLabel("IdP entity id (Issuer)").fill("http://idp.example.test/adfs/services/trust");
    await saml.getByLabel("IdP sign-on URL").fill("https://idp.example.test/adfs/ls/");
    await saml.getByLabel(/IdP signing certificate/).fill("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----");
    await saml.getByLabel(/MFA authentication contexts/).fill("https://refeds.org/profile/mfa, urn:example:mfa");
    await saml.getByRole("button", { name: /Add (SAML )?provider/ }).click();
    await expect.poll(() => cap.saml.length).toBe(1);
    expect(cap.saml[0]).toMatchObject({ name: "adfs", mfaAuthnContexts: ["https://refeds.org/profile/mfa", "urn:example:mfa"] });
  });

  test("a link request to an admin account shows 0 of 2, and a first approval asks for a second administrator", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/sso");
    await expect(page.getByRole("cell", { name: "0 of 2" })).toBeVisible();
    await expectAxeClean(page, "sso admin");
    await page.getByRole("button", { name: "approve" }).click();
    await expect(page.getByText("Approval 1 of 2 recorded — another administrator must also approve (audited)")).toBeVisible();
    expect(cap.approvals).toEqual([REQ_ID]);
  });
});

// ADR-0186 A: the sign-in policy (break-glass fields included) goes through withStepUp — the SAME PUT resent once
test("ADR-0186 A: saving the sign-in policy asks to confirm it's you and resends the same PUT once", async ({ page }) => {
  await mockApi(page);
  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/org/settings", kind: "break_glass" });
  await page.goto("/ui/admin/sso");
  await page.getByRole("button", { name: "Save sign-in policy" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[1]!.body).toMatchObject({ localSignIn: "enabled", breakGlassUserIds: [] });
});
