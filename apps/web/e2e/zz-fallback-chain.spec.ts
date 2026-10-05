/**
 * ADR-0066 fallback chains reach the admin console. The API shipped without a
 * page, so the ordering that decides what runs when a provider is down lived
 * nowhere an admin could read. This drives the card end-to-end in the real SPA:
 * select a primary, add two fallbacks, reorder, remove — and confirm the
 * gateway's own refusal surfaces verbatim rather than being re-implemented in
 * the form.
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

/** the password every admin spec in this suite settles on */
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";

const BOOT = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };


/**
 * Order-independent sign-in, copied from the phase4-7 / brand-contract specs.
 * The suite shares ONE seeded database, so the seeded one-time password is
 * consumed by whichever spec runs first — a spec that only knows the one-time
 * password passes alone and fails in the suite. Trying the candidates in turn
 * and settling on the SHARED password keeps every spec runnable in any order.
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
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

test("an admin builds, reorders and prunes a fallback chain", async ({ page }) => {
  // three agents to chain: one primary, two targets
  const made: Array<{ id: string; name: string }> = [];
  for (const name of ["fb-primary", "fb-second", "fb-third"]) {
    const r = await fetch(`${state.baseUrl}/v1/agents`, {
      method: "POST",
      headers: BOOT,
      body: JSON.stringify({ name, provider: "mock", tier: 1, model: `mock-${name}` }),
    });
    expect(r.status).toBe(201);
    made.push({ id: (await r.json()).id, name });
  }

  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/agents");
  const card = page.locator("section", { hasText: "Fallback chain (ADR-0066)" }).first();
  await expect(card).toBeVisible();

  // empty state says what no-chain MEANS, not just that it is empty.
  // Select by VALUE (the agent id) — the repo's e2e idiom, and label text
  // carries provider/tier decoration that a name match would be brittle to.
  const idOf = (n: string) => made.find((m) => m.name === n)!.id;
  await card.getByLabel("Primary agent").selectOption(idOf("fb-primary"));
  await expect(card.getByText(/fails honestly rather than silently routing/)).toBeVisible();

  // add two, in order
  for (const name of ["fb-second", "fb-third"]) {
    await card.getByLabel(/Add a fallback/).selectOption(idOf(name));
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await expect(card.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  }
  let items = card.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("fb-second");

  // reorder: third becomes first
  await items.nth(1).getByRole("button", { name: "Move fb-third up" }).click();
  await expect(card.getByRole("listitem").first()).toContainText("fb-third");

  // ADR-0179 (UX-AG-1): every edit above is a DRAFT — nothing is in force yet
  const primary = made.find((m) => m.name === "fb-primary")!;
  const serverChain = async () => {
    const readBack = await fetch(`${state.baseUrl}/v1/agents/${primary.id}/fallbacks`, { headers: BOOT });
    return ((await readBack.json()).fallbacks as Array<{ name: string }>).map((c) => c.name);
  };
  await expect(card.getByText("Unsaved changes")).toBeVisible();
  expect(await serverChain()).toEqual([]);

  // and Save chain persists the order server-side, not just in local state
  await card.getByRole("button", { name: "Save chain" }).click();
  await expect(card.getByText("Saved — this is the chain in force.")).toBeVisible();
  expect(await serverChain()).toEqual(["fb-third", "fb-second"]);

  // remove one, then save it
  await card.getByRole("button", { name: "Remove fb-third from the chain" }).click();
  await expect(card.getByRole("listitem")).toHaveCount(1);
  await card.getByRole("button", { name: "Save chain" }).click();
  await expect(card.getByText("Saved — this is the chain in force.")).toBeVisible();
  expect(await serverChain()).toEqual(["fb-second"]);
});
