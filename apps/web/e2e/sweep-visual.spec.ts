/**
 * Looking pass over the page-header sweep (the `sub` → `info` move).
 *
 * The sweep shortened 52 page subtitles and put the long prose behind an info
 * trigger. Two things about that are only visible by LOOKING, and this spec is
 * where they get looked at:
 *
 *  - the trigger must be a SIBLING of the <h1>, not a child. Inside the
 *    heading its label joins the heading's accessible name, so every swept page
 *    would announce as "Scheduled jobs What is the Scheduled jobs page?" — the
 *    landmark a screen-reader user navigates by, degraded on 52 screens at
 *    once. The `exact: true` heading assertions below are what catch that;
 *  - the panel has to open without colliding with the heading or the actions
 *    beside it, which is a screenshot question, not an assertion.
 *
 * Read-only: it signs in and navigates, and writes nothing. Sign-in is the
 * order-independent helper the rest of the suite uses (M-017) and settles on
 * the SAME shared admin password — a spec that rotates the admin credential
 * leaves every later spec unable to sign in, which is exactly what the first
 * draft of this file did.
 */
import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string };
};
const SHOTS = path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

/** the password every admin spec in this suite settles on */
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
    expect(i, `no candidate password worked for admin`).toBeLessThan(candidates.length - 1);
  }
  throw new Error("could not sign in as admin");
}

test("page headers after the sweep", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  for (const [nav, heading, settled, file] of [
    // `settled` is body content the page only renders once its query resolves.
    // Without it the shot lands on the loading skeleton — which is what
    // happened first time, and a looking pass that photographs a skeleton
    // looks exactly like a looking pass that worked.
    ["Scheduled jobs", "Scheduled jobs", "registered jobs", "scheduler"],
    ["Audit log", "Audit log", "Chain integrity", "audit"],
  ] as const) {
    await page.getByLabel("Filter navigation").fill(nav);
    await page.getByRole("link", { name: nav, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByText(settled, { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, `sweep-${file}.png`), fullPage: false });
  }

  // and one with the panel open, to check it clears the heading and the actions
  await page.getByRole("button", { name: /What is the Audit log page/ }).click();
  await expect(page.getByRole("note")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "sweep-audit-info.png"), fullPage: false });
});
