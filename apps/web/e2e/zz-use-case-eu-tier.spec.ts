/**
 * ADR-0085 in the real SPA — the EU AI Act screening driven end to end on
 * the ADR-0080 use-case intake, with the PROHIBITED example:
 *
 *  - propose a use case, finish planning, tick "Social scoring" in the
 *    structured screening controls, submit the questionnaire — the tier is
 *    computed SERVER-SIDE from the answers block the page serializes;
 *  - the detail then renders the unmissable refusal-shaped banner
 *    (role=alert), the Art. 5 reason, and the screening-not-legal-advice
 *    disclaimer — while the intake still awaits its HUMAN sign-off, because
 *    a tier auto-blocks nothing (asserted, not just documented).
 *
 * This spec WRITES (a use case + its workflow instance), so it runs LAST
 * (zz- prefix, M-018) and creates only uct-e2e-prefixed objects nothing
 * earlier asserts about. Sign-in is the order-independent helper the other
 * zz- specs use (M-017).
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

test("a social-scoring use case screens PROHIBITED — banner, Art. 5 reason, disclaimer — and still awaits its human sign-off", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/use-cases");
  await expect(page.getByRole("heading", { name: "Use cases", exact: true })).toBeVisible();

  // propose
  await page.getByLabel("Name", { exact: true }).fill("uct-e2e-citizen-score");
  await page.getByLabel("Description").fill("rank citizens by social behaviour for perks");
  await page
    .getByLabel("Business context — why the business wants this")
    .fill("a partner asked for a loyalty score");
  await page.getByRole("button", { name: "Propose use case" }).click();
  await expect(
    page.getByText("Use case proposed — its intake workflow is resting at the plan stage"),
  ).toBeVisible();

  // open the detail and drive the intake off the resting plan stage
  await page.getByRole("cell", { name: "uct-e2e-citizen-score", exact: true }).click();
  await expect(page.getByText("Use case: uct-e2e-citizen-score")).toBeVisible();
  // before any questionnaire: honestly not screened, never guessed
  await expect(page.getByText(/Not screened/)).toBeVisible();
  await page.getByRole("button", { name: "Finish planning" }).click();
  await expect(page.getByText("Intake questionnaire — fill and submit")).toBeVisible();

  // the structured screening controls: tick the prohibited practice
  await expect(page.getByText("EU AI Act risk screening (ADR-0085)")).toBeVisible();
  await page.getByLabel("Social scoring", { exact: true }).check();
  await page.getByRole("button", { name: "Submit questionnaire" }).click();
  await expect(
    page.getByText("Questionnaire submitted — the use case is under review"),
  ).toBeVisible();

  // the refusal-shaped banner is unmissable (role=alert), with the Art. 5 reason
  const banner = page.getByRole("alert").filter({ hasText: "PROHIBITED under Art. 5" });
  await expect(banner).toBeVisible();
  await expect(banner.getByText("does not auto-block")).toBeVisible();
  await expect(page.getByText("Art. 5(1)(c)", { exact: true })).toBeVisible();
  await expect(page.getByText(/not legal advice/).first()).toBeVisible();

  // and NOTHING auto-blocked: the intake still awaits its HUMAN decision on
  // the one approvals queue — the tier informed it, it did not replace it
  await expect(page.getByText(/Awaiting sign-off/)).toBeVisible();
  // the registry row (rendered as a link-row) shows the decided-not-blocked status
  await expect(
    page.getByRole("link", { name: /uct-e2e-citizen-score/ }).getByText("under review"),
  ).toBeVisible();
});
