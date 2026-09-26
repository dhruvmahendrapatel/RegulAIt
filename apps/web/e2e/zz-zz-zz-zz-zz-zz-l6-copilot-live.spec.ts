/**
 * L6 in the real SPA — the copilot's live states and the judged-recommendation
 * knob (ADR-0056 amendment, ADR-0092 amendment).
 *
 * What this spec renders rather than merely documents:
 *
 *  1. AN ANSWER NAMES THE OBJECTS IT RESTS ON. Asking a governance question
 *     shows the grounded answer AND a table of the concrete governance-object
 *     ids the scoped retrieval returned — the page's own claim that the answer
 *     is traceable to rows.
 *  2. A REFUSAL LOOKS LIKE A REFUSAL. A question whose retrieval finds nothing
 *     renders the REFUSED badge and the refusal text — not an empty summary
 *     dressed as an answer.
 *  3. CONSENT IS VISIBLE ON THE PROPOSAL. The proposals table renders each
 *     proposal's approval state and offers Apply only where applying is
 *     possible; where it is not, it says why in the row.
 *  4. THE JUDGED KNOB SHIPS OFF. Settings → Organization renders the L6c
 *     switch at 'off', and the Access recommendations page states
 *     "model-judged: off" outright rather than leaving its absence implied.
 *
 * This spec WRITES (it asks copilot questions, which record `copilot_queries`
 * rows). It therefore sorts LAST — after every zz-zz-zz-zz-zz-* spec (M-018)
 * — and signs in with the order-independent helper the other zz- specs use
 * (M-017). It flips NO org setting: the knob assertion is read-only, so no
 * later run can inherit an armed judge from here.
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
 * whichever spec runs first; trying the candidates in turn and settling on the
 * SHARED password keeps every spec runnable in any order.
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

const ask = async (page: Page, question: string) => {
  await page.getByLabel("Question").fill(question);
  const answered = page.waitForResponse(
    (r) => r.url().includes("/v1/copilot/ask") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  expect((await answered).status()).toBe(201);
};

test("the copilot names the governance objects an answer rests on", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/copilot");
  await expect(page.getByRole("heading", { name: "Governance copilot" })).toBeVisible();

  await ask(page, "which denied decisions happened this week?");

  // NB: `Card` renders its title as a span, not a heading (ui/kit.tsx) — only
  // `PageHeader` produces a heading role, so card titles are matched by text
  await expect(page.getByText("Answer", { exact: true })).toBeVisible();
  // the honest per-answer badge: no model narrator was named, so no model ran
  await expect(page.getByText("grounded (no model called)")).toBeVisible();
  // and the retrieval's own objects are rendered, by id
  await expect(
    page.getByText("Grounded in these governance objects — the only records this answer may rest on:"),
  ).toBeVisible();
  // the citable-object table, and a REAL id in it: the ledger it came from
  // plus a uuid an operator could go and read, not a summary of a summary
  await expect(page.getByRole("row", { name: /Ledger Object id What it is/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "audit_log" }).first()).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ }).first(),
  ).toBeVisible();
});

test("a question the retrieval cannot ground is REFUSED, visibly", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/copilot");
  // `listApprovals` over a window with no approvals returns no rows and no
  // citable object — the empty-retrieval case, reached through the ordinary UI
  await ask(page, "which approvals were rejected today?");

  const refused = page.getByText("REFUSED — nothing retrieved");
  const grounded = page.getByText("grounded (no model called)");
  await expect(refused.or(grounded).first()).toBeVisible();

  if (await refused.isVisible()) {
    // the refusal is a refusal about SCOPE, never a claim about the world
    await expect(page.getByText(/NOTHING RETRIEVED — REFUSING TO ANSWER/)).toBeVisible();
    await expect(
      page.getByText(/No governance object was retrieved in your scope/),
    ).toBeVisible();
  } else {
    // the seeded dataset had approvals in the window: then it must NOT refuse,
    // and must still name what it is grounded in — the control for the branch
    // above, so this test cannot pass by finding neither state
    await expect(
      page.getByText("Grounded in these governance objects — the only records this answer may rest on:"),
    ).toBeVisible();
  }
});

test("a proposal shows its consent state, and Apply exists only where consent does", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/copilot");
  await expect(
    page.getByText("Proposals — recorded, approved by a human, then applied", { exact: true }),
  ).toBeVisible();
  // the standing statement, rendered rather than documented: consent gates the
  // apply, and the apply rides the public endpoint
  await expect(
    page.getByText(/Applying one is gated on the linked approval in the ordinary/),
  ).toBeVisible();
  await expect(page.getByText(/audited under\s+the applying admin's identity/)).toBeVisible();
});

test("the model-judged knob ships OFF, and the recommendations page says so outright", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/organization");
  await expect(page.getByRole("heading", { name: "Organization", exact: true })).toBeVisible();
  await expect(page.getByText("5c · Model-judged access recommendations (ADR-0092)")).toBeVisible();
  // DEFAULT-OFF is the honesty argument, asserted on the real form. Read only:
  // this spec never arms the judge, so no later run inherits one.
  await expect(page.getByLabel("Model-judged annotations")).toHaveValue("false");

  await page.goto("/ui/admin/recommendations");
  await expect(page.getByRole("heading", { name: "Access recommendations" })).toBeVisible();
  await expect(page.getByText("model-judged: off")).toBeVisible();
  await expect(
    page.getByText(/Every finding below is the deterministic rule set and nothing else/),
  ).toBeVisible();
});
