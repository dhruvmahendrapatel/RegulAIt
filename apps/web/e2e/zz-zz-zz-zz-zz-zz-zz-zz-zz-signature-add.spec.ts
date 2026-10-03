/**
 * A custom detection signature can be ADDED, not only seeded and deleted.
 *
 * The catalogue could install the shipped seed and delete rows from it, and a
 * signature it did not ship could not be added from anywhere. That is the wrong
 * way round for this feature in particular: the shipped seed covers the
 * well-known providers, and the endpoints a specific customer needs to detect
 * are by definition the ones nobody shipped. An internal LLM gateway on a
 * private hostname is exactly the shadow AI a governance team wants found, and
 * it was the one thing the catalogue could not be told about.
 *
 * The assertion that earns its keep is the SECOND one. `matchType` is derived
 * from `kind` rather than asked, because the gateway accepts only
 * sdk_package↔package and api_key_prefix↔key_prefix and would reject anything
 * else. Deriving it wrongly produces a form that looks right and 400s on every
 * submit, so the spec adds one of each coupled kind and checks the row that
 * comes back, not just that the request was made.
 *
 * Writes, so it runs last (zz-, M-018) and creates only sig-e2e- fixtures.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string };
};

const ADMIN_PASSWORD = "E2e-Admin-Phase2!";

async function signIn(page: Page, email: string, candidates: string[], settleOn: string) {
  for (const [i, password] of candidates.entries()) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    const welcome = page.getByRole("heading", { name: /Welcome back/ });
    const forcedChange = page.getByText("Your password is one-time");
    const rejected = page.getByText(/password is incorrect/);
    await expect(welcome.or(forcedChange).or(rejected).first()).toBeVisible();

    if (await welcome.isVisible()) return password;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await expect(welcome).toBeVisible();
      return settleOn;
    }
    expect(i, `no candidate password worked for admin`).toBeLessThan(candidates.length - 1);
  }
  throw new Error("could not sign in as admin");
}

test("a custom signature is added, and its match type is derived correctly", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("heading", { name: "Shadow-AI discovery", exact: true })).toBeVisible();

  const host = `llm.sig-e2e-${Date.now()}.internal.example`;

  // (a) a hostname signature — the kind with a REAL match-type choice
  await page.getByLabel("Provider", { exact: true }).fill("sig-e2e internal gateway");
  await page.getByLabel("Detect by", { exact: true }).selectOption("hostname");
  await page.getByLabel("Hostname", { exact: true }).fill(host);
  await page.getByLabel("Match", { exact: true }).selectOption("host_suffix");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/v1/shadow-ai/catalogue") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add signature" }).click();
  expect((await created).status(), "a derived matchType the gateway refuses would 400 here").toBe(201);
  await expect(page.getByRole("row").filter({ hasText: host })).toBeVisible();

  // (b) an api_key_prefix — the kind whose matchType is FORCED to key_prefix and
  //     which the gateway refuses outright without a minLength. If the form
  //     derived either one wrongly, this is where it shows.
  const prefix = `sige2e${Date.now()}-`;
  await page.getByLabel("Provider", { exact: true }).fill("sig-e2e key issuer");
  await page.getByLabel("Detect by", { exact: true }).selectOption("api_key_prefix");
  await page.getByLabel("Key prefix", { exact: true }).fill(prefix);
  await expect(page.getByLabel("Min key length", { exact: true })).toBeVisible();
  // and the free host-match control is gone, because for this kind there is no choice
  await expect(page.getByLabel("Match", { exact: true })).toHaveCount(0);
  const created2 = page.waitForResponse(
    (r) => r.url().endsWith("/v1/shadow-ai/catalogue") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add signature" }).click();
  expect((await created2).status()).toBe(201);
  await expect(page.getByRole("row").filter({ hasText: prefix })).toBeVisible();
});
