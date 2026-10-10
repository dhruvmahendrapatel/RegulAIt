/**
 * ADR-0186 A (slice A1) — passkeys and the step-up dialog, against a mocked
 * gateway (the *.mock.spec.ts harness):
 *
 *  - Account → Passkeys lists, adds (a second passkey asks "Confirm it's you"
 *    first: the dialog runs the passkey step-up, and the SAME registration
 *    request is resent with the grant) and revokes (confirmed with an
 *    authenticator code; the DELETE is resent with the grant);
 *  - the dialog never loops: a protected request refused again after its grant
 *    ends with the refusal, once;
 *  - an admin revokes another user's passkey from the Users page, after their
 *    own step-up;
 *  - axe (WCAG 2.x A/AA) in light and dark on the Passkeys section and the dialog.
 *
 * WebAuthn itself is faked in the page (`navigator.credentials`): the browser
 * library's job is only to carry the ceremony; the gateway verifies it (proved
 * against real signatures in the gateway suite).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

async function fakeWebAuthn(page: Page) {
  await page.addInitScript(() => {
    const buf = (s: string) => new TextEncoder().encode(s).buffer;
    const credential = (create: boolean) => ({
      id: "Y3JlZC0x",
      rawId: buf("cred-1"),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: create
        ? { clientDataJSON: buf("{}"), attestationObject: buf("att"), getTransports: () => ["internal"] }
        : { clientDataJSON: buf("{}"), authenticatorData: buf("ad"), signature: buf("sig"), userHandle: null },
      getClientExtensionResults: () => ({}),
    });
    const w = window as unknown as { __webauthn: { create: number; get: number } };
    w.__webauthn = { create: 0, get: 0 };
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async () => {
          w.__webauthn.create += 1;
          return credential(true);
        },
        get: async () => {
          w.__webauthn.get += 1;
          return credential(false);
        },
      },
    });
  });
}

interface Captured {
  registrationOptions: Array<string | null>;
  registered: unknown[];
  stepUpOptions: unknown[];
  verifies: unknown[];
  deletes: Array<{ path: string; header: string | null }>;
}

async function mockApi(page: Page, opts: { admin: boolean; methods: string[]; refuseAgain?: boolean }): Promise<Captured> {
  const cap: Captured = { registrationOptions: [], registered: [], stepUpOptions: [], verifies: [], deletes: [] };
  const passkeys = [{ id: "pk-1", label: "Work laptop", createdAt: iso(-30), lastUsedAt: iso(-1), backedUp: true }];
  const me = opts.admin
    ? { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } }
    : { userId: "u-ben", isAdmin: false, user: { id: "u-ben", email: "ben@example.test", displayName: "Ben Builder" } };
  const refusal = (kind: string, body: Record<string, unknown>) => ({
    error: "step_up_required",
    actionKind: kind,
    methods: opts.methods,
    action: { kind, body },
    detail: "this action needs you to confirm it's you",
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    const grant = req.headers()["x-regulait-step-up"] ?? null;
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/auth/sessions") return json(route, { sessions: [] });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    if (p === "/v1/auth/passkeys" && method === "GET") return json(route, { passkeys, rpConfigured: true });
    if (p === "/v1/auth/passkeys/registration-options") {
      cap.registrationOptions.push(grant);
      if (!grant) return json(route, refusal("passkey_manage", { op: "register" }), 403);
      return json(route, {
        challengeId: "11111111-1111-4111-8111-111111111111",
        options: {
          challenge: B64,
          rp: { name: "RegulAIt", id: "127.0.0.1" },
          user: { id: B64, name: "ben@example.test", displayName: "Ben Builder" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          timeout: 120000,
          attestation: "none",
          excludeCredentials: [],
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        },
      });
    }
    if (p === "/v1/auth/passkeys" && method === "POST") {
      cap.registered.push(req.postDataJSON());
      const body = req.postDataJSON() as { label: string };
      passkeys.push({ id: "pk-2", label: body.label, createdAt: iso(0), lastUsedAt: null, backedUp: false });
      return json(route, { id: "pk-2", label: body.label, createdAt: iso(0), backedUp: false }, 201);
    }
    if (p === "/v1/auth/step-up/options") {
      cap.stepUpOptions.push(req.postDataJSON());
      const action = (req.postDataJSON() as { action: { kind: string } }).action;
      return json(route, {
        stepUpId: "22222222-2222-4222-8222-222222222222",
        actionKind: action.kind,
        methods: opts.methods,
        expiresAt: iso(0.003),
        ...(opts.methods.includes("passkey")
          ? { passkey: { options: { challenge: B64, rpId: "127.0.0.1", allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }], userVerification: "required", timeout: 120000 } } }
          : {}),
      });
    }
    if (p === "/v1/auth/step-up/verify") {
      cap.verifies.push(req.postDataJSON());
      return json(route, { stepUpToken: `rgsu_${cap.verifies.length}`, expiresAt: iso(0.001), method: "passkey", actionKind: "passkey_manage" });
    }
    const del = /^\/v1\/(auth\/passkeys|users\/[^/]+\/passkeys)\/([^/]+)$/.exec(p);
    if (del && method === "DELETE") {
      cap.deletes.push({ path: p, header: grant });
      if (!grant || opts.refuseAgain) {
        return json(route, refusal("passkey_manage", { op: "revoke", passkeyId: del[2] }), 403);
      }
      const i = passkeys.findIndex((k) => k.id === del[2]);
      if (i >= 0) passkeys.splice(i, 1);
      return json(route, { id: del[2], revoked: true });
    }
    if (p === "/v1/users" && method === "GET") {
      return json(route, {
        users: [
          { id: "u-ana", email: "ana@example.test", displayName: "Ana Analyst", isAdmin: false, disabledAt: null, createdAt: iso(-90), totpEnabled: true, hasPassword: true, mustChangePassword: false },
        ],
      });
    }
    if (p === "/v1/users/u-ana/passkeys") {
      return json(route, { passkeys: [{ id: "pk-ana", label: "Ana's phone", createdAt: iso(-10), lastUsedAt: null, backedUp: true, revokedAt: null, revokeReason: null }] });
    }
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    const results = await new AxeBuilder({ page })
      .include(include)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0186 A: passkeys and step-up", () => {
  test("adding a second passkey asks to confirm it's you, then resends the registration with the grant", async ({ page }) => {
    await fakeWebAuthn(page);
    const cap = await mockApi(page, { admin: false, methods: ["passkey", "totp"] });
    await page.goto("/ui/account?section=passkeys");
    const card = page.locator('[data-testid="account-passkeys"]');
    await expect(card).toContainText("Work laptop");
    await expect(card).toContainText("synced");
    await expectAxeClean(page, "account passkeys section", '[data-testid="account-passkeys"]');

    await card.getByLabel("Name for the new passkey").fill("Home desktop");
    await card.getByRole("button", { name: "Add a passkey" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(dialog).toContainText("You're changing your passkeys");
    await expect(dialog.getByRole("button", { name: "Use a passkey" })).toBeVisible();
    await expect(dialog.getByLabel("Authenticator code")).toBeVisible();
    await expectAxeClean(page, "step-up dialog", '[data-testid="step-up-dialog"]');
    await dialog.getByRole("button", { name: "Use a passkey" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toContainText('Added the passkey "Home desktop"');
    expect(cap.stepUpOptions).toEqual([{ action: { kind: "passkey_manage", body: { op: "register" } } }]);
    expect(cap.verifies).toHaveLength(1);
    expect(cap.verifies[0]).toMatchObject({ stepUpId: "22222222-2222-4222-8222-222222222222", method: "passkey" });
    // the same registration request, first without and then with the grant
    expect(cap.registrationOptions).toEqual([null, "rgsu_1"]);
    expect(cap.registered[0]).toMatchObject({ challengeId: "11111111-1111-4111-8111-111111111111", label: "Home desktop" });
    expect(await page.evaluate(() => (window as unknown as { __webauthn: { create: number; get: number } }).__webauthn)).toEqual({ create: 1, get: 1 });
  });

  test("revoking a passkey is confirmed with an authenticator code; the DELETE is resent with the grant", async ({ page }) => {
    await fakeWebAuthn(page);
    const cap = await mockApi(page, { admin: false, methods: ["totp"] });
    await page.goto("/ui/account?section=passkeys");
    const card = page.locator('[data-testid="account-passkeys"]');
    await card.getByRole("button", { name: 'Revoke the passkey "Work laptop"' }).click();
    await page.getByRole("dialog", { name: /Remove the passkey/ }).getByRole("button", { name: "Revoke" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(dialog.getByRole("button", { name: "Use a passkey" })).toHaveCount(0);
    await dialog.getByLabel("Authenticator code").fill("123456");
    await dialog.getByRole("button", { name: "Confirm with code" }).click();
    await expect(card).not.toContainText("Work laptop");
    expect(cap.verifies).toEqual([{ stepUpId: "22222222-2222-4222-8222-222222222222", method: "totp", code: "123456" }]);
    expect(cap.deletes).toEqual([
      { path: "/v1/auth/passkeys/pk-1", header: null },
      { path: "/v1/auth/passkeys/pk-1", header: "rgsu_1" },
    ]);
  });

  test("never loops: a request refused again after its grant ends with the refusal, after one step-up", async ({ page }) => {
    await fakeWebAuthn(page);
    const cap = await mockApi(page, { admin: false, methods: ["totp"], refuseAgain: true });
    await page.goto("/ui/account?section=passkeys");
    const card = page.locator('[data-testid="account-passkeys"]');
    await card.getByRole("button", { name: 'Revoke the passkey "Work laptop"' }).click();
    await page.getByRole("dialog", { name: /Remove the passkey/ }).getByRole("button", { name: "Revoke" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await dialog.getByLabel("Authenticator code").fill("123456");
    await dialog.getByRole("button", { name: "Confirm with code" }).click();
    await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(cap.deletes).toHaveLength(2);
    expect(cap.verifies).toHaveLength(1);
    await expect(card).toContainText("Work laptop");
  });

  test("an admin revokes another user's passkey after their own step-up", async ({ page }) => {
    await fakeWebAuthn(page);
    const cap = await mockApi(page, { admin: true, methods: ["passkey"] });
    await page.goto("/ui/admin/users");
    await page.getByRole("link", { name: "Manage Ana Analyst" }).click();
    await page.getByRole("tab", { name: "Passkeys" }).click();
    await page.getByRole("button", { name: `Revoke Ana Analyst's passkey "Ana's phone"` }).click();
    await page.getByRole("dialog", { name: /Remove Ana Analyst's passkey/ }).getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("dialog", { name: "Confirm it's you" }).getByRole("button", { name: "Use a passkey" }).click();
    await expect.poll(() => cap.deletes.length).toBe(2);
    expect(cap.deletes[1]).toEqual({ path: "/v1/users/u-ana/passkeys/pk-ana", header: "rgsu_1" });
  });
});

 test("Account model keys: Spend link has a non-colour cue in both themes",async({page},testInfo)=>{
 await mockApi(page,{admin:false,methods:["passkey"]});
 await page.route("**/v1/users/u-ben/model-credentials",route=>json(route,{credentials:[]}));
 await page.goto("/ui/account?section=keys");
 const link=page.getByRole("main").getByRole("link",{name:"Spend & savings",exact:true});await expect(link).toBeVisible();
 for(const theme of ["light","dark"]){
 await page.evaluate(theme=>document.documentElement.setAttribute("data-theme",theme),theme);
 await expect(link).toHaveCSS("text-decoration-line","underline");
 const result=await new AxeBuilder({page}).withRules(["link-in-text-block"]).analyze();expect(result.violations).toEqual([]);
 }
 await page.screenshot({path:testInfo.outputPath("account-model-keys.png")});
 });
