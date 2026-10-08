/**
 * B4S-06 — a protected write the journeys make AS THE ADMIN, stepped up the
 * real way.
 *
 * The bootstrap credential passes a step-up only during first-admin setup,
 * and the seed enrols Ada's authenticator, so a relaxation, an owner change or
 * a password issued to someone else is no longer something the bootstrap
 * token can do here. The journeys make those writes as Ada: an API context
 * signs her in (the suite's admin password, else the one-time password the
 * seed printed, replaced by the suite's admin password), answers the TOTP
 * challenge from her recorded secret, and sends the write; a 403
 * step_up_required is answered with a TOTP step-up for exactly that action and
 * the write is sent again with the grant (`steppedUpAs`). Nothing is relaxed.
 *
 * `confirmStepUp` answers the same step-up when it is the APP that asks (the
 * "Confirm it's you" dialog a protected button opens).
 */
import { expect, request, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";
import { nextCode, passTotp } from "./totp-sign-in";
import { steppedUpAs } from "./demo-credentials";

export const ADMIN_EMAIL = "admin@regulait.local";
/** the password the journeys give Ada once her one-time password is spent (phase2 sets the same) */
export const E2E_ADMIN_PASSWORD = "E2e-Admin-Phase2!";
const CSRF = { "x-regulait-csrf": "1" };

/**
 * An API context signed in as `email`: the first of `candidates` that the
 * gateway accepts; a one-time password (the LAST candidate, the seed's) is
 * replaced by `settleOn`; a TOTP challenge is answered from the recorded secret.
 */
export async function signedInContext(baseURL: string, email: string, candidates: string[], settleOn: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const oneTime = candidates[candidates.length - 1];
  for (const password of candidates) {
    const login = await ctx.post("/auth/login", { headers: CSRF, data: { email, password } });
    if (login.status() === 401) continue;
    expect(login.status(), `${email} sign-in: ${await login.text()}`).toBe(200);
    const body = (await login.json()) as { mfaRequired?: boolean; pendingToken?: string; mustChangePassword?: boolean };
    if (body.mfaRequired) {
      let verified = false;
      for (let attempt = 0; attempt < 3 && !verified; attempt += 1) {
        const v = await ctx.post("/auth/mfa/verify", { headers: CSRF, data: { pendingToken: body.pendingToken, code: await nextCode(email) } });
        verified = v.status() === 200;
      }
      expect(verified, `${email} TOTP sign-in`).toBe(true);
    }
    if (password === oneTime && password !== settleOn) {
      const changed = await ctx.post("/auth/change-password", { headers: CSRF, data: { currentPassword: oneTime, newPassword: settleOn } });
      expect(changed.status(), `${email} password change: ${await changed.text()}`).toBe(200);
    }
    return ctx;
  }
  throw new Error(`${email} could not sign in with any of the journey's passwords`);
}

/** an API context signed in as Ada (TOTP answered, a one-time password replaced) */
export function adminContext(baseURL: string, oneTimePassword: string): Promise<APIRequestContext> {
  return signedInContext(baseURL, ADMIN_EMAIL, [E2E_ADMIN_PASSWORD, oneTimePassword], E2E_ADMIN_PASSWORD);
}

/** one protected write as Ada, stepped up with her authenticator */
export async function asSteppedUpAdmin(
  baseURL: string,
  oneTimePassword: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  data: unknown,
): Promise<APIResponse & { bodyText: string }> {
  const ctx = await adminContext(baseURL, oneTimePassword);
  try {
    const r = await steppedUpAs(ctx, ADMIN_EMAIL, method, url, data);
    return Object.assign(r, { bodyText: await r.text() });
  } finally {
    await ctx.dispose();
  }
}

/** the app asked "Confirm it's you": answer with a TOTP code for `email` */
export async function confirmStepUp(page: Page, email: string = ADMIN_EMAIL): Promise<void> {
  const dialog = page.getByTestId("step-up-dialog");
  await expect(dialog).toBeVisible();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dialog.getByLabel("Authenticator code").fill(await nextCode(email));
    await dialog.getByRole("button", { name: "Confirm with code" }).click();
    const closed = await dialog.waitFor({ state: "hidden", timeout: 5_000 }).then(() => true, () => false);
    if (closed) return;
  }
  throw new Error(`the step-up dialog did not accept a TOTP code for ${email}`);
}

/**
 * After a click that may need a step-up: wait until either `done` shows or the
 * app asks "Confirm it's you", and answer the dialog when it asks.
 */
export async function settleWithStepUp(page: Page, done: Locator, email: string = ADMIN_EMAIL): Promise<void> {
  const dialog = page.getByTestId("step-up-dialog");
  await expect(done.or(dialog).first()).toBeVisible();
  if (await dialog.isVisible()) await confirmStepUp(page, email);
}

/**
 * B4S round 3: Ada signs in on `page` with a one-time password she issues
 * HERSELF (a self-service write, no step-up — the bootstrap credential no longer
 * issues one once she can step up), replaces it with the suite's admin password
 * and answers her TOTP challenge. For a spec that owns its sign-in instead of
 * borrowing the seed's one-time password. The API sign-in, the UI sign-in and
 * the forced change each spend a TOTP step, so the caller allows ~90 s.
 */
export async function signInAdminFresh(page: Page, baseURL: string, seededOneTime: string): Promise<void> {
  const ctx = await adminContext(baseURL, seededOneTime);
  let password: string;
  try {
    const users = (await (await ctx.get("/v1/users")).json()) as { users: Array<{ id: string; email: string }> };
    const adminId = users.users.find((u) => u.email === ADMIN_EMAIL)!.id;
    const issued = await steppedUpAs(ctx, ADMIN_EMAIL, "POST", `/v1/users/${adminId}/set-initial-password`, { force: true });
    expect(issued.status(), `Ada's own one-time password: ${await issued.text()}`).toBe(200);
    password = ((await issued.json()) as { password: string }).password;
  } finally {
    await ctx.dispose();
  }
  await page.goto("/ui");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await passTotp(page, ADMIN_EMAIL, page.getByLabel("Current (one-time) password"));
  await page.getByLabel("Current (one-time) password").fill(password);
  await page.getByLabel("New password", { exact: true }).fill(E2E_ADMIN_PASSWORD);
  await page.getByLabel("Confirm new password").fill(E2E_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await passTotp(page, ADMIN_EMAIL, page.getByRole("heading", { name: /Welcome back/ }));
}
