/**
 * THE COPILOT'S PROPOSE HALF, IN THE REAL SPA (batch B9a).
 *
 * The copilot's only route to a change is a proposal that opens an ordinary
 * Approvals-Queue item. The page could LIST proposals and APPLY approved ones,
 * but there was no form — so the product's single most governed write was the
 * one an admin could not reach without curl, and the diff shapes the applier
 * accepts were documented nowhere a user could see them.
 *
 * WHAT THIS SPEC PINS, and why each assertion is not the obvious one:
 *
 *  1. THE FORM REFUSES TO EXIST WITHOUT EVIDENCE. Before a question is asked
 *     there is no diff builder — only the sentence saying a proposal must rest
 *     on the proposer's own recorded query. That is the gateway's own rule
 *     (`proposal_evidence_not_yours`) rendered rather than merely enforced.
 *  2. THE TARGET IS CHOSEN, NEVER TYPED. The grant to revoke comes out of that
 *     user's own entitlement list, carrying its real grant id — so the most
 *     likely cause of a refused proposal (a retyped uuid) has no text box to
 *     happen in.
 *  3. WHAT THE PROPOSER SEES IS WHAT IS STORED. The previewed JSON is compared
 *     BYTE-FOR-BYTE against the diff the server recorded, read back from
 *     `GET /v1/copilot/proposals`. A preview that drifts from the payload would
 *     be worse than no preview: a named human would approve one thing having
 *     read another.
 *  4. CONSENT IS STILL THE GATE. The new row lands 'pending' with no Apply
 *     control, and the row says why. Adding a create path must not have added
 *     a way around the approval.
 *
 * Writes (a grant, a copilot query, a proposal and an approval), so it sorts
 * LAST (M-018) and signs in with the order-independent helper (M-017).
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

test("the propose form builds an applicable diff, shows it, and still bows to consent", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // ---- a fixture grant to propose the revocation OF -----------------------
  // Made through the real UI rather than seeded, so the grant id in the diff is
  // one the server issued and the option list really contains.
  await page.goto("/ui/admin/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  const grantForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Grant" }) });
  const userId = await grantForm.getByLabel("User").locator("option").nth(1).getAttribute("value");
  const agentOption = grantForm.getByLabel("Agent").locator("option").nth(1);
  const agentId = await agentOption.getAttribute("value");
  const agentName = (await agentOption.textContent())!.split("·")[0].trim();
  expect(userId, "the seeded deployment has at least one user").toBeTruthy();
  expect(agentId, "the seeded deployment has at least one agent").toBeTruthy();
  await grantForm.getByLabel("User").selectOption(userId!);
  await grantForm.getByLabel("Agent").selectOption(agentId!);
  const granted = page.waitForResponse(
    (r) => r.url().includes("/v1/grants/agents") && r.request().method() === "POST",
  );
  await grantForm.getByRole("button", { name: "Grant" }).click();
  // 201, or 409 if this user already holds it — either way it exists after this
  expect([200, 201, 409]).toContain((await granted).status());

  await page.goto("/ui/admin/copilot");
  await expect(page.getByRole("heading", { name: "Governance copilot" })).toBeVisible();

  // ---- (1) NO EVIDENCE, NO FORM ------------------------------------------
  await expect(
    page.getByText(/A proposal must rest on a recorded query of your own/),
  ).toBeVisible();
  await expect(page.getByLabel("What kind of change")).toHaveCount(0);

  // ---- ask, and the builder appears --------------------------------------
  await page.getByLabel("Question").fill("which grants are unused?");
  const answered = page.waitForResponse(
    (r) => r.url().includes("/v1/copilot/ask") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  expect((await answered).status()).toBe(201);

  const kindSel = page.getByLabel("What kind of change");
  await expect(kindSel).toBeVisible();
  // the honest framing, on the form itself: proposing applies nothing, and the
  // apply would ride a named public endpoint under the approver's identity
  await expect(page.getByText(/Nothing is applied by proposing/)).toBeVisible();

  // ---- (2) THE TARGET IS CHOSEN FROM THE REAL OBJECT ---------------------
  await kindSel.selectOption("grant_revocation");
  await page.getByLabel("Grant kind").selectOption("agent");
  await page.getByLabel("Holder").selectOption(userId!);

  const grantSel = page.getByLabel("Grant to revoke");
  const grantOption = grantSel.locator("option").filter({ hasText: agentName });
  await expect(grantOption.first()).toBeAttached();
  const grantIdValue = await grantOption.first().getAttribute("value");
  expect(grantIdValue, "the option carries the server's own grant id").toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  await grantSel.selectOption(grantIdValue!);

  // ---- the diff, rendered before it is sent ------------------------------
  const preview = page.locator("pre").filter({ hasText: "grantKind" }).first();
  await expect(preview).toBeVisible();
  const previewed = JSON.parse((await preview.textContent())!) as Record<string, unknown>;
  expect(previewed).toEqual({ grantKind: "agent", grantId: grantIdValue });

  // ---- submit ------------------------------------------------------------
  const title = `e2e propose ${Date.now()}`;
  await page.getByLabel("Title — what the approver sees first").fill(title);
  await page.getByLabel("Rationale — the evidence, in your own words").fill(
    "Recorded by the e2e suite: this grant exists only to prove the propose path composes an applicable diff.",
  );
  // the approver is a real user, chosen from the list — a proposal with no
  // named human to ask is not a proposal
  const approverSel = page.getByLabel("Approver", { exact: true });
  const approverId = await approverSel.locator("option").nth(1).getAttribute("value");
  await approverSel.selectOption(approverId!);

  const proposed = page.waitForResponse(
    (r) => r.url().endsWith("/v1/copilot/proposals") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Record proposal and open an approval" }).click();
  const proposeRes = await proposed;
  expect(proposeRes.status(), await proposeRes.text()).toBe(201);
  const created = (await proposeRes.json()) as { proposal: { id: string }; approvalId: string };
  expect(created.approvalId, "an ordinary Approvals-Queue item was opened").toBeTruthy();

  // ---- (3) WHAT WAS PREVIEWED IS WHAT WAS STORED -------------------------
  // Read back from the server's own list, not from the page that just posted
  // it. A preview that drifts from the payload is worse than no preview: a
  // named human would approve one thing having read another.
  const stored = await page.evaluate(async (id) => {
    const res = await fetch("/v1/copilot/proposals", { credentials: "include" });
    const body = (await res.json()) as {
      proposals: Array<{ id: string; kind: string; diff: Record<string, unknown>; appliedAt: string | null }>;
    };
    return body.proposals.find((p) => p.id === id) ?? null;
  }, created.proposal.id);
  expect(stored, "the proposal is in the server's own list").not.toBeNull();
  expect(stored!.kind).toBe("grant_revocation");
  expect(stored!.diff).toEqual(previewed);
  expect(stored!.appliedAt, "proposing applies nothing").toBeNull();

  // ---- (4) CONSENT IS STILL THE GATE -------------------------------------
  const row = page.getByRole("row").filter({ hasText: title });
  await expect(row).toBeVisible();
  // `exact` because the same row also carries the sentence "cannot apply: the
  // linked approval is pending" — the consent BADGE and the consent REASON are
  // two separate assertions and a substring match conflates them
  await expect(row.getByText("pending", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Apply" })).toHaveCount(0);
  await expect(row.getByText(/cannot apply: the linked approval is pending/)).toBeVisible();
});

test("a proposal with nothing in its diff cannot be submitted", async ({ page }) => {
  // The gateway refuses an empty or malformed diff at 422 BEFORE opening any
  // approval (B9a). The form's job is to make that refusal unreachable rather
  // than to let a user earn it — so the state is rendered as an incomplete
  // diff with the submit control disabled, and the reason is stated.
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/copilot");
  await page.getByLabel("Question").fill("which denied decisions happened this week?");
  const answered = page.waitForResponse(
    (r) => r.url().includes("/v1/copilot/ask") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  expect((await answered).status()).toBe(201);

  // a kind whose diff needs BOTH a target and at least one changed field, with
  // neither supplied yet
  await page.getByLabel("What kind of change").selectOption("policy_tightening");
  await expect(page.getByText("incomplete")).toBeVisible();
  await expect(
    page.getByText(/an approval on the record against a change that does nothing is worse/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Record proposal and open an approval" })).toBeDisabled();
});
