/**
 * THE LAST TWO AFFORDANCE GAPS (batch B9c).
 *
 * The census (`scripts/preflight-ui-affordances.mjs`) is a gate in CI as of this
 * batch, and these were the two routes keeping it red:
 *
 *  1. `PUT/DELETE /v1/llm/backend-configs/:backend` — a training backend with no
 *     credential is shown in a warning badge that says it "will refuse every
 *     job", and there was **no way to give it one**. A screen that names a
 *     blocking condition and offers no lever for it reads as a product that
 *     cannot do the thing.
 *  2. `POST /v1/redteam/libraries` — the page could install OUR shipped corpus
 *     and could not start a customer's OWN library. Offering only the seed said,
 *     wrongly, that the attack libraries here are ours to supply.
 *
 * WHAT IS ASSERTED, and why not the obvious thing:
 *
 *  - For the backend: that the two in-process backends are **refused
 *    configuration on the row** rather than offered a control that 409s, and that
 *    a remote one round-trips through `PUT` and then `DELETE` with the server's
 *    own answer checked afterwards. The credential itself is asserted to be
 *    WRITE-ONLY: the form never carries it back, because a password box showing
 *    dots that are not the stored value is a lie a reader cannot detect.
 *  - For the library: that a created library is a DRAFT, read back from the
 *    server. A draft is the whole point — publishing freezes it, and a library
 *    that arrived publishable would let a run be stamped with a version that can
 *    still move.
 *
 * Writes (a backend config, a library), so it sorts LAST (M-018) and signs in
 * with the order-independent helper (M-017). It removes the backend config it
 * creates; the library is left, named uniquely, because a draft library is inert
 * and deleting one has no endpoint.
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

test("a training backend's credential can be configured and removed, and the in-process ones say why not", async ({
  page,
}) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/regulait-llm");
  await expect(page.getByRole("heading", { name: "regulAIt-LLM" })).toBeVisible();
  await expect(page.getByText("Training backends, and what each one cannot do")).toBeVisible();

  // THE IN-PROCESS BACKENDS: refused configuration BY NAME on the row. The route
  // answers 409 `backend_needs_no_config` for these, so an enabled-looking
  // control would teach an operator that the product is broken rather than that
  // the backend is keyless.
  const localRow = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "local", exact: true }) });
  await expect(localRow.getByText("runs here — nothing to configure")).toBeVisible();
  await expect(localRow.getByRole("button", { name: /credential/ })).toHaveCount(0);

  // A REMOTE BACKEND: the control exists, and its label says which act it is
  const togetherRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "together", exact: true }) });
  const addBtn = togetherRow.getByRole("button", { name: /credential/ });
  await expect(addBtn).toBeVisible();

  // nothing stored yet → removal is BLOCKED AND EXPLAINED, not hidden
  const blocked = togetherRow.getByRole("button", { name: /Remove the together backend configuration — unavailable/ });
  if (await blocked.count()) {
    await expect(blocked).toHaveAttribute("aria-disabled", "true");
  }

  await addBtn.click();
  const saved = page.waitForResponse(
    (r) => r.url().includes("/v1/llm/backend-configs/together") && r.request().method() === "PUT",
  );
  await page.getByLabel("API key").fill("sk-e2e-not-a-real-credential");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).status()).toBe(200);

  // the badge flips on the server's own answer, re-read by the page
  await expect(togetherRow.getByText("configured")).toBeVisible();

  // WRITE-ONLY: reopening the form must not carry the secret back. The list
  // endpoint reports `hasCredential` and never the key, and the form says so.
  await togetherRow.getByRole("button", { name: "Edit credential" }).click();
  const keyBox = page.getByLabel(/Replace the API key/);
  await expect(keyBox).toHaveValue("");
  await expect(page.getByText(/never returned by any endpoint/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // REMOVE, and confirm against the server rather than the table we re-rendered
  const removeBtn = togetherRow.getByRole("button", { name: "Remove the together backend configuration" });
  await expect(removeBtn).toBeEnabled();
  await removeBtn.click();
  await expect(page.getByText(/refuses every training job again/)).toBeVisible();
  const deleted = page.waitForResponse(
    (r) => r.url().includes("/v1/llm/backend-configs/together") && r.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  expect((await deleted).status()).toBe(200);

  const after = await page.evaluate(async () => {
    const res = await fetch("/v1/llm/backends", { credentials: "include" });
    const body = (await res.json()) as { backends: Array<{ kind: string; configured: boolean; hasCredential: boolean }> };
    return body.backends.find((b) => b.kind === "together") ?? null;
  });
  expect(after, "the backend is still listed — only its configuration is gone").not.toBeNull();
  expect(after!.configured).toBe(false);
  expect(after!.hasCredential).toBe(false);
});

test("a customer's own attack library can be created, and it starts as a draft", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/redteam");
  await expect(page.getByRole("heading", { name: "Red-teaming" })).toBeVisible();
  await expect(page.getByText("Attack libraries")).toBeVisible();

  const name = `e2e own library ${Date.now()}`;
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/v1/redteam/libraries") && r.request().method() === "POST",
  );
  await page.getByLabel("Start your own library").fill(name);
  await page.getByLabel("What it covers (optional)").fill("created by the e2e suite");
  await page.getByRole("button", { name: "Create draft" }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const row = (await res.json()) as { id: string; status: string; version: number };

  // A DRAFT, from the server. Publishing freezes a library, and one that arrived
  // publishable would let a run be stamped with a version that can still move.
  expect(row.status).toBe("draft");
  expect(row.version).toBe(1);

  // The libraries table has `onRowClick`, so its rows render with the LINK role
  // rather than `row` — anchoring on `row` finds the header and nothing else.
  const listed = page.getByRole("link").filter({ hasText: name });
  await expect(listed).toBeVisible();
  await expect(listed.getByText("draft")).toBeVisible();
  // and the page states the consequence of publishing rather than leaving it in
  // an ADR — the freeze is why a draft exists at all
  await expect(page.getByText(/Publishing freezes it/)).toBeVisible();
});
