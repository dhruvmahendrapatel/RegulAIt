/**
 * ADR-0085 in the real SPA — the EU AI Act screening driven end to end on
 * the use-case registration (ADR-0080; ADR-0168 made the intake wizard the
 * only way in), with the PROHIBITED example:
 *
 *  - register a use case through "Register AI use case", answering "Social
 *    scoring" yes on the Classify step — the tier is computed SERVER-SIDE
 *    from the answers block the wizard submits with the questionnaire;
 *  - the registry's preview then renders the unmissable refusal-shaped banner
 *    (role=alert), the Art. 5 reason and the screening-not-legal-advice
 *    disclaimer — while the intake still awaits its HUMAN sign-off, because
 *    a tier auto-blocks nothing (asserted, not just documented).
 *
 * This spec WRITES (a use case + its workflow instance + risks), so it runs
 * LAST (zz- prefix, M-018) and creates only uct-e2e-prefixed objects nothing
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

/**
 * Register a use case through the intake wizard (ADR-0168: the only way in).
 * Every Classify answer is filled; `socialScoring` decides the screening.
 */
async function registerUseCase(page: Page, f: { name: string; what: string; socialScoring: "yes" | "no" }) {
  await page.goto("/ui/admin/use-cases");
  await expect(page.getByRole("heading", { name: "AI registry", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Register AI use case" }).click();
  await page.getByLabel("Use-case name").fill(f.name);
  await page.getByLabel("What will the system do?").fill(f.what);
  await page.getByRole("button", { name: "Continue" }).click();
  for (const [label, value] of [
    ["Primary purpose domain", "general-business"], ["People affected", "general-public"], ["Decision autonomy", "fully-automated"],
    ["Biometric use", "none"], ["Deployment audience", "public"],
  ] as const) await page.getByLabel(label).selectOption(value);
  await page.getByLabel("Sectors: Public sector", { exact: true }).check();
  await page.getByLabel("Data categories: Personal", { exact: true }).check();
  for (const label of ["Emotion recognition", "Manipulative techniques", "Safety component", "Generates synthetic content", "Can take autonomous actions", "Uses an external AI vendor"]) {
    await page.getByLabel(label).selectOption("no");
  }
  for (const label of ["Profiles natural persons", "Interacts directly with people", "Has an EU nexus"]) await page.getByLabel(label).selectOption("yes");
  await page.getByLabel("Social scoring").selectOption(f.socialScoring);
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await expect(page.locator('[aria-current="step"]')).toContainText("Suggestions");
  const acceptAll = page.getByRole("button", { name: /Accept all remaining/ });
  if (await acceptAll.isEnabled()) await acceptAll.click();
  for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Submit for human review" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
}

test("a social-scoring use case screens PROHIBITED — banner, Art. 5 reason, disclaimer — and still awaits its human sign-off", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await registerUseCase(page, {
    name: "uct-e2e-citizen-score",
    what: "rank citizens by social behaviour for perks",
    socialScoring: "yes",
  });
  // the wizard says so before submission, too
  await expect(page.getByRole("alert").filter({ hasText: "Screened PROHIBITED (Art. 5)" })).toBeVisible();

  // open the registry preview of THIS record
  await page.goto("/ui/admin/use-cases");
  await page.getByLabel("Search use cases").fill("uct-e2e-citizen-score");
  const row = page.getByRole("link", { name: /^uct-e2e-citizen-score,/ });
  // the registry row shows the decided-not-blocked status
  await expect(row.getByText("Under review")).toBeVisible();
  await row.click();
  const preview = page.getByRole("dialog", { name: "uct-e2e-citizen-score" });
  await expect(preview).toBeVisible();

  // the refusal-shaped banner is unmissable (role=alert), with the Art. 5 reason
  const banner = preview.getByRole("alert").filter({ hasText: "PROHIBITED under Art. 5" });
  await expect(banner).toBeVisible();
  await expect(banner.getByText("does not auto-block")).toBeVisible();
  await expect(preview.getByText("Art. 5(1)(c)", { exact: true })).toBeVisible();
  await expect(preview.getByText(/not legal advice/).first()).toBeVisible();

  // and NOTHING auto-blocked: the intake still awaits its HUMAN decision on
  // the one approvals queue — the tier informed it, it did not replace it
  await expect(preview.getByText("Waiting for sign-off")).toBeVisible();
  await expect(preview.getByRole("link", { name: "Approvals queue" })).toBeVisible();
});
