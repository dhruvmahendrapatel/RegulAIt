/**
 * ADR-0092 in the real SPA (gap L24) — access recommendations driven end to
 * end: an unused grant (backdated in the ledger, zero governed use) and an
 * orphaned one (owner deactivated) RENDER with their evidence and severity
 * badges, then "open certification campaign from these" feeds the ADR-0090
 * loop — and the campaign's items are asserted to MATCH the flagged set
 * against the gateway's own APIs, not against a badge.
 *
 * File name sorts LAST in the suite on purpose (M-018 — after the zz-zz-
 * specs): this spec writes users, agents, grants and a campaign into the
 * shared seeded database, and it BACKDATES its own grant row, so it must
 * run after every spec that asserts global state.
 */
import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { execFileSync } from "node:child_process";
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
/** the suite's scratch database — the same coordinates global-setup uses */
const PG = process.env.E2E_PG ?? "postgres://regulait:regulait@localhost:5432";
const DB = process.env.E2E_DB ?? "regulait_wt_spa";

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

test("unused + orphaned grants render with evidence, and the campaign opened from them matches the flagged set", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // --- seed via the bootstrap API ------------------------------------------
  const holderRes = await page.request.post("/v1/users", {
    headers: BOOT,
    data: { email: "zz-rec-holder@example.com", displayName: "zz rec holder" },
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
  const agentUnused = await mkAgent("zz-rec-agent-unused");
  const agentOrphan = await mkAgent("zz-rec-agent-orphan");

  const grant = async (agentId: string) => {
    const g = await page.request.post("/v1/grants/agents", { headers: BOOT, data: { userId: holderId, agentId } });
    expect(g.status()).toBe(201);
    return (await g.json()).id as string;
  };
  const grantUnusedId = await grant(agentUnused);
  await grant(agentOrphan);

  // the UNUSED grant: 120 days old in the ledger, zero governed use. Every
  // other grant in this suite's database was created minutes ago, so this is
  // the only grant old enough for the 90-day rule to judge.
  execFileSync("psql", [
    `${PG}/${DB}`,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `UPDATE agent_grants SET created_at = now() - interval '120 days' WHERE id = '${grantUnusedId}'`,
  ]);

  // the ORPHANED grant: owner recorded, then deactivated (the ADR-0022 state)
  const ownerRes = await page.request.post("/v1/users", {
    headers: BOOT,
    data: { email: "zz-rec-owner@example.com", displayName: "zz rec owner" },
  });
  expect(ownerRes.status()).toBe(201);
  const ownerId = (await ownerRes.json()).id as string;
  const setOwner = await page.request.post(`/v1/agents/${agentOrphan}/owner`, {
    headers: BOOT,
    data: { ownerUserId: ownerId },
  });
  expect(setOwner.status()).toBe(200);
  const deact = await page.request.post(`/v1/users/${ownerId}/deactivate`, { headers: BOOT, data: {} });
  expect(deact.status()).toBe(200);

  // --- the recommendations page renders both, evidence visible -------------
  await page.goto("/ui/admin/recommendations");
  await expect(page.getByRole("heading", { name: "Access recommendations" })).toBeVisible();

  const unusedCard = page.locator("section").filter({ hasText: /^unused-grant — / });
  await expect(unusedCard.getByText("review-suggested")).toBeVisible();
  const unusedRow = unusedCard.getByRole("row", { name: /zz-rec-agent-unused/ });
  await expect(unusedRow).toBeVisible();
  // the rendered rationale + hand-checkable evidence
  await expect(unusedRow.getByText(/granted 120 days ago/)).toBeVisible();
  await expect(unusedRow.getByText(/governedCallsInWindow: 0/)).toBeVisible();

  const orphanCard = page.locator("section").filter({ hasText: /^orphaned-agent-grants — / });
  const orphanRow = orphanCard.getByRole("row", { name: /zz-rec-agent-orphan/ }).first();
  await expect(orphanRow).toBeVisible();
  await expect(orphanRow.getByText(/deactivated/).first()).toBeVisible();

  // --- one click: open the certification campaign from the unused rule -----
  await unusedCard.getByRole("button", { name: "Open certification campaign from these" }).click();
  await expect(page.getByText("campaign opened", { exact: true })).toBeVisible();

  // --- the campaign's items MATCH the flagged set, per the gateway itself --
  const recRes = await page.request.get("/v1/recommendations/access", { headers: BOOT });
  expect(recRes.status()).toBe(200);
  const rec = (await recRes.json()) as {
    rules: Array<{ id: string; findings: Array<{ grantKind: string; grantId: string }> }>;
  };
  const flagged = rec.rules
    .find((r) => r.id === "unused-grant")!
    .findings.map((f) => `${f.grantKind}:${f.grantId}`)
    .sort();
  expect(flagged).toContain(`agent:${grantUnusedId}`);

  const listRes = await page.request.get("/v1/certification-campaigns", { headers: BOOT });
  expect(listRes.status()).toBe(200);
  const campaign = ((await listRes.json()).campaigns as Array<{ id: string; name: string }>).find(
    (c) => c.name === "recommendations: unused-grant",
  );
  expect(campaign, "the one-click campaign must exist").toBeTruthy();
  const detailRes = await page.request.get(`/v1/certification-campaigns/${campaign!.id}`, { headers: BOOT });
  expect(detailRes.status()).toBe(200);
  const items = (await detailRes.json()).items as Array<{ grantKind: string; grantId: string }>;
  expect(items.map((i) => `${i.grantKind}:${i.grantId}`).sort()).toEqual(flagged);

  // --- posture carries the recommendations line ----------------------------
  await page.goto("/ui/admin/posture");
  const postureCard = page.locator("section").filter({ hasText: /^Access recommendations/ });
  await expect(postureCard.getByText(/finding\(s\) across the v1 rules/)).toBeVisible();
});
