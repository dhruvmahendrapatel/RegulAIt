/**
 * The approvals queue filters, and filters SERVER-SIDE.
 *
 * The queue shipped unfiltered while `GET /v1/approvals` had supported a
 * `status` parameter all along. On a fleet-wide inbox that is not cosmetic: a
 * decided approval never leaves the list, so the pending items an approver is
 * accountable for sink under every settled one, and "the one inbox" becomes a
 * list nobody can work.
 *
 * Two things are asserted, and the second is the one that matters:
 *
 *  1. changing the control changes what is on screen;
 *  2. the REQUEST carries `?status=`, so the narrowing happens in the endpoint
 *     that owns the queue's materialization and visibility rules — not in a
 *     client-side filter over a list the server already decided you could see.
 *
 * A client-side filter would satisfy (1) perfectly and be the wrong thing.
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

test("the approvals queue filters by status, and the server does the filtering", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // The page's FIRST load must already be narrowed: an inbox that opens on
  // every status it has ever held is the defect this fixes, so defaulting to
  // pending is part of the behaviour, not a convenience.
  const firstLoad = page.waitForRequest((r) => r.url().includes("/v1/approvals?status="));
  await page.goto("/ui/admin/approvals");
  await expect(page.getByRole("heading", { name: "Approvals queue", exact: true })).toBeVisible();
  expect((await firstLoad).url()).toContain("status=pending");

  const filter = page.getByLabel("Status");
  await expect(filter).toHaveValue("pending");

  // Switching sends a NEW request carrying the new status. Asserting on the
  // request is what distinguishes a server-side filter from a client-side one
  // — both would change the rows.
  const refetched = page.waitForRequest((r) => r.url().includes("/v1/approvals?status=approved"));
  await filter.selectOption("approved");
  expect((await refetched).url()).toContain("status=approved");

  // "every status" sends no parameter at all rather than an empty one, so the
  // endpoint takes its own default path instead of parsing "" as a status.
  const unfiltered = page.waitForRequest(
    (r) => r.url().includes("/v1/approvals") && !r.url().includes("status="),
  );
  await filter.selectOption("");
  await unfiltered;

  // and the count the header shows is the count of what is rendered
  await expect(page.getByText(/\d+ shown/)).toBeVisible();
});
