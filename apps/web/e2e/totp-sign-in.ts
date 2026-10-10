/**
 * ADR-0181: MFA is required for admins by default, so every journey that signs
 * in as an admin meets one of two TOTP screens after the password:
 *
 *  - ENROLMENT ("Generate enrollment secret") the first time that admin signs
 *    in on a database: the secret is read off the page, exactly as a person
 *    types it into an authenticator, and a code computed from it activates MFA;
 *  - the CHALLENGE ("Two-step verification") on every later sign-in, answered
 *    from the secret recorded at enrolment.
 *
 * Codes come from the gateway's own RFC 6238 implementation
 * (`apps/gateway/dist/totp.js`), never a second one. The secret store is a
 * git-ignored JSON file shared by the specs of one run (one worker, one
 * database); the web e2e global setup clears it with the database. The gateway
 * refuses a step at or before the last one it accepted (replay protection), so
 * each code is taken from the next unused step, waiting for a fresh 30-second
 * window only when the accepted ones are spent.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOTP_PERIOD_SECONDS, totpCode, totpStep } from "../../gateway/dist/totp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOTP_STORE = path.join(here, ".e2e-totp.json");

type Store = Record<string, { secret: string; lastStep: number }>;

function load(): Store {
  try {
    return JSON.parse(readFileSync(TOTP_STORE, "utf8")) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  const tmp = `${TOTP_STORE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, TOTP_STORE);
}

/** forget every recorded secret (a fresh database has no enrolments) */
export function resetTotpStore(): void {
  save({});
}

/** record the secret an enrolment showed (or a mocked gateway holds) for `email` */
export function recordTotpSecret(email: string, secret: string): void {
  const store = load();
  const known = store[email.toLowerCase()];
  // the same secret again keeps its last used step (the gateway remembers it too)
  if (known?.secret === secret) return;
  store[email.toLowerCase()] = { secret, lastStep: -1 };
  save(store);
}

/** The next code the gateway will accept for `email`, claimed before use so a
 * refused code is never retried. The gateway accepts the previous, current and
 * next step; the previous one is skipped near the end of a window, where it
 * would age out before the request lands. */
export async function nextCode(email: string): Promise<string> {
  for (;;) {
    const store = load();
    const entry = store[email.toLowerCase()];
    if (!entry) {
      throw new Error(
        `${email} was asked for a TOTP code, but no enrolment secret is on record in ${TOTP_STORE}. ` +
          "The account enrolled outside this run: prepare a fresh database.",
      );
    }
    const nowMs = Date.now();
    const now = totpStep(nowMs);
    const leftInWindow = TOTP_PERIOD_SECONDS - ((nowMs / 1000) % TOTP_PERIOD_SECONDS);
    const steps = [...(leftInWindow > 5 ? [now - 1] : []), now, now + 1];
    const step = steps.find((s) => s > entry.lastStep);
    if (step !== undefined) {
      store[email.toLowerCase()] = { ...entry, lastStep: step };
      save(store);
      return totpCode(entry.secret, step);
    }
    await new Promise((r) => setTimeout(r, Math.ceil(leftInWindow * 1000) + 250));
  }
}

/**
 * ADR-0181 (FX2): the demo seed enrols the admin persona's TOTP OUTSIDE any
 * browser run (so that her API key works) and shows the secret once on its own
 * console, and a secret store left by an earlier run may name another
 * database's enrolment. A journey that re-provisions a person from scratch (a
 * forced one-time password) therefore re-provisions their MFA too, through the
 * real, audited lost-authenticator route (`POST /v1/users/:id/mfa/clear`): the
 * person enrols again at that sign-in, from the secret on screen. An account
 * with no TOTP is left alone.
 *
 * B4S-02/06: clearing someone else's second factor is a settings_relax
 * step-up. With `adminOneTimePassword` (the seed's one-time password for Ada,
 * whose authenticator secret this run holds) Ada clears it, stepped up with her
 * authenticator (`asSteppedUpAdmin`). Without it the bootstrap credential is
 * used, which passes only during first-admin setup (no admin can step up yet);
 * its refusal is reported as such. Ada's own authenticator is never cleared
 * here: once she can step up, only she can prove who she is, so a run that does
 * not hold her secret must read it from demo:prepare's output instead
 * (E2E_DEMO_PREPARE_LOG, see demo-credentials.ts).
 */
