/**
 * THE APPROVALS QUEUE'S THREE FILTERS AND ITS SAVED VIEWS (batch B9b).
 *
 * `GET/POST/DELETE /v1/approvals/views` shipped with ADR-0046 and **nothing in
 * the portal ever called them** — the affordance census caught it from the
 * DELETE side. And the queue itself narrowed on one dimension while returning at
 * most 100 rows, so "the copilot proposals waiting on me" was not a question the
 * screen could ask: on a busy deployment the rows wanted may not be in the
 * response at all.
 *
 * WHAT THIS SPEC PINS, and why each is the assertion that matters:
 *
 *  1. THE NARROWING HAPPENS IN THE ENDPOINT. Each new control is asserted by the
 *     REQUEST it produces (`?objectType=`, `?approverUserId=`), not by what is on
 *     screen. A client-side filter would satisfy a visual check perfectly and be
 *     the wrong thing — the queue's materialization and visibility rules run
 *     inside that handler, so filtering afterwards filters a list the server
 *     already decided you could see, one capped page at a time. (Same argument
 *     as the `status` filter's own spec.)
 *  2. A SAVED VIEW ROUND-TRIPS THROUGH THE SERVER. Saved, then re-read from
 *     `GET /v1/approvals/views`, and its stored `filters` asserted to be exactly
 *     the three parameters the queue endpoint applies — a view carrying a filter
 *     the endpoint cannot apply would silently do less than its name promises.
 *     Applying it restores all three controls, INCLUDING the one the view did
 *     not store, which must be cleared rather than left as it was.
 *  3. IT CAN BE DELETED, AND IS REALLY GONE. The census entry was the DELETE
 *     route; the assertion is the server's own answer afterwards, not the table
 *     we just re-rendered.
 *
 * Writes (a saved view), so it sorts LAST (M-018) and signs in with the
 * order-independent helper (M-017). It deletes what it creates.
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

/**
 * The queue request the page issues, captured so the narrowing is asserted on
 * the URL rather than on the rendered list.
 *
 * `must` is required rather than optional: the SHELL fetches bare
 * `/v1/approvals` for its nav badge (`AppShell.tsx`), and react-query refetches
 * it whenever anything invalidates — so a predicate that accepted any
 * `/v1/approvals` request caught the badge's refetch instead of the queue's, and
 * the first draft of this spec failed with a bare URL while the page was in
 * exactly the right state. Naming the parameter that must be present makes the
 * waiter pick out the request under test.
 */
const queueRequest = (page: Page, must: string) =>
  page.waitForRequest((r) => r.url().includes("/v1/approvals?") && r.url().includes(must));

test("the queue narrows by kind and approver, and the endpoint does the narrowing", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/approvals");
  await expect(page.getByRole("heading", { name: "Approvals queue" })).toBeVisible();

  // KIND — a select an approver can read, not a bare column value
  const byKind = queueRequest(page, "objectType=copilot_proposal");
  await page.getByLabel("Kind").selectOption("copilot_proposal");
  expect((await byKind).url()).toContain("objectType=copilot_proposal");

  // APPROVER — and the request carries the id, so a non-admin asking for
  // somebody else's id gets nothing rather than their queue (asserted in the
  // gateway suite, where the scope condition can be probed directly)
  const approverSel = page.getByLabel("Approver", { exact: true });
  const someoneId = await approverSel.locator("option").nth(1).getAttribute("value");
  expect(someoneId).toBeTruthy();
  const byApprover = queueRequest(page, `approverUserId=${someoneId}`);
  await approverSel.selectOption(someoneId!);
  const url = (await byApprover).url();
  expect(url).toContain(`approverUserId=${someoneId}`);
  // and it did not drop the filters already set — a filter that replaces the
  // others is how a queue quietly shows the wrong slice
  expect(url).toContain("objectType=copilot_proposal");
  expect(url).toContain("status=pending");
});

test("a saved view round-trips through the server, restores every filter on apply, and can be deleted", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/approvals");
  await expect(page.getByText("Saved views", { exact: true })).toBeVisible();

  // set a distinctive slice, then save it
  await page.getByLabel("Kind").selectOption("copilot_proposal");
  await page.getByLabel("Status").selectOption("approved");

  const name = `e2e view ${Date.now()}`;
  await page.getByLabel("Name this view").fill(name);
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/v1/approvals/views") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save current filters" }).click();
  const savedRes = await saved;
  expect(savedRes.status(), await savedRes.text()).toBe(201);

  // (2) THE SERVER'S OWN ANSWER, not the page that just posted it. The stored
  // filters must be exactly the parameters the queue endpoint applies — a view
  // carrying a filter the endpoint cannot apply would silently do less than the
  // name promises.
  const stored = await page.evaluate(async (viewName) => {
    const res = await fetch("/v1/approvals/views", { credentials: "include" });
    const body = (await res.json()) as {
      views: Array<{ id: string; name: string; filters: Record<string, unknown>; shared: boolean }>;
    };
    return body.views.find((v) => v.name === viewName) ?? null;
  }, name);
  expect(stored, "the view is in the server's own list").not.toBeNull();
  expect(stored!.filters).toEqual({ status: "approved", objectType: "copilot_proposal" });
  expect(stored!.shared, "saved privately unless 'share with everyone' was ticked").toBe(false);

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText("private to you")).toBeVisible();

  // move the filters away, then APPLY the view and assert all three controls
  // come back to the stored values — including `Approver`, which the view did
  // NOT store and which must therefore be cleared rather than left as it was.
  //
  // This asserts the CONTROLS rather than a network request on purpose. The
  // query is keyed on the three filters, so applying a combination the session
  // has already fetched is served from cache and issues no request at all —
  // correct behaviour, and an assertion that demanded a refetch would be
  // asserting an implementation detail that happens to be false. That the
  // narrowing itself is server-side is established by the first test in this
  // file, on a request whose parameters are read off the URL.
  await page.getByLabel("Status").selectOption("pending");
  await page.getByLabel("Kind").selectOption("");
  const approverSel = page.getByLabel("Approver", { exact: true });
  const someone = await approverSel.locator("option").nth(1).getAttribute("value");
  await approverSel.selectOption(someone!);

  await row.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("approved");
  await expect(page.getByLabel("Kind")).toHaveValue("copilot_proposal");
  await expect(approverSel).toHaveValue("");

  // (3) DELETED, AND REALLY GONE
  const removeBtn = row.getByRole("button", { name: `Remove the view ${name}` });
  await expect(removeBtn).toBeVisible();
  await removeBtn.click();
  // the consequence is spelled out rather than "are you sure" — and it says
  // what a view is NOT, because deleting something in a governance product
  // should never leave a reader wondering whether a permission went with it
  await expect(page.getByText(/a view is a saved filter, not a permission/)).toBeVisible();
  const deleted = page.waitForResponse(
    (r) => r.url().includes("/v1/approvals/views/") && r.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  expect((await deleted).status()).toBe(200);

  const after = await page.evaluate(async (viewName) => {
    const res = await fetch("/v1/approvals/views", { credentials: "include" });
    const body = (await res.json()) as { views: Array<{ name: string }> };
    return body.views.some((v) => v.name === viewName);
  }, name);
  expect(after, "gone from the server's own answer, not merely from the table").toBe(false);
});
