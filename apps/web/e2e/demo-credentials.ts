/**
 * B4S-06 — how the REAL demo journeys sign the personas in once the
 * bootstrap credential no longer can re-provision them.
 *
 * The bootstrap credential passes a step-up only during first-admin setup:
 * `demo:prepare`'s seed enrols Ada's authenticator, and from then on issuing
 * someone a one-time password or clearing their MFA (both settings_relax) is a
 * step-up only a person can give. So the journeys no longer mint credentials
 * with the bootstrap token. They use what `demo:prepare` printed ONCE for the
 * presenter — the three one-time passwords and Ada's authenticator secret —
 * read from its captured output (`E2E_DEMO_PREPARE_LOG`, the same text the
 * presenter reads on the console), exactly as `global-setup.ts` reads the
 * seed's. The first journey replaces a persona's one-time password with its
 * own; the password a journey set is kept in a git-ignored store (keyed to the
 * one-time password it replaced, so a freshly prepared database never reuses
 * a stale entry), and a later journey signs in with it. A protected write a
 * journey still needs (a one-time password for a fixture admin) is made by
 * Ada, stepped up with her authenticator (`steppedUpAs`).
 */
import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextCode, passTotp, recordTotpSecret } from "./totp-sign-in";

const here = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD_STORE = path.join(here, ".e2e-passwords.json");
export const DEMO_PREPARE_LOG_ENV = "E2E_DEMO_PREPARE_LOG";

export type Persona = "admin" | "dana" | "avery";
export const PERSONA_EMAIL: Record<Persona, string> = {
  admin: "admin@regulait.local",
  dana: "dana@regulait.local",
  avery: "avery@regulait.local",
};

interface PreparedCredentials {
  oneTime: Partial<Record<string, string>>;
  adminTotpSecret: string | null;
}

/** the one-time passwords and Ada's authenticator secret `demo:prepare` printed, or null */
export function preparedCredentials(): PreparedCredentials | null {
  const file = process.env[DEMO_PREPARE_LOG_ENV];
  if (!file) return null;
  const out = readFileSync(file, "utf8");
  const oneTime: Partial<Record<string, string>> = {};
  for (const [name, email] of Object.entries(PERSONA_EMAIL)) {
    const m = new RegExp(`${name}\\s+${email.replace(/\./g, "\\.")}\\s+(\\S+)`).exec(out);
    if (m?.[1] && !m[1].startsWith("(")) oneTime[email] = m[1];
  }
  const uri = /admin TOTP \(shown ONCE[^)]*\): (otpauth:\/\/totp\/\S+)/.exec(out)?.[1];
  return { oneTime, adminTotpSecret: uri ? new URL(uri).searchParams.get("secret") : null };
}

type PasswordStore = Record<string, { password: string; replaced: string }>;
function loadPasswords(): PasswordStore {
  try {
    return JSON.parse(readFileSync(PASSWORD_STORE, "utf8")) as PasswordStore;
  } catch {
    return {};
  }
}
function recordPassword(email: string, password: string, replaced: string): void {
  const store = loadPasswords();
  store[email.toLowerCase()] = { password, replaced };
  const tmp = `${PASSWORD_STORE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, PASSWORD_STORE);
}

/**
 * Sign `email` in on `page` with the credentials demo:prepare printed: the
 * password an earlier journey set (when it replaced THIS database's one-time
 * password), else the one-time password, replaced by `newPassword`. Answers
 * Ada's TOTP challenge from her printed secret. Returns null when no captured
 * output names this persona (the caller decides what that means).
 */
export async function signInPrepared(page: Page, email: string, newPassword: string, landing: Parameters<typeof passTotp>[2]) {
  const creds = preparedCredentials();
  const oneTime = creds?.oneTime[email];
  if (!creds || !oneTime) return null;
  if (creds.adminTotpSecret) recordTotpSecret(PERSONA_EMAIL.admin, creds.adminTotpSecret);
  const known = loadPasswords()[email.toLowerCase()];
  const password = known && known.replaced === oneTime ? known.password : oneTime;
  await page.goto("/ui");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (password === oneTime) {
    await passTotp(page, email, page.getByLabel("Current (one-time) password"));
    await page.getByLabel("Current (one-time) password").fill(oneTime);
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm new password").fill(newPassword);
    await page.getByRole("button", { name: "Set password & continue" }).click();
    recordPassword(email, newPassword, oneTime);
  }
  await passTotp(page, email, landing);
  return true;
}

/**
 * A protected write made by the signed-in person behind `request` (a page's
 * request context), stepped up the real way: refused 403 step_up_required with
 * the action, a TOTP step-up for exactly that action (a code from `email`'s
 * recorded secret; a refused code burns that ceremony and the next unused step
 * is tried in a new one), then the same request again with the grant.
 */
export async function steppedUpAs(
  request: APIRequestContext,
  email: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  data: unknown,
): Promise<APIResponse> {
  const csrf = { "x-regulait-csrf": "1" };
  const first = await request.fetch(url, { method, headers: csrf, data });
  const refusal = first.status() === 403 ? ((await first.json()) as { error?: string; action?: unknown; methods?: string[] }) : null;
  if (!refusal || refusal.error !== "step_up_required" || !refusal.methods?.includes("totp")) return first;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const o = await request.post("/v1/auth/step-up/options", { headers: csrf, data: { action: refusal.action } });
    expect(o.status(), `step-up options: ${await o.text()}`).toBe(200);
    const v = await request.post("/v1/auth/step-up/verify", {
      headers: csrf,
      data: { stepUpId: (await o.json()).stepUpId, method: "totp", code: await nextCode(email) },
    });
    if (v.status() === 401) continue; // a code the gateway had already passed: the next step, in a new ceremony
    expect(v.status(), `step-up verify: ${await v.text()}`).toBe(200);
    return request.fetch(url, { method, headers: { ...csrf, "x-regulait-step-up": (await v.json()).stepUpToken }, data });
  }
  throw new Error(`no TOTP code was accepted for ${email}'s step-up after four attempts`);
}
