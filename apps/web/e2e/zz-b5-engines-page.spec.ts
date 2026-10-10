/**
 * ADR-0187 X26 in the real SPA against a REAL gateway. On a real install no
 * engine image is built yet (the shipped manifest has no digest), so the page
 * must say exactly that and the gateway's refusals must reach the screen:
 *
 *  - every engine reads "Off — not built", none as healthy;
 *  - enabling one is refused by the gateway (no passing self-test) and the
 *    refusal is shown in that engine's card;
 *  - the self-test is refused (no runner of the current build) and nothing
 *    changes;
 *  - an enrolment token is minted through the real route and shown once.
 *
 * It writes only an enrolment token (expires in minutes, nothing reads it), so
 * it runs LAST (zz- prefix, M-018). Sign-in is the order-independent helper
 * (M-017).
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

test("the Engines page states an unbuilt install honestly and shows the gateway's refusals", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  await page.goto("/ui/admin/engines");
  await expect(page.getByRole("heading", { name: "Engines", level: 1 })).toBeVisible();

  for (const id of ["promptfoo", "modelscan", "garak"]) {
    const card = page.getByTestId(`engine-${id}`);
    await expect(card.getByText("Off — not built")).toBeVisible();
    await expect(card.getByText("none (not built)")).toBeVisible();
  }
  await expect(page.getByText(/^On — /)).toHaveCount(0);

  const pf = page.getByTestId("engine-promptfoo");
  await pf.getByRole("button", { name: "Enable…" }).click();
  await page.getByRole("dialog", { name: "Enable promptfoo?" }).getByRole("button", { name: "Enable" }).click();
  await expect(pf.getByRole("alert")).toContainText("no passing runner self-test is recorded");

  await pf.getByRole("button", { name: "Run self-test…" }).click();
  await page.getByRole("dialog", { name: "Run promptfoo's self-test?" }).getByRole("button", { name: "Run self-test" }).click();
  await expect(pf.getByRole("alert")).toContainText("no live runner is registered for the current build");
  await expect(pf.getByText("Off — not built")).toBeVisible();

  await pf.getByRole("button", { name: "Mint enrolment token…" }).click();
  const dialog = page.getByRole("dialog", { name: "Mint an enrolment token for promptfoo" });
  await dialog.getByLabel("Valid for (minutes)").fill("5");
  await dialog.getByRole("button", { name: "Mint token" }).click();
  const secret = page.getByTestId("revealed-secret");
  await expect(secret).toHaveText(/^rgee_/);
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(secret).toHaveCount(0);
});
