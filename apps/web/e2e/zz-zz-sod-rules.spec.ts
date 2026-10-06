/**
 * ADR-0091 in the real SPA (gap L23) — toxic-combination SoD driven end to
 * end: an admin declares two agents toxic together on the SoD rules page,
 * the second grant is REFUSED BY NAME in the real grant form (the gateway's
 * own sentence, verbatim), the refusal is escalated to the one approvals
 * queue, an ARM'S-LENGTH approver signs it, and the grant then exists —
 * asserted against the gateway's own grant read, not against a badge. The
 * posture page then carries the SoD line with the violation the override
 * created.
 *
 * File name sorts LAST in the suite on purpose (M-018: a new spec's name is
 * part of its blast radius) — this spec writes users, agents, grants, an SoD
 * rule and an approvals row into the shared seeded database, so it must run
 * after every spec that asserts global state.
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

/** the password every admin spec in this suite settles on */
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
const APPROVER_PASSWORD = "E2e-Sod-Approver-1!";
const BOOT = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };

/**
 * Order-independent sign-in, copied from the phase4-7 / zz- specs (M-017).
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
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

let holderId: string;

test("declare a rule, get refused at the real grant form, escalate, arm's-length approve — and the grant exists with the override recorded", async ({
  page,
}) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // --- seed via the bootstrap API: a holder, two agents, one grant ---------
  const holderRes = await page.request.post("/v1/users", {
    headers: BOOT,
    data: { email: "zz-sod-holder@example.com", displayName: "zz sod holder" },
  });
  expect(holderRes.status()).toBe(201);
  holderId = (await holderRes.json()).id as string;

  const mkAgent = async (name: string) => {
    const r = await page.request.post("/v1/agents", {
      headers: BOOT,
      data: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).id as string;
  };
  const agentPay = await mkAgent("zz-sod-pay");
  const agentVendor = await mkAgent("zz-sod-vendor");
  const g = await page.request.post("/v1/grants/agents", {
    headers: BOOT,
    data: { userId: holderId, agentId: agentPay },
  });
  expect(g.status()).toBe(201);

  // an arm's-length approver: a SECOND admin with a real password
  const approverRes = await page.request.post("/v1/users", {
    headers: BOOT,
    data: { email: "zz-sod-approver@example.com", displayName: "zz sod approver" },
  });
  expect(approverRes.status()).toBe(201);
  const approverId = (await approverRes.json()).id as string;
  const adminFlip = await page.request.post(`/v1/users/${approverId}/admin`, {
    headers: BOOT,
    data: { isAdmin: true, reason: "zz sod e2e approver" },
  });
  expect(adminFlip.status()).toBe(200);
  const otp = await page.request.post(`/v1/users/${approverId}/set-initial-password`, { headers: BOOT, data: {} });
  expect(otp.status()).toBe(200);
  const approverOtp = (await otp.json()).password as string;

  // --- declare the toxic combination through the page ----------------------
  await page.goto("/ui/admin/sod");
  await expect(page.getByRole("heading", { name: "SoD rules" })).toBeVisible();
  // the empty state states the none-defined fact outright before any rule
  await expect(page.getByText("No SoD rule is defined", { exact: true })).toBeVisible();

  await page.getByLabel("Rule name").fill("zz-sod-rule");
  await page.getByLabel("Reason (required)").fill("payment plus vendor-master enables invoice fraud");
  await page.getByLabel("Side A kind").selectOption("agent");
  await page.getByLabel("Side A object").selectOption({ label: "zz-sod-pay · mock · tier 1" });
  await page.getByLabel("Side B kind").selectOption("agent");
  await page.getByLabel("Side B object").selectOption({ label: "zz-sod-vendor · mock · tier 1" });
  await page.getByRole("button", { name: "Create rule" }).click();

  const ruleRow = page.getByRole("row", { name: /zz-sod-rule/ });
  await expect(ruleRow).toBeVisible();
  await expect(ruleRow.getByText("enabled", { exact: true })).toBeVisible();
  await expect(ruleRow.getByText("none", { exact: true })).toBeVisible(); // no violators yet

  // --- the REAL grant form refuses, verbatim -------------------------------
  await page.goto("/ui/admin/agents");
  const grantCard = page.locator("section").filter({ hasText: "Grant an agent" });
  await grantCard.getByLabel("User").selectOption({ label: "zz sod holder · zz-sod-holder@example.com" });
  await grantCard.getByLabel("Agent").selectOption({ label: "zz-sod-vendor · mock · tier 1" });
  await grantCard.getByRole("button", { name: "Grant" }).click();
  // the gateway's own sentence — rule name, reason and existing holding
  const refusal = grantCard.getByRole("alert");
  await expect(refusal).toContainText("sod_conflict");
  await expect(refusal).toContainText("SoD rule 'zz-sod-rule' refuses this");
  await expect(refusal).toContainText("agent 'zz-sod-pay'");
  // and no row was minted
  const afterRefusal = await page.request.get(`/v1/users/${holderId}/agents`, { headers: BOOT });
  const heldAfterRefusal = ((await afterRefusal.json()).agents as Array<{ agentId: string }>).map((a) => a.agentId);
  expect(heldAfterRefusal).not.toContain(agentVendor);

  // --- escalate through the SoD page ---------------------------------------
  await page.goto("/ui/admin/sod");
  await page.getByLabel("Mint kind").selectOption("agent");
  await page.getByLabel("Grant holder").selectOption({ label: "zz sod holder · zz-sod-holder@example.com" });
  await page.getByLabel("Granted object").selectOption({ label: "zz-sod-vendor · mock · tier 1" });
  await page
    .getByLabel("Arm's-length approver")
    .selectOption({ label: "zz sod approver · zz-sod-approver@example.com" });
  await page.getByLabel("Justification").fill("quarter-end close needs one operator on both sides");
  await page.getByRole("button", { name: "Escalate" }).click();
  const overrideRow = page.getByRole("row", { name: /SoD override · zz sod holder/ });
  await expect(overrideRow).toBeVisible();
  await expect(overrideRow.getByText("pending", { exact: true })).toBeVisible();

  // --- the arm's-length approver signs it in the one approvals queue -------
  // (drop the admin's session first — two sign-ins share this test's context)
  await page.context().clearCookies();
  await signIn(page, "zz-sod-approver@example.com", [approverOtp], APPROVER_PASSWORD);
  await page.goto("/ui/admin/approvals");
  const queueRow = page.getByRole("row", { name: /SoD override · zz sod holder/ });
  await expect(queueRow).toBeVisible();
  await queueRow.getByRole("button", { name: "approve" }).click();
  // the queue list's query key is outside the admin invalidation prefix, so
  // re-load the page to read the decided row rather than a stale cache
  await expect(page.getByText("Decision recorded")).toBeVisible();
  await page.reload();
  // The queue now opens on PENDING — a fleet-wide inbox that shows every status
  // it has ever held is unworkable. A decided row is still there, one filter
  // change away, which is exactly the move a real approver makes to confirm
  // their own decision landed.
  await page.getByLabel("Status").selectOption("approved");
  await expect(queueRow.getByText("approved", { exact: true })).toBeVisible();

  // --- the grant EXISTS now, minted with the override recorded -------------
  const access = await page.request.get(`/v1/users/${holderId}/agents`, { headers: BOOT });
  expect(access.status()).toBe(200);
  const held = ((await access.json()).agents as Array<{ agentId: string }>).map((a) => a.agentId);
  expect(held).toContain(agentVendor);
  expect(held).toContain(agentPay);

  // the override request reads approved on the SoD page (the approver is an
  // admin too, so the page is reachable in this same session)
  await page.goto("/ui/admin/sod");
  const decided = page.getByRole("row", { name: /SoD override · zz sod holder/ });
  await expect(decided.getByText("approved", { exact: true })).toBeVisible();
  await expect(decided.getByText(/with the rule recorded as overridden/)).toBeVisible();
});

test("the posture page carries the SoD line — including the violation the override created", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  await page.goto("/ui/admin/posture");
  await expect(page.getByRole("heading", { name: "Posture", exact: true })).toBeVisible();
  await expect(page.getByText("Separation of duties", { exact: true })).toBeVisible();
  // exactly the rule the previous test created — this spec is the only
  // writer of sod_rules rows in the suite; the approved override left its
  // holder as a live (surfaced, never auto-revoked) violation
  await expect(page.getByText(/1 SoD rule\(s\), 1 enabled — 1 current\s+violation\(s\)\./)).toBeVisible();
  // the honesty note survives to the DOM
  await expect(page.getByText(/never auto-revoked/).first()).toBeVisible();
});