export async function reprovisionTotp(
  baseUrl: string,
  bootHeaders: Record<string, string>,
  email: string,
  adminOneTimePassword?: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/users`, { headers: bootHeaders });
  const users = ((await res.json()) as { users: Array<{ id: string; email: string; totpEnabled?: boolean }> }).users;
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user?.totpEnabled) return;
  const reason = "e2e journey: the authenticator enrolled by the demo seed is not held by this run; the person re-enrols at sign-in";
  if (adminOneTimePassword !== undefined) {
    // a dynamic import: admin-api imports this module (nextCode, passTotp)
    const { ADMIN_EMAIL, asSteppedUpAdmin } = await import("./admin-api");
    if (email.toLowerCase() === ADMIN_EMAIL) {
      throw new Error(
        `${email} is the admin who gives the step-up: her authenticator cannot be cleared by the journey — ` +
          "use the secret demo:prepare printed (E2E_DEMO_PREPARE_LOG)",
      );
    }
    const cleared = await asSteppedUpAdmin(baseUrl, adminOneTimePassword, "POST", `/v1/users/${user.id}/mfa/clear`, { reason });
    expect(cleared.status(), `Ada clearing ${email}'s TOTP for re-enrolment: ${cleared.bodyText}`).toBe(200);
    return;
  }
  const cleared = await fetch(`${baseUrl}/v1/users/${user.id}/mfa/clear`, {
    method: "POST",
    headers: { ...bootHeaders, "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const text = await cleared.text();
  expect(
    cleared.status,
    `clearing ${email}'s TOTP for re-enrolment with the bootstrap credential (first-admin setup only; ` +
      `once an admin can step up, pass the admin's one-time password so she clears it): ${text}`,
  ).toBe(200);
}

/**
 * After a credential step, answer any TOTP screen the app shows for `email`
 * until `target` is on screen. Safe to call for anybody: a person with no TOTP
 * requirement goes straight to `target`.
 */
export async function passTotp(page: Page, email: string, target: Locator): Promise<void> {
  const challenge = page.getByRole("heading", { name: "Two-step verification" });
  const enrol = page.getByRole("button", { name: "Generate enrollment secret" });
  for (let round = 0; round < 6; round += 1) {
    await expect(target.or(challenge).or(enrol).first()).toBeVisible();
    if (await challenge.isVisible()) {
      await page.getByLabel("Authenticator code").fill(await nextCode(email));
      await page.getByRole("button", { name: "Verify" }).click();
      await expect(challenge).toBeHidden({ timeout: 5_000 }).catch(() => undefined);
      continue;
    }
    if (await enrol.isVisible()) {
      await enrol.click();
      const uri = page.getByText(/^otpauth:\/\/totp\//);
      await expect(uri).toBeVisible();
      const secret = new URL((await uri.textContent())!.trim()).searchParams.get("secret");
      expect(secret, "the enrolment screen shows the secret").toBeTruthy();
      recordTotpSecret(email, secret!);
      await page.getByLabel("Code from your authenticator").fill(await nextCode(email));
      await page.getByRole("button", { name: "Activate MFA & continue" }).click();
      await expect(enrol.or(page.getByLabel("Code from your authenticator"))).toBeHidden({ timeout: 5_000 }).catch(() => undefined);
      continue;
    }
    return;
  }
  throw new Error(`the TOTP screens did not let ${email} through after six attempts`);
}
