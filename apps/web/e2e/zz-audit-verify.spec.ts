/**
 * The ADR-0060 chain-integrity card, driven in the real SPA: an admin runs
 * verification on demand and reads the report with its honesty intact —
 * chain status, anchor source, and the observed (never configured) tamper
 * resistance. Without a MinIO in the stack the anchor source is the local
 * default and the card must say NOT tamper-resistant — the honest answer is
 * the assertion, not a compromise in it.
 */
import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string };
};

/** the password every admin spec in this suite settles on */
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";


/**
 * Order-independent sign-in, copied from the phase4-7 / brand-contract specs.
 * The suite shares ONE seeded database, so the seeded one-time password is
 * consumed by whichever spec runs first — a spec that only knows the one-time
 * password passes alone and fails in the suite. Trying the candidates in turn
 * and settling on the SHARED password keeps every spec runnable in any order.
 */
async function signIn(page: Page, email: string, candidates: string[], settleOn: string) {
  for (const [i, password] of candidates.entries()) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    const welcome = page.getByRole("heading", { name: /Welcome back/ });
    const forcedChange = page.getByText("Your password is one-time");
    const rejected = page.getByText(/password is incorrect/);
    await passTotp(page, email, welcome.or(forcedChange).or(rejected));

    if (await welcome.isVisible()) return password;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await passTotp(page, email, welcome);
      return settleOn;
    }
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

test("admin verifies the audit chain from the UI and reads an honest anchor report", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/audit");
  await expect(page.getByText("Chain integrity", { exact: false })).toBeVisible();

  // verification is ON DEMAND — no report before the click
  await expect(page.getByTestId("chain-report")).toHaveCount(0);
  await page.getByRole("button", { name: "Verify chain" }).click();

  const report = page.getByTestId("chain-report");
  await expect(report).toBeVisible();
  // the seeded trail verifies clean
  await expect(report.getByText("chain ok")).toBeVisible();
  // no MinIO in this harness → the local/database anchor must be reported as
  // NOT tamper-resistant. If this ever shows "tamper-resistant (observed)"
  // without a WORM medium present, the observed-grading contract broke.
  await expect(report.getByText("Not tamper-resistant")).toBeVisible();
  await expect(report.getByText(/anchor MISMATCH/)).toHaveCount(0);
});
