/**
 * ADR-0090 in the real SPA (gap L22) — a grant certification campaign driven
 * end to end: an admin opens a campaign over one user's direct grants (scope
 * preview first), KEEPS one item and REVOKES the other through the page's
 * controls (which call the one approvals decide endpoint), and the revoked
 * grant is PROVABLY GONE — asserted against the gateway's own grant read,
 * not against a badge. The posture page then carries the campaigns line.
 *
 * File name sorts LAST in the suite on purpose (M-018: a new spec's name is
 * part of its blast radius) — this spec writes users, agents, grants and a
 * campaign into the shared seeded database, so it must run after every spec
 * that asserts global state.
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

test("a campaign is opened with a scope preview, one item kept, one revoked — and the revoked grant is really gone", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // --- seed via the bootstrap API: a holder with two agent grants ----------
  const holderRes = await page.request.post("/v1/users", {
    headers: BOOT,
    data: { email: "zz-cert-holder@example.com", displayName: "zz cert holder" },
  });
  expect(holderRes.status()).toBe(201);
  const holderId = (await holderRes.json()).id as string;

  const mkAgent = async (name: string) => {
    const r = await page.request.post("/v1/agents", {
      headers: BOOT,
      data: { name, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 },
    });
    expect(r.status()).toBe(201);
    return (await r.json()).id as string;
  };
  const agentKeep = await mkAgent("zz-cert-agent-keep");
  const agentRevoke = await mkAgent("zz-cert-agent-revoke");
  for (const agentId of [agentKeep, agentRevoke]) {
    const g = await page.request.post("/v1/grants/agents", { headers: BOOT, data: { userId: holderId, agentId } });
    expect(g.status()).toBe(201);
  }

  // --- open the campaign through the page, preview first -------------------
  await page.goto("/ui/admin/certification");
  await expect(page.getByRole("heading", { name: "Certification campaigns" })).toBeVisible();
  // the empty state states the never-run fact outright before any campaign
  await expect(page.getByText("No certification campaign has ever been run")).toBeVisible();

  await page.getByLabel("Campaign name").fill("zz-cert-campaign");
  await page.getByLabel("Scope").selectOption("user");
  await page.getByLabel("Grant holder").selectOption({ label: "zz cert holder" });
  await page.getByLabel("Due date").fill("2030-01-01T12:00");
  await page.getByRole("button", { name: "Preview scope" }).click();
  await expect(page.getByText("2 grant(s) would be snapshotted at open")).toBeVisible();
  await page.getByRole("button", { name: "Open campaign" }).click();

  // the campaign lists as open with 2 undecided items (clickable rows render
  // with a link role in this Table)
  const row = page.getByRole("link", { name: /zz-cert-campaign/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("open", { exact: true })).toBeVisible();
  await expect(row.getByText("2 undecided")).toBeVisible();
  await page.getByRole("cell", { name: "zz-cert-campaign", exact: true }).click();
  // Card titles render as plain text, not headings
  await expect(page.getByText("Campaign: zz-cert-campaign")).toBeVisible();

  // both agents are unowned, so both items routed to the opener (this admin):
  // the keep/revoke controls render for the signed-in reviewer
  const keepRow = page.getByRole("row", { name: /zz-cert-agent-keep/ });
  const revokeRow = page.getByRole("row", { name: /zz-cert-agent-revoke/ });
  await expect(keepRow.getByRole("button", { name: "Keep" })).toBeVisible();

  await keepRow.getByRole("button", { name: "Keep" }).click();
  await expect(keepRow.getByText("keep", { exact: true })).toBeVisible();

  await revokeRow.getByRole("button", { name: "Revoke" }).click();
  await expect(revokeRow.getByText("revoke", { exact: true })).toBeVisible();
  await expect(revokeRow.getByText("grant row removed")).toBeVisible();

  // --- the revoked grant is PROVABLY gone; the kept one survives -----------
  const access = await page.request.get(`/v1/users/${holderId}/agents`, { headers: BOOT });
  expect(access.status()).toBe(200);
  const grantedIds = ((await access.json()).agents as Array<{ agentId: string }>).map((a) => a.agentId);
  expect(grantedIds).not.toContain(agentRevoke);
  expect(grantedIds).toContain(agentKeep);

  // every item decided → the campaign reads completed
  await expect(page.getByRole("link", { name: /zz-cert-campaign/ }).getByText("completed")).toBeVisible();
});

test("the posture page carries the campaigns line", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  await page.goto("/ui/admin/posture");
  await expect(page.getByRole("heading", { name: "Posture", exact: true })).toBeVisible();
  await expect(page.getByText("Grant certification", { exact: true })).toBeVisible();
  // exactly the campaign the previous test ran — this spec is the only
  // writer of campaign rows in the suite
  await expect(page.getByText(/1 campaign\(s\): 0 open, 1 completed, 0 expired-incomplete/)).toBeVisible();
  // the honesty note survives to the DOM
  await expect(page.getByText(/nothing\s+auto-decides on expiry/)).toBeVisible();
});
