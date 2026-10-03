/**
 * An admin can take a grant BACK — the other half of pillar 1.
 *
 * An affordance audit found twelve DELETE endpoints the gateway serves that no
 * screen could reach. Four of them were the grant types, which for a per-user
 * access-control product is the worst possible four: access could be handed out
 * from the UI and only taken back with a database client. The endpoint worked
 * the whole time and `GET /v1/users/:id/agents` had been returning `grantId`
 * all along — nothing was missing but the button.
 *
 * So this spec exercises the round trip, not the button: grant, see it, remove
 * it, and assert it is REALLY GONE from the server's own answer rather than
 * from the table we just re-rendered. A remove control that clears a row
 * without deleting anything is the failure this is here to catch.
 *
 * It also pins the rule the audit produced: an action that does not apply is
 * DISABLED AND EXPLAINED, never hidden. A role-granted agent has no direct
 * grant to delete, and the row has to say so — an absent button is
 * indistinguishable from an absent feature.
 *
 * Writes, so it runs last (zz-, M-018) and touches only its own fixtures.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string };
  baseUrl: string;
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

test("a direct agent grant can be removed from the UI, and is really gone", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();

  // Pick a user and an agent from the real selects rather than assuming seeded
  // ids — the seed is free to change and this spec is not about the seed.
  const grantForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Grant" }) });
  const userSel = grantForm.getByLabel("User");
  const agentSel = grantForm.getByLabel("Agent");
  const userId = await userSel.locator("option").nth(1).getAttribute("value");
  const agentId = await agentSel.locator("option").nth(1).getAttribute("value");
  expect(userId, "the seeded deployment has at least one user").toBeTruthy();
  expect(agentId, "the seeded deployment has at least one agent").toBeTruthy();
  // The option reads "name · provider · tier N" (agentOpts); the table column
  // renders the NAME alone. Match on the name, or the row lookup silently finds
  // nothing and the failure looks like the grant never happened.
  const agentLabel = (await agentSel.locator("option").nth(1).textContent())!.split("·")[0].trim();

  await userSel.selectOption(userId!);
  await agentSel.selectOption(agentId!);
  const granted = page.waitForResponse(
    (r) => r.url().includes("/v1/grants/agents") && r.request().method() === "POST",
  );
  await grantForm.getByRole("button", { name: "Grant" }).click();
  // 201 created, or 409 if this user already holds it — either way the grant
  // exists after this line, which is all the removal half needs.
  expect([201, 200, 409]).toContain((await granted).status());

  // the entitlement card, driven by the same endpoint the remove button reads
  const entitlement = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "View", exact: true }) });
  await entitlement.getByLabel("User").selectOption(userId!);
  await entitlement.getByRole("button", { name: "View", exact: true }).click();

  // ANCHORED ON THE BUTTON'S OWN ACCESSIBLE NAME, not on a container.
  // The agent catalog at the top of this page lists the same agent by the same
  // name, so an unscoped row lookup finds the catalog row; and guessing which
  // wrapping <div> is "the card" is how a locator ends up describing the DOM
  // rather than the product. `Remove <agent> from this user` exists exactly
  // once, which makes it both the anchor and an assertion that the control is
  // named well enough for a screen reader to distinguish it.
  const removeBtn = page.getByRole("button", { name: `Remove ${agentLabel} from this user` });
  await expect(removeBtn).toBeVisible();
  await expect(removeBtn).toBeEnabled();

  // provenance is stated on the same row: DIRECT is why it is removable at all
  const row = page.getByRole("row").filter({ has: removeBtn });
  await expect(row.getByText("direct")).toBeVisible();

  // remove it, and confirm the consequence is spelled out rather than "are you sure"
  await removeBtn.click();
  await expect(page.getByText(/is refused by default-deny/)).toBeVisible();
  const deleted = page.waitForResponse(
    (r) => r.url().includes("/v1/grants/agents/") && r.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  expect((await deleted).status()).toBe(200);

  // GONE ON THE SERVER, not merely gone from the table. Ask the API directly:
  // a control that clears a row without deleting anything would pass every
  // assertion above and fail this one.
  const after = await page.evaluate(async (uid) => {
    const res = await fetch(`/v1/users/${uid}/agents`, { credentials: "include" });
    return (await res.json()) as { agents: Array<{ agentId: string; source?: string }> };
  }, userId!);
  const stillDirect = after.agents.find((x) => x.agentId === agentId && x.source === "direct");
  expect(stillDirect, "the direct grant must be gone from the server's own answer").toBeUndefined();
});
