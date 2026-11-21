/**
 * ADR-0240 — the external portals' second factor, from the browser's side against a mocked gateway:
 *
 *  - the SUPPLIER page: a spent link that answers `mfa: "enrol"` shows the QR once and asks for a code; a wrong code
 *    keeps the step open with the server's sentence; the right code (sent with the CSRF header) opens the assessment;
 *    a locked factor ends the step with no input left;
 *  - the AUDITOR page (/ui/audit): a link that answers `mfa: "verify"` asks for a code, never shows a secret, and the
 *    code opens the session;
 *  - the ADMIN side: Supplier access and Trust publishing both open the same Second factor dialog, read the state only
 *    when it is opened, and reset it with a reason and the step-up prompt (identity_manage);
 *  - axe (WCAG 2.x A/AA) in light and dark on the code step and the dialog.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const TOKEN = `rglsi_${"A".repeat(40)}x_9`;
const AUDIT_TOKEN = `rgal_${"b".repeat(64)}`;
const VENDOR = "11111111-1111-4111-8111-111111111111";
const ACCESS = "22222222-2222-4222-8222-222222222222";
const GRANT = "55555555-5555-4555-8555-555555555555";
const SECRET = "JBSWY3DPEHPK3PXP";
const OTPAUTH = `otpauth://totp/RegulAIt:sam%40supplier.example?secret=${SECRET}&issuer=RegulAIt`;
const SOON = "2026-11-19T22:10:00.000Z";
const THEMES = ["light", "dark"] as const;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the supplier's side
// ---------------------------------------------------------------------------------------------------------------

const assessment = {
  vendorName: "Acme Transcribe",
  framework: "eu-ai-act",
  open: true,
  accessExpiresAt: "2026-11-30T09:00:00Z",
  sessionExpiresAt: "2026-11-19T23:00:00Z",
  controls: [{ controlRef: "ART-10", title: "Data governance", description: null }],
  questionnaire: null,
  submissions: [],
  limits: { fileMaxBytes: 2 * 1024 * 1024, statementMax: 4000, fileTypes: ["application/pdf"], filesAccepted: false, fileBytesBudget: 50 * 1024 * 1024 },
};

interface SupplierMfa {
  codes: Array<{ body: unknown; csrf: string | null }>;
  locked: boolean;
}

async function mockSupplier(page: Page, patch: Partial<SupplierMfa> = {}): Promise<SupplierMfa> {
  const state: SupplierMfa = { codes: [], locked: false, ...patch };
  let signedIn = false;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p.startsWith("/v1") || p.startsWith("/auth")) return json(route, { error: "unauthenticated" }, 401);
    if (req.resourceType() === "document" || !p.startsWith("/supplier/")) return route.continue();
    if (p === "/supplier/v1/session" && req.method() === "POST") {
      return json(route, { vendorName: "Acme Transcribe", framework: "eu-ai-act", mfa: "enrol", secret: SECRET, otpauthUri: OTPAUTH, challengeExpiresAt: SOON });
    }
    if (p === "/supplier/v1/session/mfa" && req.method() === "POST") {
      const body = req.postDataJSON() as { code: string };
      state.codes.push({ body, csrf: req.headers()["x-regulait-csrf"] ?? null });
      if (state.locked) {
        return json(route, { error: "mfa_locked", detail: "Sign-in is locked after too many wrong codes. Ask the person who invited you to reset your second factor and send you a new link." }, 423);
      }
      if (body.code !== "246810") return json(route, { error: "mfa_code_invalid", detail: "That code is not valid. Enter the current code from your authenticator app." }, 401);
      signedIn = true;
      return json(route, { vendorName: "Acme Transcribe", framework: "eu-ai-act", sessionExpiresAt: "2026-11-19T23:00:00Z" });
    }
    if (p === "/supplier/v1/assessment" && req.method() === "GET") {
      if (!signedIn) return json(route, { error: "session_not_valid", detail: "Your session has ended." }, 401);
      return json(route, assessment);
    }
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0240: the supplier page's second factor", () => {
  test("enrols: shows the QR once, keeps the step open on a wrong code, and opens the assessment on the right one", async ({ page }) => {
    const state = await mockSupplier(page);
    await page.goto(`/ui/supplier#${TOKEN}`);
    await expect(page.getByText("Set up your second factor")).toBeVisible();
    await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
    // the button says why it is off until six digits are typed
    const go = page.getByRole("button", { name: "Confirm and continue" });
    await expect(go).toBeDisabled();
    await expect(page.getByText("Enter all six digits to continue.")).toBeVisible();
    await expectAxeClean(page, "supplier enrolment step");

    const code = page.getByLabel("Code from your authenticator");
    await code.fill("123 456");
    await expect(code).toHaveValue("123456");
    await go.click();
    await expect(page.getByRole("alert")).toHaveText("That code is not valid. Enter the current code from your authenticator app.");
    await expect(code).toHaveValue("");

    await code.fill("246810");
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await expect(page.getByRole("region", { name: /ART-10/ })).toBeVisible();
    // the secret is gone with the step
    await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toHaveCount(0);
    expect(state.codes).toEqual([
      { body: { code: "123456" }, csrf: "1" },
      { body: { code: "246810" }, csrf: "1" },
    ]);
  });

  test("a locked factor ends the step with the server's sentence and no input left", async ({ page }) => {
    await mockSupplier(page, { locked: true });
    await page.goto(`/ui/supplier#${TOKEN}`);
    await page.getByLabel("Code from your authenticator").fill("111111");
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await expect(page.getByText("Sign-in could not be completed")).toBeVisible();
    await expect(page.getByText(/Sign-in is locked after too many wrong codes/)).toBeVisible();
    await expect(page.getByLabel("Code from your authenticator")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// the auditor's side
// ---------------------------------------------------------------------------------------------------------------

test.describe("ADR-0240: the auditor page's second factor", () => {
  test("verifies: asks for a code, never shows a secret, and opens the session", async ({ page }) => {
    const codes: Array<{ body: unknown; csrf: string | null }> = [];
    let signedIn = false;
    await page.route("**/*", async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
      if (p === "/v1/auditor/session" && req.method() === "POST") return json(route, { mfa: "verify", challengeExpiresAt: SOON });
      if (p === "/v1/auditor/session/mfa" && req.method() === "POST") {
        codes.push({ body: req.postDataJSON(), csrf: req.headers()["x-regulait-csrf"] ?? null });
        signedIn = true;
        return json(route, { sessionExpiresAt: "2026-11-19T23:00:00Z" }, 201);
      }
      if (p === "/v1/auditor/session" && req.method() === "GET") {
        if (!signedIn) return json(route, { error: "unauthenticated" }, 401);
        return json(route, { organisation: "Example Org", auditorName: "Ada Auditor", accessEndsAt: "2026-11-30T09:00:00Z", sessionEndsAt: "2026-11-19T23:00:00Z", items: [], disclaimer: "" });
      }
      return json(route, { error: "unauthenticated" }, 401);
    });
    await page.goto(`/ui/audit#${AUDIT_TOKEN}`);
    await expect(page.getByText("Enter your code")).toBeVisible();
    await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toHaveCount(0);
    await expectAxeClean(page, "auditor verify step");
    await page.getByLabel("Code from your authenticator").fill("135790");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Signed in as Ada Auditor.")).toBeVisible();
    expect(codes).toEqual([{ body: { code: "135790" }, csrf: "1" }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// the admin side
// ---------------------------------------------------------------------------------------------------------------

const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
const factor = { state: "locked", enrolledAt: "2026-11-10T09:00:00Z", failedAttempts: 5, lockedAt: "2026-11-19T08:00:00Z" };
const resetOut = { reset: true, hadFactor: true, sessionsEnded: 0, linksRevoked: 1, notice: "Send a new link." };

async function mockAdminBase(page: Page, extra: (route: Route, p: string, m: string) => Promise<unknown> | null): Promise<{ reads: string[] }> {
  const reads: string[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p.endsWith("/mfa") && m === "GET") {
      reads.push(p);
      return json(route, { ...factor, ...(p.includes("supplier-access") ? { accessId: ACCESS } : { grantId: GRANT }) });
    }
    const handled = extra(route, p, m);
    if (handled) return handled;
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return { reads };
}

test.describe("ADR-0240: resetting an external second factor", () => {
  test("Supplier access: the dialog reads the state only when opened and resets with a reason and step-up", async ({ page }) => {
    const vendor = {
      id: VENDOR, name: "Acme Transcribe", description: "", category: "ai_feature_vendor", ownerUserId: "riley", ownerName: "Riley Admin",
      linkedCustomProviderIds: [], linkedAgentProviders: [], packAttestations: [], status: "under_assessment", workflowInstanceId: null,
      decidedAt: null, retiredReason: null, createdAt: "2026-10-01T09:00:00Z",
    };
    const admin = await mockAdminBase(page, (route, p, m) => {
      if (p === "/v1/vendors" && m === "GET") return json(route, { vendors: [vendor], disclaimer: "" });
      if (p === `/v1/vendors/${VENDOR}` && m === "GET") return json(route, { vendor, instance: null, questionnaire: null, questionnaireTemplate: null, attestations: [], packChecklist: null, disclaimer: "" });
      if (p === "/v1/supplier-portal/settings" && m === "GET") return json(route, { enabled: true, acceptUnscannedFiles: false, scannerConfigured: false });
      if (p === `/v1/vendors/${VENDOR}/supplier-access` && m === "GET") {
        return json(route, {
          enabled: true,
          access: [{ id: ACCESS, email: "sam@supplier.example", framework: "eu-ai-act", questionnaire: null, expiresAt: "2026-11-30T09:00:00Z", revokedAt: null, createdAt: "2026-11-10T09:00:00Z", state: "active", liveSessions: 0, links: [] }],
        });
      }
      if (p === `/v1/vendors/${VENDOR}/supplier-submissions` && m === "GET") return json(route, { submissions: [], disclaimer: "" });
      if (p === "/v1/supplier-questionnaires" && m === "GET") return json(route, { questionnaires: [] });
      if (p === `/v1/vendors/${VENDOR}/supplier-access/${ACCESS}/mfa/reset` && m === "POST") return json(route, { accessId: ACCESS, ...resetOut });
      return null;
    });
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/vendors/${VENDOR}/supplier-access/${ACCESS}/mfa/reset`, kind: "identity_manage" });
    await page.goto(`/ui/admin/vendors?vendorId=${VENDOR}`);
    const button = page.getByRole("button", { name: "Second factor for sam@supplier.example" });
    await expect(button).toBeVisible();
    // nothing is read per row
    expect(admin.reads).toEqual([]);
    await button.click();
    const dialog = page.getByRole("dialog", { name: "Second factor for sam@supplier.example" });
    await expect(dialog.getByText("Locked", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/until you reset it/)).toBeVisible();
    expect(admin.reads).toEqual([`/v1/vendors/${VENDOR}/supplier-access/${ACCESS}/mfa`]);
    await expectAxeClean(page, "supplier second factor dialog");

    await dialog.getByRole("button", { name: "Reset second factor" }).click();
    const ask = page.getByRole("dialog", { name: "Reset the second factor for sam@supplier.example?" });
    await ask.getByRole("textbox").fill("Lost their phone; confirmed by call");
    await ask.getByRole("button", { name: "Reset second factor" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ reason: "Lost their phone; confirmed by call" });
    await expect(page.getByText("Second factor reset. 1 unused link revoked. Send a new link so they can set it up again.").first()).toBeVisible();
  });

  test("Trust publishing: the auditor's dialog resets through the same prompt", async ({ page }) => {
    const grant = { id: GRANT, auditorName: "Ada Auditor", auditorEmail: "ada@audit.example", auditorOrganisation: "Audit LLP", startsAt: "2026-11-10T09:00:00Z", expiresAt: "2026-11-30T09:00:00Z", revokedAt: null, state: "active", items: 2, views: 3, lastViewedAt: null };
    await mockAdminBase(page, (route, p, m) => {
      if (p === "/v1/trust/publications" && m === "GET") return json(route, { enabled: true, items: [], truncated: false });
      if (p === "/v1/trust/auditor-grants" && m === "GET") return json(route, { enabled: true, grants: [grant] });
      if (p === `/v1/trust/auditor-grants/${GRANT}/mfa/reset` && m === "POST") return json(route, { grantId: GRANT, ...resetOut });
      return null;
    });
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/trust/auditor-grants/${GRANT}/mfa/reset`, kind: "identity_manage" });
    await page.goto("/ui/admin/trust-publishing");
    await page.getByRole("tab", { name: "Auditor access" }).click();
    await page.getByRole("button", { name: "Second factor for Ada Auditor" }).click();
    const dialog = page.getByRole("dialog", { name: "Second factor for Ada Auditor" });
    await expect(dialog.getByText("Locked", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Reset second factor" }).click();
    const ask = page.getByRole("dialog", { name: "Reset the second factor for Ada Auditor?" });
    await ask.getByRole("textbox").fill("Auditor changed device");
    await ask.getByRole("button", { name: "Reset second factor" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    await expect(page.getByText(/Second factor reset\. 1 unused link revoked\./).first()).toBeVisible();
  });
});
