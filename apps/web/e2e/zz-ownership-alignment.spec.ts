/**
 * ADR-0089 in the real SPA (gaps L20/L21) — the ownership and alignment
 * blocks on the pages ADR-0082 already ships, driven read-only:
 *
 *  - Agent inventory: the "Owner / lifecycle" and "Intent alignment" columns
 *    render, and the seeded catalog — which has NO recorded owners — shows
 *    "no owner recorded" as an explicit WARNING badge, never a blank cell
 *    (the flag-never-default rule, surviving the trip to the DOM).
 *  - The detail renders the two new cards with their honesty notes: the
 *    ownership note says the flag is never a default, and the alignment note
 *    says the flags are never about observed traffic.
 *  - Posture: the "Agent ownership" coverage card renders with the unowned
 *    count stated in words and the governance-record-not-authentication note.
 *
 * Read-only on purpose: this spec writes nothing, so it cannot disturb the
 * shared seeded fixture — and it still runs late (zz- prefix, M-018) like
 * every late addition to this suite.
 */
import { expect, test, type Page } from "@playwright/test";
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
 * Order-independent sign-in, copied from the phase4-7 / zz- specs. The suite
 * shares ONE seeded database, so the seeded one-time password is consumed by
 * whichever spec runs first; trying the candidates in turn and settling on
 * the SHARED password keeps every spec runnable in any order.
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

test("inventory renders ownership and alignment as flags — 'no owner recorded' is a badge, never a blank", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/inventory");
  await expect(page.getByRole("heading", { name: "Agent inventory" })).toBeVisible();

  // the two ADR-0089 columns join the granted/observed structure
  await expect(page.getByRole("cell", { name: "Owner / lifecycle" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Intent alignment" })).toBeVisible();

  // the seeded catalog has no recorded owners: the flag renders, in words
  await expect(page.getByText("no owner recorded").first()).toBeVisible();

  // open a detail: both new cards render with their honesty notes
  await page.getByRole("cell", { name: "balanced-mock", exact: true }).click();
  await expect(page.getByText("Ownership & lifecycle — the accountability record")).toBeVisible();
  await expect(page.getByText("Intended vs granted — approved intent only")).toBeVisible();
  await expect(page.getByText(/never a default/).first()).toBeVisible();
  await expect(page.getByText(/never about observed traffic/).first()).toBeVisible();
});

test("posture carries the agent-ownership coverage with its honesty note", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/posture");
  await expect(page.getByRole("heading", { name: "Posture", exact: true })).toBeVisible();

  await expect(page.getByText("Agent ownership", { exact: true })).toBeVisible();
  // the seeded agents predate ownership: the unowned count is said in words
  await expect(page.getByText(/are unowned \(no owner recorded\)/)).toBeVisible();
  await expect(page.getByText(/governance record, not authentication/).first()).toBeVisible();
});
