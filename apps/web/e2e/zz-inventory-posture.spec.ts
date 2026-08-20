/**
 * ADR-0082 in the real SPA — both new governance reads, driven read-only:
 *
 *  - Agent inventory: the standing dependency view renders with GRANTED and
 *    OBSERVED as separate labelled columns (the page's one rule), over the
 *    seeded agent catalog.
 *  - Posture: the board one-pager renders its headline figures, and its
 *    honesty survives the trip to the DOM — with no WORM medium in this
 *    harness the anchoring section must say NOT tamper-resistant (observed),
 *    and an unprobed deployment's red-team headline must read "unmeasured",
 *    never a reassuring 0%.
 *
 * Read-only on purpose: this spec writes nothing, so it cannot disturb the
 * shared seeded fixture — and it still runs LAST (zz- prefix, M-018) like
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

test("agent inventory renders granted and observed apart over the seeded catalog", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/inventory");
  await expect(page.getByRole("heading", { name: "Agent inventory" })).toBeVisible();

  // the one rule, in the table's own structure: MAY and DID are separate columns
  // (the kit Table's header cells expose role "cell", like the other specs read them)
  await expect(page.getByRole("cell", { name: "Granted (may)" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Observed (did)" })).toBeVisible();

  // the seeded catalog is inventoried
  await expect(page.getByRole("cell", { name: "balanced-mock", exact: true })).toBeVisible();

  // open the detail: the two blocks render side by side with their notes
  await page.getByRole("cell", { name: "balanced-mock", exact: true }).click();
  await expect(page.getByText("Granted — what the entitlement rows allow")).toBeVisible();
  await expect(page.getByText("Observed — what the run history recorded")).toBeVisible();
  // the granted block says what it is NOT — a policy simulation
  await expect(page.getByText(/not a\s+policy simulation/)).toBeVisible();
});

test("posture renders board headlines with its honesty intact", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/posture");
  await expect(page.getByRole("heading", { name: "Posture", exact: true })).toBeVisible();

  // the four headline tiles
  await expect(page.getByText("open + mitigating risks")).toBeVisible();
  await expect(page.getByText("latest attack-success rate")).toBeVisible();
  await expect(page.getByText(/^AI spend — /)).toBeVisible();

  // no WORM medium in this harness → the anchoring grading must be the
  // OBSERVED negative, in words (same contract zz-audit-verify pins)
  await expect(page.getByText(/NOT tamper-resistant|no anchor sink/).first()).toBeVisible();

  // the print affordance exists (CSS-only print path — no PDF dependency)
  await expect(page.getByRole("button", { name: "Print one-pager" })).toBeVisible();

  // the no-snapshot statement rides the page
  await expect(page.getByText(/no rollup table, no\s+stored snapshot/)).toBeVisible();
});
