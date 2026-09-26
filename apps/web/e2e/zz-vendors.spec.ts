/**
 * ADR-0084 in the real SPA — the vendor registry driven end to end:
 *
 *  - propose a vendor, drive the assessment through the real workflow
 *    endpoints the page calls (finish planning, submit the questionnaire),
 *    and watch the status badge follow the instance — with NO status control
 *    anywhere on the page (the one rule, asserted structurally);
 *  - the attested-checklist card carries its honesty on its face: the
 *    "vendor-attested — not verified by this platform" framing is in the DOM,
 *    not in a doc.
 *
 * This spec WRITES (a vendor + its workflow instance), so it runs LAST
 * (zz- prefix, M-018) and creates only vnd-e2e-prefixed objects nothing
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

test("a vendor is proposed, assessed on the rails, and never offered a status control", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/vendors");
  await expect(page.getByRole("heading", { name: "Vendors", exact: true })).toBeVisible();
  // the page's framing states the attestation posture up front
  await expect(page.getByText(/never verified by this platform|not verified by this platform/).first()).toBeVisible();

  // propose
  await page.getByLabel("Vendor name").fill("vnd-e2e-transcribe");
  await page.getByLabel("Description — what of ours its AI touches").fill("call recordings reach the vendor's summarizer");
  await page.getByRole("button", { name: "Propose vendor" }).click();
  await expect(page.getByText("Vendor proposed — its assessment workflow is resting at the plan stage")).toBeVisible();

  // open the detail from the registry
  await page.getByRole("cell", { name: "vnd-e2e-transcribe", exact: true }).click();
  await expect(page.getByText("Vendor: vnd-e2e-transcribe")).toBeVisible();
  await expect(page.getByText("status follows the linked assessment workflow — it is decided, never edited here")).toBeVisible();

  // the ADR-0079 resting plan stage is real — leave it
  await page.getByRole("button", { name: "Finish planning" }).click();
  await expect(page.getByText("Planning finished — record the vendor's answers and submit the questionnaire")).toBeVisible();

  // the questionnaire card is honest about whose answers these are
  await expect(page.getByText(/Every answer below is the vendor's claim, recorded by you/)).toBeVisible();
  await page.getByRole("button", { name: "Submit questionnaire" }).click();
  await expect(page.getByText("Questionnaire submitted — the vendor is under assessment")).toBeVisible();

  // the badge followed the instance: under assessment, decided elsewhere
  await expect(page.getByText("under assessment").first()).toBeVisible();
  await expect(page.getByText(/Awaiting sign-off — the decision happens in the/)).toBeVisible();

  // the attested-checklist card is present and labelled
  await expect(
    page.getByText("Pack-control checklist — vendor-attested, not verified by this platform"),
  ).toBeVisible();

  // THE ONE RULE, structurally: no control on this page can write a status
  await expect(page.getByLabel(/status/i)).toHaveCount(0);
});
