/**
 * A REFUSED ACTION EXPLAINS ITSELF TO EVERYONE, not just to a mouse.
 *
 * `<RemoveButton/>` states why a destructive action is unavailable — a grant
 * that came from a role, an initiative with projects still rolling up to it.
 * The first version carried that reason in `title` on a `disabled` button, and
 * a disabled button is NOT FOCUSABLE: the explanation was reachable by hover
 * and by nothing else. Keyboard users could not tab to it, screen readers did
 * not announce it, and on touch it did not exist. The rule was "an action that
 * does not apply is disabled and explained, never hidden" — and for those users
 * it was, in fact, hidden.
 *
 * So a blocked action is `aria-disabled` (in the tab order, announced, still
 * inert) with the reason in a real focusable disclosure beside it. This spec
 * reaches that reason USING THE KEYBOARD ONLY, because that is the claim.
 *
 * Read-only: the seeded demo project already rolls up to an initiative, so a
 * naturally blocked row exists without this spec creating one.
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

test("a blocked remove is focusable and its reason is reachable by keyboard", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  await page.goto("/ui/admin/cost");
  await expect(page.getByRole("heading", { name: "Cost dashboard", exact: true })).toBeVisible();

  // the seeded initiative that a project rolls up to — its removal is refused
  const blocked = page.getByRole("button", { name: /Remove .* — unavailable/ }).first();
  await expect(blocked).toBeVisible();

  // aria-disabled, NOT disabled: a disabled button cannot be focused, and an
  // explanation on an unfocusable control is an explanation nobody can reach.
  await expect(blocked).toHaveAttribute("aria-disabled", "true");
  // NOT the `disabled` ATTRIBUTE — that is the one that removes the element
  // from the tab order. (Playwright's toBeDisabled() honours aria-disabled too,
  // so asserting on the DOM property is what actually distinguishes the two.)
  await expect(blocked).toHaveJSProperty("disabled", false);
  await blocked.focus();
  await expect(blocked).toBeFocused();

  // TAB to the reason and open it with the keyboard — no mouse anywhere.
  await page.keyboard.press("Tab");
  const why = page.getByRole("button", { name: /^What is the reason .* cannot be removed here\?$/ });
  await expect(why).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("note")).toBeVisible();
  await expect(page.getByRole("note")).toContainText(/project/i);

  // Escape closes it and returns focus, so the keyboard user is not stranded.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(why).toBeFocused();
});
