/**
 * Batch B2 in the real SPA — the access-review operations follow-ups:
 *
 *  - ADR-0091 amendment (B2c): an admin declares an N-WAY toxic set and a
 *    PATTERN rule ("any connector at readwrite") on the SoD page; the
 *    gateway refuses only the mint that would complete the FULL set (an
 *    N-1 subset mints freely — asserted against the gateway's own grant
 *    endpoints), and the pattern rule's refusal names the pattern.
 *  - ADR-0090 amendment (B2b): a campaign item's review is REASSIGNED
 *    through the page with a recorded reason; reassigning to the grant's
 *    HOLDER is refused by name, rendered verbatim.
 *
 * File name sorts LAST in the suite on purpose (M-018: a new spec's name is
 * part of its blast radius) — this spec writes users, agents, grants, SoD
 * rules and a campaign into the shared seeded database, so it must run
 * after every spec that asserts global state (including the zz-zz specs'
 * "exactly one campaign / one rule" posture lines).
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
    expect(i, `no candidate password worked for admin`).toBeLessThan(candidates.length - 1);
  }
  throw new Error("could not sign in as admin");
}

async function mkUser(page: Page, email: string, displayName: string) {
  const res = await page.request.post("/v1/users", { headers: BOOT, data: { email, displayName } });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}
async function mkAgent(page: Page, name: string) {
  const r = await page.request.post("/v1/agents", {
    headers: BOOT,
    data: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id as string;
}

test("an N-way set and a pattern rule declared on the page are enforced at the mint — full set refused, N-1 subset free", async ({
  page,
}) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // --- seed via the bootstrap API ------------------------------------------
  const holderId = await mkUser(page, "zzz-ops-holder@example.com", "zzz ops holder");
  const modeHolderId = await mkUser(page, "zzz-ops-mode-holder@example.com", "zzz ops mode holder");
  const agentA = await mkAgent(page, "zzz-ops-a");
  const agentB = await mkAgent(page, "zzz-ops-b");
  const agentC = await mkAgent(page, "zzz-ops-c");
  const agentQ = await mkAgent(page, "zzz-ops-q");
  const connector = await page.request.post("/v1/connectors", {
    headers: BOOT,
    data: { name: "zzz-ops-connector", kind: "data" },
  });
  expect(connector.status()).toBe(201);
  const connectorId = (await connector.json()).id as string;

  // --- declare the THREE-way set through the page --------------------------
  await page.goto("/ui/admin/sod");
  await expect(page.getByRole("heading", { name: "SoD rules" })).toBeVisible();
  await page.getByLabel("Rule name").fill("zzz-ops-three-way");
  await page.getByLabel("Reason (required)").fill("initiate, approve and reconcile must never share hands");
  await page.getByLabel("Side A kind").selectOption("agent");
  await page.getByLabel("Side A object").selectOption({ label: "zzz-ops-a · mock · tier 1" });
  await page.getByLabel("Side B kind").selectOption("agent");
  await page.getByLabel("Side B object").selectOption({ label: "zzz-ops-b · mock · tier 1" });
  await page.getByRole("button", { name: "Add another side" }).click();
  await page.getByLabel("Side C kind").selectOption("agent");
  await page.getByLabel("Side C object").selectOption({ label: "zzz-ops-c · mock · tier 1" });
  await page.getByRole("button", { name: "Create rule" }).click();

  const threeWayRow = page.getByRole("row", { name: /zzz-ops-three-way/ });
  await expect(threeWayRow).toBeVisible();
  // the rule row renders ALL THREE sides of the set
  await expect(threeWayRow.getByText(/agent 'zzz-ops-a'.*agent 'zzz-ops-b'.*agent 'zzz-ops-c'/)).toBeVisible();

  // --- the boundary, against the gateway's own mint endpoints --------------
  const g1 = await page.request.post("/v1/grants/agents", { headers: BOOT, data: { userId: holderId, agentId: agentA } });
  expect(g1.status()).toBe(201);
  // holding 1 of 3: the second side mints FREELY (any N-1 subset is fine)
  const g2 = await page.request.post("/v1/grants/agents", { headers: BOOT, data: { userId: holderId, agentId: agentB } });
  expect(g2.status()).toBe(201);
  // the COMPLETING mint is the refusal, and it says the boundary out loud
  const g3 = await page.request.post("/v1/grants/agents", { headers: BOOT, data: { userId: holderId, agentId: agentC } });
  expect(g3.status()).toBe(409);
  const refusal = await g3.json();
  expect(refusal.error).toBe("sod_conflict");
  expect(refusal.detail).toContain("all 3 capabilities toxic together");
  expect(refusal.detail).toContain("any 2 of them may be co-held");

  // --- declare the PATTERN rule through the page ---------------------------
  await page.getByLabel("Rule name").fill("zzz-ops-any-rw");
  await page.getByLabel("Reason (required)").fill("any write-mode connector plus the q agent bypasses maker-checker");
  await page.getByLabel("Side A kind").selectOption("connector");
  await page.getByLabel("Side A selector").selectOption("mode");
  await page.getByLabel("Side A pattern value").selectOption("readwrite");
  await page.getByLabel("Side B kind").selectOption("agent");
  await page.getByLabel("Side B object").selectOption({ label: "zzz-ops-q · mock · tier 1" });
  await page.getByRole("button", { name: "Create rule" }).click();
  const patternRow = page.getByRole("row", { name: /zzz-ops-any-rw/ });
  await expect(patternRow).toBeVisible();
  await expect(patternRow.getByText(/any connector \(readwrite\).*agent 'zzz-ops-q'/)).toBeVisible();

  // a readwrite connector holding on ANY connector completes the pair
  const cg = await page.request.post("/v1/grants/connectors", {
    headers: BOOT,
    data: { userId: modeHolderId, connectorId, mode: "readwrite" },
  });
  expect(cg.status()).toBe(201);
  const gq = await page.request.post("/v1/grants/agents", { headers: BOOT, data: { userId: modeHolderId, agentId: agentQ } });
  expect(gq.status()).toBe(409);
  const patternRefusal = await gq.json();
  expect(patternRefusal.ruleName).toBe("zzz-ops-any-rw");
  expect(patternRefusal.conflict.existingHolding).toContain("zzz-ops-connector");
});

test("a campaign review is reassigned through the page — and NEVER to the grant's holder, refused verbatim", async ({
  page,
}) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // --- seed: a holder with one agent grant, and the reassignment target ----
  const holderId = await mkUser(page, "zzz-ops-cert-holder@example.com", "zzz ops cert holder");
  await mkUser(page, "zzz-ops-reviewer@example.com", "zzz ops reviewer");
  const agentId = await mkAgent(page, "zzz-ops-cert-agent");
  const g = await page.request.post("/v1/grants/agents", { headers: BOOT, data: { userId: holderId, agentId } });
  expect(g.status()).toBe(201);

  // --- open the campaign through the page ----------------------------------
  await page.goto("/ui/admin/certification");
  await expect(page.getByRole("heading", { name: "Certification campaigns" })).toBeVisible();
  await page.getByLabel("Campaign name").fill("zzz-ops-campaign");
  await page.getByLabel("Scope").selectOption("user");
  await page.getByLabel("Grant holder").selectOption({ label: "zzz ops cert holder" });
  await page.getByLabel("Due date").fill("2030-01-01T12:00");
  await page.getByRole("button", { name: "Open campaign" }).click();
  await page.getByRole("cell", { name: "zzz-ops-campaign", exact: true }).click();
  await expect(page.getByText("Campaign: zzz-ops-campaign")).toBeVisible();

  // --- the HOLDER bar, rendered verbatim -----------------------------------
  await page.getByLabel("Item to reassign").selectOption({ index: 1 });
  await page.getByLabel("New reviewer").selectOption({ label: "zzz ops cert holder" });
  await page.getByLabel("Reassignment reason").fill("override: routing it to the holder to unblock the queue");
  await page.getByRole("button", { name: "Reassign review" }).click();
  const barAlert = page.getByRole("alert");
  await expect(barAlert).toContainText("cannot_reassign_to_holder");
  await expect(barAlert).toContainText("self-certification");
  // nothing moved: the item row still names the opener as reviewer
  const itemRow = page.getByRole("row", { name: /zzz-ops-cert-agent/ });
  await expect(itemRow.getByText("you")).toBeVisible();

  // --- a legitimate reassignment moves the review --------------------------
  await page.getByLabel("Item to reassign").selectOption({ index: 1 });
  await page.getByLabel("New reviewer").selectOption({ label: "zzz ops reviewer" });
  await page.getByLabel("Reassignment reason").fill("original reviewer is on leave this quarter");
  await page.getByRole("button", { name: "Reassign review" }).click();
  await expect(itemRow.getByText("zzz ops reviewer")).toBeVisible();
  // the decision controls belong to the NEW reviewer now — the signed-in
  // admin (no longer the named reviewer) sees the awaiting state, not a
  // Keep/Revoke button
  await expect(itemRow.getByText("awaiting its named reviewer")).toBeVisible();
  await expect(itemRow.getByRole("button", { name: "Keep" })).toHaveCount(0);
});
